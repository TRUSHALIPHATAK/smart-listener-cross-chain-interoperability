#Requires -Version 5.1
<#
.SYNOPSIS
  Starts the Smart Listener local demo stack on Windows PowerShell.

.DESCRIPTION
  Launches Hardhat node, deploys contracts, API server, three listeners (A/B/C),
  and the Vite dashboard. Errors are printed clearly. Press Ctrl+C to stop all.

.NOTES
  Does not require Docker, Ubuntu, or Visual Studio C++ build tools.
  Storage uses sql.js (pure WASM SQLite).
#>

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location $Root

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Magenta
}

function Write-Ok([string]$Message) {
  Write-Host "    OK  $Message" -ForegroundColor DarkMagenta
}

function Write-Fail([string]$Message) {
  Write-Host "    FAIL  $Message" -ForegroundColor DarkRed
}

function Test-PortOpen([int]$Port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect("127.0.0.1", $Port)
    $c.Close()
    return $true
  } catch {
    return $false
  }
}

function Wait-Port([int]$Port, [int]$TimeoutSec = 60, [string]$Label = "service") {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortOpen $Port) {
      Write-Ok "$Label is listening on port $Port"
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw "$Label did not open port $Port within ${TimeoutSec}s"
}

function Wait-HttpOk([string]$Url, [int]$TimeoutSec = 45) {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) {
        Write-Ok "HTTP $Url → 200"
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  throw "Timed out waiting for $Url"
}

$jobs = @()

function Start-LoggedJob([string]$Name, [string]$WorkingDirectory, [string]$CmdLine) {
  Write-Step "Starting $Name"
  $logDir = Join-Path $Root "logs"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $stdout = Join-Path $logDir "$Name.out.log"
  $stderr = Join-Path $logDir "$Name.err.log"

  # Use cmd.exe so npx.cmd resolves correctly on Windows
  $p = Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "$CmdLine > `"$stdout`" 2> `"$stderr`"" `
    -WorkingDirectory $WorkingDirectory `
    -PassThru -WindowStyle Hidden

  $script:jobs += [pscustomobject]@{ Name = $Name; Process = $p; Out = $stdout; Err = $stderr }
  Write-Ok "$Name started (PID $($p.Id)) — logs: logs\$Name.*.log"
  return $p
}

function Stop-AllJobs {
  Write-Step "Stopping all services"
  foreach ($j in $jobs) {
    try {
      if ($j.Process -and -not $j.Process.HasExited) {
        Stop-Process -Id $j.Process.Id -Force -ErrorAction SilentlyContinue
        # Also stop child node processes spawned by this window if needed
        Write-Ok "Stopped $($j.Name)"
      }
    } catch {
      Write-Fail "Could not stop $($j.Name): $_"
    }
  }
  # Best-effort: free common ports by stopping node processes that hold them
  foreach ($port in 8545, 3001, 5173) {
    try {
      $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
        Where-Object { $_.State -eq "Listen" }
      foreach ($c in $conns) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    } catch { }
  }
}

# ── Preflight ────────────────────────────────────────────────────────────────

Write-Step "Preflight checks"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Fail "Node.js is not installed or not on PATH"
  exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Fail "npm is not installed or not on PATH"
  exit 1
}
Write-Ok "Node $(node -v) / npm $(npm -v)"

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
  Write-Step "Installing dependencies (npm install)"
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed"; exit 1 }
  Write-Ok "Dependencies installed"
}

# Copy .env.example → .env if missing
$envFile = Join-Path $Root ".env"
$envExample = Join-Path $Root ".env.example"
if (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
  Copy-Item $envExample $envFile
  Write-Ok "Created .env from .env.example"
}

# Stop anything already bound to our ports
foreach ($port in 8545, 3001, 5173) {
  if (Test-PortOpen $port) {
    Write-Host "    Port $port is in use — attempting to free it..." -ForegroundColor DarkMagenta
    try {
      $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
        Where-Object { $_.State -eq "Listen" }
      foreach ($c in $conns) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
      }
    } catch { }
    Start-Sleep -Seconds 1
  }
}

try {
  # ── Hardhat node ───────────────────────────────────────────────────────────
  Start-LoggedJob "hardhat-node" $Root "npx hardhat node"
  Wait-Port 8545 90 "Hardhat node"

  # ── Deploy ─────────────────────────────────────────────────────────────────
  Write-Step "Deploying contracts to localhost"
  npx hardhat run scripts/deploy.ts --network localhost
  if ($LASTEXITCODE -ne 0) { throw "Contract deployment failed (exit $LASTEXITCODE)" }
  Write-Ok "Contracts deployed — see deployments/localhost.json"

  # ── API ────────────────────────────────────────────────────────────────────
  $listenerDir = Join-Path $Root "listener"
  Start-LoggedJob "api" $listenerDir "npx ts-node src/apiServer.ts"
  Wait-HttpOk "http://127.0.0.1:3001/api/health" 60

  # ── Listeners ──────────────────────────────────────────────────────────────
  Start-LoggedJob "listener-A" $listenerDir "set LISTENER_ID=A&& npx ts-node src/listenerProcess.ts"
  Start-LoggedJob "listener-B" $listenerDir "set LISTENER_ID=B&& npx ts-node src/listenerProcess.ts"
  Start-LoggedJob "listener-C" $listenerDir "set LISTENER_ID=C&& npx ts-node src/listenerProcess.ts"
  Start-Sleep -Seconds 3
  Write-Ok "Listeners A/B/C launched (check logs/listener-*.out.log)"

  # ── Dashboard ──────────────────────────────────────────────────────────────
  $dashboardDir = Join-Path $Root "dashboard"
  Start-LoggedJob "dashboard" $dashboardDir "npx vite --host 127.0.0.1 --port 5173"
  Wait-Port 5173 60 "Dashboard"

  Write-Host ""
  Write-Host "========================================================" -ForegroundColor Magenta
  Write-Host "  Smart Listener stack is running" -ForegroundColor Magenta
  Write-Host "========================================================" -ForegroundColor Magenta
  Write-Host "  Dashboard:   http://127.0.0.1:5173"
  Write-Host "  API health:  http://127.0.0.1:3001/api/health"
  Write-Host "  Hardhat RPC: http://127.0.0.1:8545"
  Write-Host ""
  Write-Host "  Send a test request (new PowerShell window):"
  Write-Host "    cd $Root"
  Write-Host "    npm run demo:send"
  Write-Host ""
  Write-Host "  Logs: $Root\logs\"
  Write-Host "  Press Ctrl+C to stop all services."
  Write-Host "========================================================" -ForegroundColor Magenta
  Write-Host ""

  # Keep script alive until Ctrl+C; watch for crashed children
  while ($true) {
    foreach ($j in $jobs) {
      if ($j.Process.HasExited) {
        Write-Fail "$($j.Name) exited unexpectedly (code $($j.Process.ExitCode))"
        if (Test-Path $j.Err) {
          Write-Host "---- last lines of $($j.Err) ----" -ForegroundColor DarkRed
          Get-Content $j.Err -Tail 20 -ErrorAction SilentlyContinue
        }
        throw "$($j.Name) crashed — see logs above"
      }
    }
    Start-Sleep -Seconds 2
  }
}
catch {
  Write-Fail $_.Exception.Message
  Stop-AllJobs
  exit 1
}
finally {
  Stop-AllJobs
}
