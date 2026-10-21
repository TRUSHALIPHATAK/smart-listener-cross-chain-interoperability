# Smart Listener local environment diagnostics.
[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$failures = 0

function Check([string]$Name, [bool]$Pass, [string]$Detail, [string]$Severity = "FAIL") {
    if ($Pass) {
        Write-Host ("PASS {0}: {1}" -f $Name, $Detail) -ForegroundColor Green
    } elseif ($Severity -eq "WARN") {
        Write-Host ("WARN {0}: {1}" -f $Name, $Detail) -ForegroundColor Yellow
    } else {
        Write-Host ("FAIL {0}: {1}" -f $Name, $Detail) -ForegroundColor Red
        $script:failures++
    }
}

function Invoke-Rpc([string]$Url, [string]$Method) {
    $body = @{ jsonrpc = "2.0"; id = 1; method = $Method; params = @() } | ConvertTo-Json -Compress
    return Invoke-RestMethod -Uri $Url -Method Post -ContentType "application/json" -Body $body -TimeoutSec 5
}

Check "Node.js" ([bool](Get-Command node -ErrorAction SilentlyContinue)) "Node is on PATH"
Check "npm" ([bool](Get-Command npm -ErrorAction SilentlyContinue)) "npm is on PATH"
if (Get-Command node -ErrorAction SilentlyContinue) { Check "Node version" (([version](node -v).TrimStart("v")).Major -ge 18) (node -v) }
if (Get-Command npm -ErrorAction SilentlyContinue) { Check "npm version" (([version](npm -v)).Major -ge 9) (npm -v) }

Check "Root dependencies" (Test-Path (Join-Path $Root "node_modules\.bin\hardhat.cmd")) "node_modules installed"
Check "Listener dependencies" (Test-Path (Join-Path $Root "node_modules\sql.js")) "listener workspace dependencies installed"
Check "Dashboard dependencies" (Test-Path (Join-Path $Root "node_modules\vite")) "dashboard workspace dependencies installed"

$envFile = Join-Path $Root ".env"
Check ".env" (Test-Path $envFile) "local configuration file exists" "WARN"
if (Test-Path $envFile) {
    $envText = Get-Content $envFile -Raw
    Check "Consensus configuration" ($envText -match "REQUIRED_VOTES=3" -and $envText -match "TOTAL_LISTENERS=4") "configured for 3-of-4 local quorum"
    Check "Local source mode" ($envText -match "SOURCE_CHAIN_ID=31337") "source chain ID is 31337" "WARN"
}

foreach ($port in @(8545, 8546, 3001, 5173)) {
    $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    Check ("Port {0}" -f $port) ($null -ne $listener) ($(if ($listener) { "listening" } else { "not listening (run npm run dev)" })) "WARN"
}

$rpcChecks = @(
    @{ Name = "Source RPC"; Url = "http://127.0.0.1:8545"; Chain = 31337 },
    @{ Name = "Destination RPC"; Url = "http://127.0.0.1:8546"; Chain = 31338 }
)
foreach ($rpc in $rpcChecks) {
    try {
        $response = Invoke-Rpc $rpc.Url "eth_chainId"
        $chain = [Convert]::ToInt32($response.result.Substring(2), 16)
        Check $rpc.Name ($chain -eq $rpc.Chain) ("chain ID {0}, expected {1}" -f $chain, $rpc.Chain)
    } catch {
        Check $rpc.Name $false $_.Exception.Message "WARN"
    }
}

$deploymentPath = Join-Path $Root "listener\config\deployment.json"
if (Test-Path $deploymentPath) {
    try {
        $deployment = Get-Content $deploymentPath -Raw | ConvertFrom-Json
        Check "Deployment manifest" ([bool]$deployment.contracts.SenderContract) "SenderContract is configured"
        Check "Destination manifest" ([bool]$deployment.contracts.DestinationReceiver) "DestinationReceiver is configured"
    } catch {
        Check "Deployment manifest" $false $_.Exception.Message
    }
} else {
    Check "Deployment manifest" $false "run npm run dev to deploy local contracts" "WARN"
}

foreach ($endpoint in @(
    @{ Name = "API health"; Url = "http://127.0.0.1:3001/api/health" },
    @{ Name = "API readiness"; Url = "http://127.0.0.1:3001/api/ready" },
    @{ Name = "Dashboard"; Url = "http://127.0.0.1:5173" }
)) {
    try {
        $response = Invoke-WebRequest -Uri $endpoint.Url -UseBasicParsing -TimeoutSec 5
        Check $endpoint.Name ($response.StatusCode -eq 200) ("HTTP {0}" -f $response.StatusCode) "WARN"
    } catch {
        Check $endpoint.Name $false $_.Exception.Message "WARN"
    }
}

if (Test-Path (Join-Path $Root "dashboard\dist\index.html")) {
    Check "Dashboard build" $true "dashboard/dist/index.html exists"
} else {
    Check "Dashboard build" $false "run npm --workspace dashboard run build" "WARN"
}

if ($failures -gt 0) {
    Write-Host ("Doctor found {0} critical failure(s)." -f $failures) -ForegroundColor Red
    exit 1
}
Write-Host "Doctor checks completed without critical failures." -ForegroundColor Green
exit 0
