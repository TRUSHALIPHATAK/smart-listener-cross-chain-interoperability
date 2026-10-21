#Requires -Version 5.1
# Smart Listener - one-command local launcher (Windows PowerShell 5.1+)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

$script:jobs = @()
$script:stopping = $false

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

function Get-ProjectCommand([string]$RelativePath, [string]$Label) {
    $command = Join-Path $Root $RelativePath
    if (-not (Test-Path $command)) {
        throw "$Label is missing at $command. Run npm install first."
    }
    return $command
}

function Get-EnvFileValue([string]$Name, [string]$Fallback) {
    $envFile = Join-Path $Root ".env"
    if (-not (Test-Path $envFile)) {
        return $Fallback
    }
    $line = Get-Content $envFile | Where-Object {
        $_ -match "^[\s]*$([regex]::Escape($Name))[\s]*="
    } | Select-Object -Last 1
    if (-not $line) {
        return $Fallback
    }
    return (($line -split "=", 2)[1]).Trim().Trim('"')
}

function Get-ListeningPortOwner([int]$Port) {
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    foreach ($connection in $connections) {
        $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue
        [pscustomobject]@{
            Port = $Port
            PID = $connection.OwningProcess
            Process = if ($process) { $process.ProcessName } else { "unknown" }
        }
    }
}

function Assert-PortsFree([int[]]$Ports) {
    $occupied = @()
    foreach ($port in $Ports) {
        $occupied += @(Get-ListeningPortOwner $port)
    }
    if ($occupied.Count -gt 0) {
        $details = ($occupied | ForEach-Object {
            "port $($_.Port) is occupied by $($_.Process) (PID $($_.PID))"
        }) -join "; "
        throw "Required port(s) are already in use: $details. Stop that specific process or choose another port."
    }
    Write-Ok ("Ports {0} are free" -f ($Ports -join ", "))
}

function Get-ListenerProcessIds {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match "listenerProcess\.ts" -and
        $_.CommandLine -match [regex]::Escape($Root)
    })
    return $processes | Select-Object -ExpandProperty ProcessId
}

function Assert-NoDuplicateListeners {
    $ids = @(Get-ListenerProcessIds)
    if ($ids.Count -gt 0) {
        throw "Listener processes are already running (PID(s): $($ids -join ', ')). Stop those specific processes before starting the launcher again."
    }
}

function Test-ProcessAlive($Job) {
    if ($Job.Process.HasExited) {
        $errorTail = if (Test-Path $Job.Err) { (Get-Content $Job.Err -Tail 20) -join [Environment]::NewLine } else { "" }
        $outputTail = if (Test-Path $Job.Out) { (Get-Content $Job.Out -Tail 20) -join [Environment]::NewLine } else { "" }
        $diagnostic = @($errorTail, $outputTail) | Where-Object { $_ } | Out-String
        throw "$($Job.Name) exited with code $($Job.Process.ExitCode).`n$diagnostic"
    }
}

