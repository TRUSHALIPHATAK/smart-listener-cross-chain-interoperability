#Requires -Version 5.1
# Smart Listener - one-command local launcher (Windows PowerShell 5.1+)
# ASCII only, no command chaining operators, no nested quotes.

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

$script:jobs = @()
$q = [char]34

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Magenta
}

function Write-Ok([string]$Message) {
    Write-Host "    OK    $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
    Write-Host "    NOTE  $Message" -ForegroundColor Yellow
}

function Write-Fail([string]$Message) {
    Write-Host "    FAIL  $Message" -ForegroundColor Red
}

function Test-PortOpen([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect("127.0.0.1", $Port)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

function Wait-Port([int]$Port, [int]$TimeoutSec, [string]$Label) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortOpen $Port) {
            Write-Ok "$Label is listening on port $Port"
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "$Label did not open port $Port within $TimeoutSec seconds"
}

function Wait-HttpOk([string]$Url, [int]$TimeoutSec) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) {
                Write-Ok "Health check passed: $Url"
                return
            }
        }
        catch {
            Start-Sleep -Milliseconds 700
        }
    }
    throw "Timed out waiting for $Url"
}

function Start-LoggedJob {
    param(
        [string]$Name,
        [string]$WorkingDirectory,
        [string]$CmdLine,
        [hashtable]$EnvVars = @{}
    )

    Write-Step "Starting $Name"

    $logDir = Join-Path $Root "logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null

    $stdout = Join-Path $logDir ($Name + ".out.log")
    $stderr = Join-Path $logDir ($Name + ".err.log")

    # cmd.exe is used so Windows npx.cmd works; output goes to log files.
    $fullCommand = $CmdLine + " 1> " + $q + $stdout + $q + " 2> " + $q + $stderr + $q
    $cmdArgs = "/d /s /c " + $q + $fullCommand + $q

    # Per-process environment (e.g. LISTENER_ID) - the child inherits it.
    $previous = @{}
    foreach ($key in $EnvVars.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
        [Environment]::SetEnvironmentVariable($key, [string]$EnvVars[$key], "Process")
    }

    try {
        $process = Start-Process -FilePath $env:ComSpec `
            -ArgumentList $cmdArgs `
            -WorkingDirectory $WorkingDirectory `
            -PassThru `
            -WindowStyle Hidden
    }
    finally {
        foreach ($key in $EnvVars.Keys) {
            [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
        }
    }

    $script:jobs += [pscustomobject]@{
        Name    = $Name
        Process = $process
        Out     = $stdout
        Err     = $stderr
    }

    Write-Ok "$Name launched (PID $($process.Id))"
}

function Stop-AllJobs {
    foreach ($job in $script:jobs) {
        try {
            # /T kills the whole process tree (cmd -> npx -> node) so ports are freed.
            & cmd.exe /c "taskkill /PID $($job.Process.Id) /T /F >nul 2>&1"
            Write-Host "Stopped $($job.Name)"
        }
        catch {
            # keep stopping the others
        }
    }
}

try {
    Write-Step "Preflight checks"

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw "Node.js is not installed or not on PATH."
    }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw "npm is not installed or not on PATH."
    }
    Write-Ok "Node $(node -v) / npm $(npm -v)"

    foreach ($port in @(8545, 3001, 5173)) {
        if (Test-PortOpen $port) {
            throw "Port $port is already in use. A previous run is still alive. Run: taskkill /IM node.exe /F   then start again."
        }
    }
    Write-Ok "Ports 8545, 3001, 5173 are free"

    if (-not (Test-Path (Join-Path $Root "node_modules"))) {
        Write-Step "Installing dependencies"
        npm install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed."
        }
    }

    # .env: create if missing, then make sure the 4-listener settings are correct.
    $envFile = Join-Path $Root ".env"
    $envExample = Join-Path $Root ".env.example"

    if ((-not (Test-Path $envFile)) -and (Test-Path $envExample)) {
        Copy-Item $envExample $envFile
        Write-Ok "Created .env from .env.example"
    }

    if (Test-Path $envFile) {
        $original = [System.IO.File]::ReadAllText($envFile)
        $text = $original
        $text = [regex]::Replace($text, '(?m)^[ \t]*REQUIRED_VOTES[ \t]*=[^\r\n]*', 'REQUIRED_VOTES=3')
        $text = [regex]::Replace($text, '(?m)^[ \t]*TOTAL_LISTENERS[ \t]*=[^\r\n]*', 'TOTAL_LISTENERS=4')
        $text = [regex]::Replace($text, '(?m)^[ \t]*API_HOST[ \t]*=[^\r\n]*', 'API_HOST=127.0.0.1')
        if ($text -ne $original) {
            $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
            [System.IO.File]::WriteAllText($envFile, $text, $utf8NoBom)
            Write-Warn "Updated .env: REQUIRED_VOTES=3, TOTAL_LISTENERS=4, API_HOST=127.0.0.1"
        }
    }

    # 1. Blockchain node
    Start-LoggedJob "hardhat-node" $Root "npx hardhat node"
    Wait-Port 8545 90 "Hardhat node"

    # 2. Deploy contracts
    Write-Step "Deploying contracts"
    npx hardhat run scripts/deploy.ts --network localhost
    if ($LASTEXITCODE -ne 0) {
        throw "Contract deployment failed."
    }
    Write-Ok "Contracts deployed"

    # 3. API
    $listenerDir = Join-Path $Root "listener"
    Start-LoggedJob "api" $listenerDir "npx ts-node src/apiServer.ts"
    Wait-HttpOk "http://127.0.0.1:3001/api/health" 90

    # 4. Four listeners (ID passed through the environment, not the command line)
    foreach ($id in @("A", "B", "C", "D")) {
        Start-LoggedJob ("listener-" + $id) $listenerDir "npx ts-node src/listenerProcess.ts" @{ LISTENER_ID = $id }
    }
    Start-Sleep -Seconds 4

    # 5. Dashboard
    $dashboardDir = Join-Path $Root "dashboard"
    Start-LoggedJob "dashboard" $dashboardDir "npx vite --host 127.0.0.1 --port 5173"
    Wait-Port 5173 60 "Dashboard"

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Magenta
    Write-Host " Smart Listener demo stack is running" -ForegroundColor Magenta
    Write-Host "============================================" -ForegroundColor Magenta
    Write-Host "Dashboard:   http://127.0.0.1:5173"
    Write-Host "API health:  http://127.0.0.1:3001/api/health"
    Write-Host "Hardhat RPC: http://127.0.0.1:8545"
    Write-Host "Logs:        $Root\logs"
    Write-Host ""
    Write-Host "Send a test tx in another window:  npm run demo:send"
    Write-Host "Press Ctrl+C here to stop everything."

    while ($true) {
        foreach ($job in $script:jobs) {
            if ($job.Process.HasExited) {
                Write-Fail "$($job.Name) exited with code $($job.Process.ExitCode)"
                if (Test-Path $job.Err) { Get-Content $job.Err -Tail 20 }
                if (Test-Path $job.Out) { Get-Content $job.Out -Tail 10 }
                throw "$($job.Name) stopped unexpectedly."
            }
        }
        Start-Sleep -Seconds 2
    }
}
catch {
    Write-Fail $_.Exception.Message
    Write-Host "Check the logs folder for details."
    exit 1
}
finally {
    Stop-AllJobs
}