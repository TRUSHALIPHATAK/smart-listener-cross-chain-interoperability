# Smart Listener Cross-Chain Communication System

A modular prototype of the **Smart Listeners** hybrid-optimistic inter-blockchain communication protocol (inspired by Bigiotti et al., 2025).

Four independent off-chain listeners watch a source-chain contract, cast separate approval/rejection votes, and forward a request only when **at least 3 of 4** (a strict majority) approve. The first working demo uses a **local Hardhat** network and a clearly labelled **[SIMULATED]** destination adapter. A Hyperledger Fabric adapter stub is included for later integration.

> This system does **not** claim cross-chain atomicity or guaranteed rollback. Listener approvals are independent votes, not threshold cryptography.

---

## What is implemented

| Area | Status |
|------|--------|
| `SenderContract.sol` / `ReceiverMock.sol` | Implemented + Hardhat tests |
| Majority (3-of-4) consensus module | Implemented + Jest unit tests |
| EVM source adapter (ethers.js) | Implemented |
| Simulated destination adapter | Implemented |
| Fabric destination adapter | Stub only (`DESTINATION_TYPE=fabric`) |
| Express API + WebSocket push path | Implemented |
| Persistent storage (sql.js SQLite) | Implemented (no Visual Studio / native build) |
| Four listener processes + heartbeats | Implemented |
| React/Vite dashboard (pink theme) | Implemented (live API data) |
| PowerShell one-script launcher | `start-all.ps1` |

---

## Requirements (Windows)

- Node.js 18+ and npm
- Git
- PowerShell 5.1+

**Not required:** Docker, Ubuntu, Visual Studio C++ build tools. Storage uses **sql.js** (WASM SQLite) so native `better-sqlite3` bindings are not needed.

---

## Quick start (recommended)

From the project root in PowerShell:

```powershell
npm install
.\start-all.ps1
```

This starts:

1. Hardhat local node (`http://127.0.0.1:8545`)
2. Contract deployment → `deployments/localhost.json` and `listener/config/deployment.json`
3. API server (`http://127.0.0.1:3001`)
4. Listeners A, B, and C
5. Dashboard (`http://127.0.0.1:5173`)

Service logs are written under `logs\`. Press **Ctrl+C** in the launcher window to stop everything.

### Send a test request

In a **second** PowerShell window (stack already running):

```powershell
cd E:\blockchain\smartlistener
npm run demo:send
```

Then open the dashboard → **Monitor requests** to see votes and `[SIMULATED]` execution. Use **Submit a test request** for explanations only — the UI does not broadcast transactions itself.

### External / app-submitted requests

Any client that can call the configured `SenderContract.sendCrossChainTransaction(...)` on the local network will be detected the same way. Listeners only monitor contracts configured via `listener/config/deployment.json` or `SENDER_CONTRACT_ADDRESS`. Arbitrary contracts are **not** watched automatically.

---

## Manual start (if you prefer separate steps)

```powershell
npm install

# Terminal 1 — chain
npm run node

# Terminal 2 — deploy (once per fresh node)
npm run deploy:local

# Terminal 3 — API
npm run api

# Terminal 4 — four listeners
npm run listeners

# Terminal 5 — dashboard
cd dashboard; npm run dev
```

---

## Configuration

Copy `.env.example` to `.env` (the launcher does this automatically if `.env` is missing).

Important variables:

| Variable | Default | Meaning |
|----------|---------|---------|
| `SOURCE_RPC_URL` | `http://127.0.0.1:8545` | Source chain RPC |
| `REQUIRED_VOTES` | `3` | Approvals needed (must be a strict majority) |
| `TOTAL_LISTENERS` | `4` | Listener count (max 4: A–D) |
| `DESTINATION_TYPE` | `evm` | `evm` (real 2nd chain), `simulated`, or `fabric` (stub) |
| `API_PORT` | `3001` | REST API port |
| `DATABASE_URL` | *(unset)* | If set → PostgreSQL; else sql.js SQLite |
| `SIMULATED_FAILURE_RATE` | `0.05` | Simulated dest failure probability |

Never hardcode private keys. Hardhat’s well-known local accounts are for local demo only.

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Liveness |
| GET | `/api/transactions` | List (`?status=&limit=&offset=`) |
| GET | `/api/transactions/:txId` | Detail + votes |
| GET | `/api/listeners` | Heartbeats + online flag |
| GET | `/api/metrics` | Counts, latency, throughput |
| POST | `/api/transactions/submit` | Submit via SenderContract (local demo key) |

Dashboard Vite proxy forwards `/api` and `/ws` to port 3001.

---

## Tests

```powershell
# Solidity / Hardhat
npm run test:contracts

# Consensus unit tests
cd listener; npm test

# TypeScript builds
cd listener; npm run build
cd ..\dashboard; npm run build
```

Previously confirmed baselines (re-run after changes): Hardhat contract tests, Jest consensus tests, listener `tsc`, dashboard production build.

---

## Project layout

```
contracts/           SenderContract, ReceiverMock
scripts/             deploy + demo send
listener/src/        listeners, consensus, DB, API, adapters
dashboard/src/       React monitor (pink / dark-pink theme)
deployments/         Generated addresses
start-all.ps1        One-command local launcher
```