function Start-LoggedProcess {
    param(
        [string]$Name,
        [string]$WorkingDirectory,
        [string]$FilePath,
        [string[]]$Arguments,
        [hashtable]$EnvVars = @{}
    )

    Write-Step "Starting $Name"
    $logDir = Join-Path $Root "logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $stdout = Join-Path $logDir ($Name + ".out.log")
    $stderr = Join-Path $logDir ($Name + ".err.log")

    if (Test-Path $stdout) { Clear-Content $stdout }
    if (Test-Path $stderr) { Clear-Content $stderr }

    $previous = @{}
    foreach ($key in $EnvVars.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
        [Environment]::SetEnvironmentVariable($key, [string]$EnvVars[$key], "Process")
    }

    try {
        $process = Start-Process -FilePath $FilePath `
            -ArgumentList $Arguments `
            -WorkingDirectory $WorkingDirectory `
            -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr `
            -PassThru `
            -WindowStyle Hidden
    }
    finally {
        foreach ($key in $EnvVars.Keys) {
            [Environment]::SetEnvironmentVariable($key, $previous[$key], "Process")
        }
    }

    $job = [pscustomobject]@{
        Name = $Name
        Process = $process
        Out = $stdout
        Err = $stderr
    }
    $script:jobs += $job
    Write-Ok "$Name started (PID $($process.Id)); logs: $stdout and $stderr"
    return $job
}

function Wait-JsonRpc([string]$Url, [int]$ExpectedChainId, [int]$TimeoutSec, [string]$Label, $Job) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $body = '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
    while ((Get-Date) -lt $deadline) {
        Test-ProcessAlive $Job
        try {
            $response = Invoke-RestMethod -Uri $Url -Method Post -ContentType "application/json" -Body $body -TimeoutSec 3
            $chainId = [Convert]::ToInt32($response.result.Substring(2), 16)
            if ($chainId -eq $ExpectedChainId) {
                Write-Ok "$Label JSON-RPC is ready at $Url (chain ID $chainId)"
                return
            }
            throw "returned unexpected chain ID $chainId"
        }
        catch {
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 500
        }
    }
    throw "$Label did not become ready within $TimeoutSec seconds. Last error: $lastError"
}

function Wait-HttpOk([string]$Url, [int]$TimeoutSec, [string]$Label, $Job) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Test-ProcessAlive $Job
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) {
                Write-Ok "$Label is ready at $Url"
                return
            }
        }
        catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 500
    }
    throw "$Label did not become ready within $TimeoutSec seconds. Last error: $lastError"
}

function Wait-Listeners([string]$Url, [string[]]$ExpectedIds, [int]$TimeoutSec, $Jobs) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        foreach ($job in $Jobs) { Test-ProcessAlive $job }
        try {
            $data = Invoke-RestMethod -Uri $Url -UseBasicParsing -TimeoutSec 3
            $recent = @{}
            foreach ($listener in @($data.listeners)) {
                if (([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$listener.lastSeenAt) -lt 30000) {
                    $recent[$listener.listenerId] = $listener
                }

            }
            $missing = @($ExpectedIds | Where-Object { -not $recent.ContainsKey($_) })
            if ($missing.Count -eq 0) {
                $status = ($ExpectedIds | ForEach-Object {
                    "$_ connected=$($recent[$_].sourceChainConnected)"
                }) -join ", "
                Write-Ok "Listener heartbeats received: $status"
                return
            }
            $lastError = "waiting for listener(s): $($missing -join ', ')"
        }
        catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Listeners did not register within $TimeoutSec seconds. Last error: $lastError"
}

function Get-RpcAccounts([string]$Url) {
    $body = '{"jsonrpc":"2.0","id":1,"method":"eth_accounts","params":[]}'
    try {
        $response = Invoke-RestMethod -Uri $Url -Method Post -ContentType "application/json" -Body $body -TimeoutSec 3
        return @($response.result)
    } catch {
        return @()
    }
}

function Get-DescendantProcessIds([int]$RootPid) {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $ids = New-Object System.Collections.Generic.List[int]
    $queue = New-Object System.Collections.Generic.Queue[int]
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($child in @($all | Where-Object { $_.ParentProcessId -eq $parent })) {
            if (-not $ids.Contains([int]$child.ProcessId)) {
                $ids.Add([int]$child.ProcessId)
                $queue.Enqueue([int]$child.ProcessId)
            }
        }
    }
    return $ids
}

function Stop-ProcessTree([int]$RootPid) {
    $descendants = @(Get-DescendantProcessIds $RootPid)
    [array]::Reverse($descendants)
    foreach ($childPid in $descendants) {
        Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $RootPid -Force -ErrorAction SilentlyContinue
}

function Stop-AllJobs {
    if ($script:stopping) { return }
    $script:stopping = $true
    foreach ($job in @($script:jobs | Sort-Object -Property Name -Descending)) {
        if ($job.Process -and -not $job.Process.HasExited) {
            Stop-ProcessTree $job.Process.Id
            Write-Host "Stopped $($job.Name)"
        }
    }
}

try {
    Write-Step "Preflight checks"
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is not installed or not on PATH." }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is not installed or not on PATH." }
    Write-Ok "Node $(node -v) / npm $(npm -v)"

    if (-not (Test-Path (Join-Path $Root "node_modules"))) {
        throw "Dependencies are missing. Run npm install before npm run dev."
    }
    $hardhat = Get-ProjectCommand "node_modules\.bin\hardhat.cmd" "Hardhat"
    $tsNode = Get-ProjectCommand "node_modules\.bin\ts-node.cmd" "listener ts-node"
    $vite = Get-ProjectCommand "node_modules\.bin\vite.cmd" "dashboard Vite"
    $destinationType = Get-EnvFileValue "DESTINATION_TYPE" "evm"
    $ports = @(8545, 3001, 5173)
    if ($destinationType -eq "evm") { $ports += 8546 }
    Assert-PortsFree $ports
    Assert-NoDuplicateListeners

    $envFile = Join-Path $Root ".env"
    if (-not (Test-Path $envFile) -and (Test-Path (Join-Path $Root ".env.example"))) {
        Copy-Item (Join-Path $Root ".env.example") $envFile
        Write-Ok "Created .env from .env.example"
        $destinationType = Get-EnvFileValue "DESTINATION_TYPE" "evm"
    }

    $sourceJob = Start-LoggedProcess "hardhat-source" $Root $hardhat @("node")
    Wait-JsonRpc "http://127.0.0.1:8545" 31337 90 "Source chain" $sourceJob

    $destinationJob = $null
    if ($destinationType -eq "evm") {
        $destinationJob = Start-LoggedProcess "hardhat-dest" $Root $hardhat @("node", "--port", "8546") @{ HARDHAT_CHAIN_ID = "31338" }
        Wait-JsonRpc "http://127.0.0.1:8546" 31338 90 "Destination chain" $destinationJob
    } else {
        Write-Warn "DESTINATION_TYPE=$destinationType; destination Hardhat chain is not required."
    }

    Write-Step "Deploying source contracts"
    & $hardhat run (Join-Path $Root "scripts\deploy.ts") --network localhost
    if ($LASTEXITCODE -ne 0) { throw "Source contract deployment failed with exit code $LASTEXITCODE." }

    if ($destinationType -eq "evm") {
        Write-Step "Deploying destination contracts"
        & $hardhat run (Join-Path $Root "scripts\deployDestination.ts") --network destination
        if ($LASTEXITCODE -ne 0) { throw "Destination contract deployment failed with exit code $LASTEXITCODE." }
    }

    $deploymentFile = Join-Path $Root "listener\config\deployment.json"
    if (-not (Test-Path $deploymentFile)) { throw "Deployment completed without creating $deploymentFile." }
    $deployment = Get-Content $deploymentFile -Raw | ConvertFrom-Json
    if (-not $deployment.contracts.SenderContract) { throw "Deployment did not produce SenderContract address." }
    Write-Ok "Contracts configured: SenderContract=$($deployment.contracts.SenderContract)"
    if ($deployment.contracts.DestinationReceiver) {
        Write-Ok "DestinationReceiver=$($deployment.contracts.DestinationReceiver)"
    }

    $listenerDir = Join-Path $Root "listener"
    $apiJob = Start-LoggedProcess "api" $listenerDir $tsNode @("src\apiServer.ts")
    Wait-HttpOk "http://127.0.0.1:3001/api/health" 90 "API" $apiJob

    $listenerJobs = @()
    foreach ($id in @("A", "B", "C", "D")) {
        $listenerJobs += Start-LoggedProcess ("listener-" + $id) $listenerDir $tsNode @("src\listenerProcess.ts") @{ LISTENER_ID = $id }
    }
    Wait-Listeners "http://127.0.0.1:3001/api/listeners" @("A", "B", "C", "D") 90 $listenerJobs
    Wait-HttpOk "http://127.0.0.1:3001/api/ready" 30 "Listener/API readiness" $apiJob

    $dashboardDir = Join-Path $Root "dashboard"
    $dashboardJob = Start-LoggedProcess "dashboard" $dashboardDir $vite @("--host", "127.0.0.1", "--port", "5173")
    Wait-HttpOk "http://127.0.0.1:5173" 60 "Dashboard" $dashboardJob

    Write-Host ""
    Write-Host "============================================" -ForegroundColor Magenta
    Write-Host " Smart Listener demo stack is running" -ForegroundColor Magenta
    Write-Host "============================================" -ForegroundColor Magenta
    Write-Host "Dashboard:   http://127.0.0.1:5173"
    Write-Host "API health:  http://127.0.0.1:3001/api/health"
    Write-Host "Listeners:   http://127.0.0.1:3001/api/listeners"
    Write-Host "Source RPC:  http://127.0.0.1:8545"
    if ($destinationType -eq "evm") { Write-Host "Dest RPC:    http://127.0.0.1:8546" }
    $requiredVotes = Get-EnvFileValue "REQUIRED_VOTES" "3"
    $totalListeners = Get-EnvFileValue "TOTAL_LISTENERS" "4"
    Write-Host "Consensus:   $requiredVotes-of-$totalListeners"
    Write-Host "Contracts:    Sender=$($deployment.contracts.SenderContract)"
    if ($deployment.contracts.DestinationReceiver) { Write-Host "              DestinationReceiver=$($deployment.contracts.DestinationReceiver)" }
    $accounts = @(Get-RpcAccounts "http://127.0.0.1:8545")
    if ($accounts.Count -gt 0) {
        Write-Host "Local accounts (development only):"
        foreach ($account in $accounts | Select-Object -First 5) { Write-Host "  $account" }
    }
    Write-Host "Logs:        $Root\logs"
    Write-Host ""
    Write-Host "Send a test tx in another window: npm run demo:send"
    Write-Host "Press Ctrl+C here to stop everything."

    while ($true) {
        foreach ($job in @($script:jobs)) { Test-ProcessAlive $job }
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
