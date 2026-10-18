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
| `DESTINATION_TYPE` | `simulated` | `simulated` or `fabric` (stub) |
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