---

## Transaction flow

1. Caller submits via `SenderContract` → `TransactionSent` event  
2. Each of four listeners validates independently and votes  
3. At ≥3 APPROVE → status `APPROVED` → deciding voter runs executor  
4. `[SIMULATED]` destination adapter returns a fake dest hash (or failure)  
5. Dashboard shows status, votes, errors, and timing from the API  

---

## Known limitations

- Destination Fabric path is a **stub** until a Fabric network and gateway SDK are wired.
- sql.js uses a file lock so multiple Node processes can share one DB file; for heavy production load prefer PostgreSQL (`DATABASE_URL`).
- No atomic cross-chain commit / rollback.
# Cryptographic consensus and leader rotation

Approvals use the versioned canonical digest `keccak256(abi.encode(...))`:

```text
keccak256(abi.encode(
  keccak256("SmartListenerCrossChain:v1"),
  keccak256("SmartListenerCrossChain(bytes32 sourceTxId,uint256 sourceChainId,uint256 destinationChainId,bytes32 destinationRouteId,address receiver,bytes32 payloadHash,address recipient,uint8 transferMode,uint256 amount,uint256 nonce,uint256 deadline)"),
  sourceChainId, sourceTxId, destinationChainId, destinationRouteId, destinationReceiver,
  keccak256(payload), recipient, transferMode, amount, nonce, deadline
))
```

`transferMode` is `0` for `MESSAGE_ONLY` and `1` for `ETH_TRANSFER`; message-only
transactions use the zero address and zero amount. The digest binds the exact
source transaction, both chain/route identifiers, destination contract, payload,
recipient, mode, amount, nonce, and expiry. The published test vector is covered
by `listener/src/digest.unit.test.ts`.

Each listener signs this digest with its configured wallet. Votes persist the
listener ID, signer address, signature, and digest. The destination receiver
recovers every signature, requires distinct authorized signers and
`requiredVotes`, rejects expired or replayed digests, and checks the payload and
transfer fields before releasing reserve-backed ETH. Database vote counts are
coordination metadata only and are not cryptographic proof.

Leader rotation is deterministic: round `r = floor(unixTime / δ)` and leader
`LISTENER_IDS[r mod n]`, where `δ` is `LEADER_ROUND_SECONDS` (30 seconds by
default). Clients cannot select a leader. All listeners vote, while only the
current leader performs approval coordination and execution; the next round
re-evaluates pending approvals, so a failed leader cannot permanently block a
transaction.

This design uses multiple individual ECDSA signatures. It is **not** a true
threshold ECDSA signature: no distributed key-generation or threshold signing
protocol is implemented.
# Sepolia escrow-gated ETH transfer

The dashboard's Sepolia page uses `SepoliaEscrow`, not a direct wallet-to-recipient transfer. MetaMask deposits ETH into the escrow; the existing four listener processes independently validate the on-chain `Deposited` event and stored escrow state, sign the exact escrow digest, and require 3-of-4 distinct authorized signatures before a listener coordinator can call `release`. The contract itself verifies every signature, so an API response or database vote count cannot release funds. A depositor-only `refund` is available after the deposit deadline.

The escrow digest is:

```
keccak256(abi.encode(
  keccak256("SmartListenerSepoliaEscrow:v1"),
  address(this), block.chainid, txId, sender, recipient, amount,
  payloadHash, deadline, nonce
))
```

The listener signatures are ordinary individual ECDSA signatures. They are **not** a true threshold ECDSA signature: the contract receives and verifies multiple complete signatures and requires three distinct authorized addresses.

## Manual Sepolia setup

1. Generate four dedicated listener wallets and keep their mnemonic/private keys outside Git. Do not reuse the local Hardhat demo mnemonic. Fund the four listener accounts and a deployer account with Sepolia ETH.
2. Set `SEPOLIA_RPC_URL` and `DEPLOYER_PRIVATE_KEY` in a local, uncommitted `.env`, then deploy manually:

```powershell
$env:SEPOLIA_LISTENER_ADDRESSES="0xA...,0xB...,0xC...,0xD..."
npx hardhat run scripts/deploySepoliaEscrow.ts --network sepolia
```

3. Put the resulting address in `SEPOLIA_ESCROW_ADDRESS` for the listeners and `VITE_SEPOLIA_ESCROW_ADDRESS` in `dashboard/.env`. Set `SOURCE_MODE=sepolia`, `SEPOLIA_CHAIN_ID=11155111`, and `SEPOLIA_LISTENER_MNEMONIC` for each listener process. `LISTENER_ID=A|B|C|D` selects the derivation path; `REQUIRED_VOTES=3` and `TOTAL_LISTENERS=4` are the enforced quorum.
4. Restart the API and four listener processes with the Sepolia environment. The same listener/database/consensus implementation is used; local Hardhat mode remains the default.
5. In MetaMask, switch to Sepolia, obtain faucet ETH, open the dashboard, and deposit a small amount. The UI shows the deposit hash separately from the release hash and polls `/api/transactions/:txId` for listener votes and settlement.

No Sepolia contract is deployed and no real-chain transaction is submitted by the project scripts automatically. The dashboard payload is committed as a hash in the escrow authorization; the plaintext is not sent to the contract.
