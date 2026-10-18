import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { LISTENER_IDS, ListenerId } from "./types";

dotenv.config({ path: path.join(__dirname, "..", "..", ".env") });

// ── Helper ────────────────────────────────────────────────────────────────────

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  if (isNaN(n)) throw new Error(`Env var ${key} must be an integer, got: ${v}`);
  return n;
}

// ── Listener Identity ─────────────────────────────────────────────────────────

const rawId = optional("LISTENER_ID", "A").toUpperCase();
if (!(LISTENER_IDS as readonly string[]).includes(rawId)) {
  throw new Error(`LISTENER_ID must be one of ${LISTENER_IDS.join(", ")}. Got: ${rawId}`);
}
export const LISTENER_ID = rawId as ListenerId;

// ── Source Chain ──────────────────────────────────────────────────────────────

export const SOURCE_RPC_URL     = optional("SOURCE_RPC_URL", "http://127.0.0.1:8545");
export const SOURCE_CHAIN_ID    = optionalInt("SOURCE_CHAIN_ID", 31337);
export const POLL_INTERVAL_MS   = optionalInt("POLL_INTERVAL_MS", 2000);
/** First block to scan on startup (0 = replay from genesis; safe because votes are idempotent) */
export const START_BLOCK        = optionalInt("START_BLOCK", 0);
export const CONFIRMATIONS      = optionalInt("CONFIRMATIONS", 1);

// ── Contract Addresses ────────────────────────────────────────────────────────

function loadDeployment(): { SenderContract: string; ReceiverMock: string; DestinationReceiver?: string } {
  const deployPath = path.join(__dirname, "..", "config", "deployment.json");
  if (fs.existsSync(deployPath)) {
    const data = JSON.parse(fs.readFileSync(deployPath, "utf8"));
    return data.contracts;
  }
  // Fall back to env vars
  return {
    SenderContract: optional("SENDER_CONTRACT_ADDRESS", ""),
    ReceiverMock:   optional("RECEIVER_MOCK_ADDRESS",   ""),
    DestinationReceiver: optional("DESTINATION_RECEIVER_ADDRESS", ""),
  };
}

const deployment = loadDeployment();
export const SENDER_CONTRACT_ADDRESS = process.env.SENDER_CONTRACT_ADDRESS ?? deployment.SenderContract;
export const RECEIVER_MOCK_ADDRESS   = process.env.RECEIVER_MOCK_ADDRESS   ?? deployment.ReceiverMock;

// ── Consensus ─────────────────────────────────────────────────────────────────

/** Minimum approve votes needed to trigger execution */
export const REQUIRED_VOTES     = optionalInt("REQUIRED_VOTES", 3);
/** Total number of Listener processes */
export const TOTAL_LISTENERS    = optionalInt("TOTAL_LISTENERS", 4);

// Paper (Bigiotti et al.) requires the signing threshold t >= n/2 + 1 (strict majority).
if (TOTAL_LISTENERS > LISTENER_IDS.length) {
  throw new Error(`TOTAL_LISTENERS (${TOTAL_LISTENERS}) exceeds supported listener IDs (${LISTENER_IDS.length})`);
}
if (REQUIRED_VOTES <= TOTAL_LISTENERS / 2 || REQUIRED_VOTES > TOTAL_LISTENERS) {
  throw new Error(`REQUIRED_VOTES (${REQUIRED_VOTES}) must be a strict majority of TOTAL_LISTENERS (${TOTAL_LISTENERS})`);
}

// ── Timing ────────────────────────────────────────────────────────────────────

/** How long (ms) to wait before marking a tx TIMED_OUT */
export const TX_TIMEOUT_MS      = optionalInt("TX_TIMEOUT_MS", 60_000);
/** Max retry attempts on destination execution failure */
export const MAX_RETRIES        = optionalInt("MAX_RETRIES", 3);
/** Base delay (ms) between retries (exponential backoff) */
export const RETRY_BACKOFF_MS   = optionalInt("RETRY_BACKOFF_MS", 2_000);

// ── Storage ───────────────────────────────────────────────────────────────────

/**
 * DATABASE_URL: postgres://user:pass@host:5432/dbname  → uses PostgreSQL
 * (unset)                                              → uses SQLite via sql.js in ./data/
 */
export const DATABASE_URL       = process.env.DATABASE_URL ?? "";
export const SQLITE_PATH        = optional("SQLITE_PATH", path.join(__dirname, "..", "data", "smartlistener.db"));

// ── Destination ───────────────────────────────────────────────────────────────

/**
 * DESTINATION_TYPE: "evm" | "simulated" | "fabric"
 * "evm"       = real second chain + DestinationReceiver contract (default)
 * "simulated" = fake adapter with random latency/failures
 * "fabric"    = Hyperledger Fabric adapter (stub)
 */
export const DESTINATION_TYPE   = optional("DESTINATION_TYPE", "evm") as "evm" | "simulated" | "fabric";
export const DEST_RPC_URL       = optional("DEST_RPC_URL", "http://127.0.0.1:8546");
export const DESTINATION_RECEIVER_ADDRESS: string =
  process.env.DESTINATION_RECEIVER_ADDRESS ?? deployment.DestinationReceiver ?? "";
/** Local-demo only: Hardhat's public test mnemonic. Listener A..D use accounts #1..#4. */
export const EXECUTOR_MNEMONIC  = optional("EXECUTOR_MNEMONIC", "test test test test test test test test test test test junk");

// Fabric (only used when DESTINATION_TYPE=fabric)
export const FABRIC_CHANNEL     = optional("FABRIC_CHANNEL", "mychannel");
export const FABRIC_CHAINCODE   = optional("FABRIC_CHAINCODE", "receiver");
export const FABRIC_MSP_ID      = optional("FABRIC_MSP_ID", "Org1MSP");
export const FABRIC_WALLET_PATH = optional("FABRIC_WALLET_PATH", "./fabric-wallet");
export const FABRIC_GATEWAY_URL = optional("FABRIC_GATEWAY_URL", "");

// ── API Server ────────────────────────────────────────────────────────────────

export const API_PORT           = optionalInt("API_PORT", 3001);
export const API_HOST           = optional("API_HOST", "127.0.0.1");

// ── Logging ───────────────────────────────────────────────────────────────────

export const LOG_LEVEL          = optional("LOG_LEVEL", "info");
export const LOG_PRETTY         = optional("LOG_PRETTY", "true") === "true";

// ── Summary (printed on startup) ──────────────────────────────────────────────

export function printConfig() {
  console.log("=== Smart Listener Configuration ===");
  console.log(`  Listener ID:        ${LISTENER_ID}`);
  console.log(`  Source RPC:         ${SOURCE_RPC_URL}`);
  console.log(`  SenderContract:     ${SENDER_CONTRACT_ADDRESS || "(not set)"}`);
  console.log(`  Destination type:   ${DESTINATION_TYPE}${DESTINATION_TYPE === "evm" ? ` @ ${DEST_RPC_URL}` : ""}`);
  console.log(`  DB:                 ${DATABASE_URL ? "PostgreSQL" : `SQLite (sql.js) @ ${SQLITE_PATH}`}`);
  console.log(`  Required votes:     ${REQUIRED_VOTES}/${TOTAL_LISTENERS}`);
  console.log(`  TX timeout:         ${TX_TIMEOUT_MS}ms`);
  console.log(`  API port:           ${API_PORT}`);
  console.log("=====================================");
}
