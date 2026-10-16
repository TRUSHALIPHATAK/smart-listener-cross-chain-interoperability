import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

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
if (!["A", "B", "C"].includes(rawId)) {
  throw new Error(`LISTENER_ID must be A, B, or C. Got: ${rawId}`);
}
export const LISTENER_ID = rawId as "A" | "B" | "C";

// ── Source Chain ──────────────────────────────────────────────────────────────

export const SOURCE_RPC_URL     = optional("SOURCE_RPC_URL", "http://127.0.0.1:8545");
export const SOURCE_CHAIN_ID    = optionalInt("SOURCE_CHAIN_ID", 31337);
export const POLL_INTERVAL_MS   = optionalInt("POLL_INTERVAL_MS", 2000);
export const CONFIRMATIONS      = optionalInt("CONFIRMATIONS", 1);

// ── Contract Addresses ────────────────────────────────────────────────────────

function loadDeployment(): { SenderContract: string; ReceiverMock: string } {
  const deployPath = path.join(__dirname, "..", "config", "deployment.json");
  if (fs.existsSync(deployPath)) {
    const data = JSON.parse(fs.readFileSync(deployPath, "utf8"));
    return data.contracts;
  }
  // Fall back to env vars
  return {
    SenderContract: optional("SENDER_CONTRACT_ADDRESS", ""),
    ReceiverMock:   optional("RECEIVER_MOCK_ADDRESS",   ""),
  };
}

const deployment = loadDeployment();
export const SENDER_CONTRACT_ADDRESS = process.env.SENDER_CONTRACT_ADDRESS ?? deployment.SenderContract;
export const RECEIVER_MOCK_ADDRESS   = process.env.RECEIVER_MOCK_ADDRESS   ?? deployment.ReceiverMock;

// ── Consensus ─────────────────────────────────────────────────────────────────

/** Minimum approve votes needed to trigger execution */
export const REQUIRED_VOTES     = optionalInt("REQUIRED_VOTES", 2);
/** Total number of Listener processes */
export const TOTAL_LISTENERS    = optionalInt("TOTAL_LISTENERS", 3);

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
 * (unset)                                              → uses SQLite in ./data/
 */
export const DATABASE_URL       = process.env.DATABASE_URL ?? "";
export const SQLITE_PATH        = optional("SQLITE_PATH", path.join(__dirname, "..", "data", "smartlistener.db"));

// ── Destination ───────────────────────────────────────────────────────────────

/**
 * DESTINATION_TYPE: "simulated" | "fabric"
 * "simulated" = local ReceiverMock (default for dev)
 * "fabric"    = Hyperledger Fabric adapter (requires Fabric env vars)
 */
export const DESTINATION_TYPE   = optional("DESTINATION_TYPE", "simulated") as "simulated" | "fabric";

// Fabric (only used when DESTINATION_TYPE=fabric)
export const FABRIC_CHANNEL     = optional("FABRIC_CHANNEL", "mychannel");
export const FABRIC_CHAINCODE   = optional("FABRIC_CHAINCODE", "receiver");
export const FABRIC_MSP_ID      = optional("FABRIC_MSP_ID", "Org1MSP");
export const FABRIC_WALLET_PATH = optional("FABRIC_WALLET_PATH", "./fabric-wallet");
export const FABRIC_GATEWAY_URL = optional("FABRIC_GATEWAY_URL", "");

// ── API Server ────────────────────────────────────────────────────────────────

export const API_PORT           = optionalInt("API_PORT", 3001);
export const API_HOST           = optional("API_HOST", "0.0.0.0");

// ── Logging ───────────────────────────────────────────────────────────────────

export const LOG_LEVEL          = optional("LOG_LEVEL", "info");
export const LOG_PRETTY         = optional("LOG_PRETTY", "true") === "true";

// ── Summary (printed on startup) ──────────────────────────────────────────────

export function printConfig() {
  console.log("=== Smart Listener Configuration ===");
  console.log(`  Listener ID:        ${LISTENER_ID}`);
  console.log(`  Source RPC:         ${SOURCE_RPC_URL}`);
  console.log(`  SenderContract:     ${SENDER_CONTRACT_ADDRESS || "(not set)"}`);
  console.log(`  Destination type:   ${DESTINATION_TYPE}`);
  console.log(`  DB:                 ${DATABASE_URL ? "PostgreSQL" : `SQLite @ ${SQLITE_PATH}`}`);
  console.log(`  Required votes:     ${REQUIRED_VOTES}/${TOTAL_LISTENERS}`);
  console.log(`  TX timeout:         ${TX_TIMEOUT_MS}ms`);
  console.log(`  API port:           ${API_PORT}`);
  console.log("=====================================");
}
