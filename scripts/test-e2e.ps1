[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$base = "http://127.0.0.1:3001"
$payload = "e2e-" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$body = @{
    destinationChainId = "simulated-evm-chain"
    destinationAddress = "0xRecipientAddress"
    payload = $payload
    transferMode = "MESSAGE_ONLY"
    amountEth = "0"
} | ConvertTo-Json

$submission = Invoke-RestMethod -Uri "$base/api/transactions/submit" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 10
if (-not $submission.txId) { throw "Submission did not return a transaction ID." }

$deadline = (Get-Date).AddSeconds(90)
do {
    Start-Sleep -Seconds 2
    $transaction = Invoke-RestMethod -Uri "$base/api/transactions/$($submission.txId)" -TimeoutSec 10
    Write-Host ("{0}: {1} approvals, {2} rejects" -f $transaction.status, $transaction.approveVotes, $transaction.rejectVotes)
    if ($transaction.status -in @("EXECUTED", "FAILED", "REJECTED", "TIMED_OUT", "ROLLED_BACK")) { break }
} while ((Get-Date) -lt $deadline)

if ($transaction.status -ne "EXECUTED") {
    throw "E2E transaction ended in $($transaction.status): $($transaction.errorMessage)"
}
if (-not $transaction.sourceTransactionHash -or -not $transaction.destTxHash) {
    throw "Executed transaction is missing source or destination transaction hashes."
}
if ($transaction.approveVotes -lt 3) {
    throw "Transaction executed without the configured 3-of-4 approval count."
}
Write-Host "E2E PASS: source and destination transactions were confirmed through the real listener path." -ForegroundColor Green
