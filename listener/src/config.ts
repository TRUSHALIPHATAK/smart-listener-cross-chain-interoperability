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

function optionalPositiveNumber(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Env var ${key} must be a positive number, got: ${v}`);
  return n;
}

// ── Listener Identity ─────────────────────────────────────────────────────────

const rawId = optional("LISTENER_ID", "A").toUpperCase();
if (!(LISTENER_IDS as readonly string[]).includes(rawId)) {
  throw new Error(`LISTENER_ID must be one of ${LISTENER_IDS.join(", ")}. Got: ${rawId}`);
}
export const LISTENER_ID = rawId as ListenerId;

// ── Source Chain ──────────────────────────────────────────────────────────────

export const SOURCE_MODE        = optional("SOURCE_MODE", "hardhat") as "hardhat" | "sepolia";
export const SEPOLIA_RPC_URL    = optional("SEPOLIA_RPC_URL", "");
export const SEPOLIA_CHAIN_ID   = optionalInt("SEPOLIA_CHAIN_ID", 11155111);
export const SOURCE_RPC_URL     = SOURCE_MODE === "sepolia"
  ? required("SEPOLIA_RPC_URL")
  : optional("SOURCE_RPC_URL", "http://127.0.0.1:8545");
export const SOURCE_CHAIN_ID    = SOURCE_MODE === "sepolia"
  ? SEPOLIA_CHAIN_ID
  : optionalInt("SOURCE_CHAIN_ID", 31337);
export const POLL_INTERVAL_MS   = optionalInt("POLL_INTERVAL_MS", 2000);
/** First block to scan on startup (0 = replay from genesis; safe because votes are idempotent) */
export const START_BLOCK        = optionalInt("START_BLOCK", 0);
export const CONFIRMATIONS      = optionalInt("CONFIRMATIONS", 1);

// ── Contract Addresses ────────────────────────────────────────────────────────

function loadDeployment(): { SenderContract: string; ReceiverMock: string; DestinationReceiver?: string; SepoliaEscrow?: string } {
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
    SepoliaEscrow: optional("SEPOLIA_ESCROW_ADDRESS", ""),
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
export const DEST_CHAIN_ID      = optionalInt("DEST_CHAIN_ID", 31338);
export const DESTINATION_ROUTE_ID = optional("DESTINATION_ROUTE_ID", "simulated-evm-chain");
export const DESTINATION_RECEIVER_ADDRESS: string =
  process.env.DESTINATION_RECEIVER_ADDRESS ?? deployment.DestinationReceiver ?? "";
export const SEPOLIA_ESCROW_ADDRESS: string =
  process.env.SEPOLIA_ESCROW_ADDRESS ?? deployment.SepoliaEscrow ?? "";
/** Local-demo only: Hardhat's public test mnemonic. Listener A..D use accounts #1..#4. */
const LOCAL_DEVELOPMENT_MNEMONIC = "test test test test test test test test test test test junk";
const isLocalHardhat = SOURCE_MODE === "hardhat" && SOURCE_CHAIN_ID === 31337;
export const EXECUTOR_MNEMONIC  = optional("EXECUTOR_MNEMONIC", isLocalHardhat ? LOCAL_DEVELOPMENT_MNEMONIC : "");
export const OWNER_MNEMONIC     = optional("OWNER_MNEMONIC", isLocalHardhat ? LOCAL_DEVELOPMENT_MNEMONIC : "");
export const SEPOLIA_LISTENER_MNEMONIC = SOURCE_MODE === "sepolia"
  ? optional("SEPOLIA_LISTENER_MNEMONIC", "")
  : EXECUTOR_MNEMONIC;

if (!EXECUTOR_MNEMONIC) {
  throw new Error("EXECUTOR_MNEMONIC must be set outside the isolated local Hardhat environment");
}
if (!OWNER_MNEMONIC) {
  throw new Error("OWNER_MNEMONIC must be set outside the isolated local Hardhat environment");
}

// Settlement timing:
// c is CONFIRMATIONS (source blocks, dimensionless); lambdaB is the source
// polling interval (POLL_INTERVAL_MS / 1000 seconds). The default delta A is
// derived from the existing timeout, polling, confirmations, and grace values.
export const DELTA_B_SECONDS = optionalPositiveNumber("DELTA_B_SECONDS", TX_TIMEOUT_MS / 1000);
export const BACKUP_GRACE_SECONDS = optionalPositiveNumber(
  "BACKUP_GRACE_SECONDS",
  Math.max(1, Math.ceil(POLL_INTERVAL_MS / 1000)),
);
export const DELTA_A_SECONDS = optionalPositiveNumber(
  "DELTA_A_SECONDS",
  DELTA_B_SECONDS + CONFIRMATIONS * (POLL_INTERVAL_MS / 1000) + BACKUP_GRACE_SECONDS + 1,
);
export const SETTLEMENT_C = CONFIRMATIONS;
export const SETTLEMENT_LAMBDA_B_SECONDS = POLL_INTERVAL_MS / 1000;
if (DELTA_A_SECONDS <= DELTA_B_SECONDS + SETTLEMENT_C * SETTLEMENT_LAMBDA_B_SECONDS) {
  throw new Error(
    `DELTA_A_SECONDS (${DELTA_A_SECONDS}) must be greater than ` +
    `DELTA_B_SECONDS (${DELTA_B_SECONDS}) + cλB ` +
    `(${SETTLEMENT_C} * ${SETTLEMENT_LAMBDA_B_SECONDS}s)`,
  );
}

// Fabric (only used when DESTINATION_TYPE=fabric)
export const FABRIC_CHANNEL     = optional("FABRIC_CHANNEL", "mychannel");
export const FABRIC_CHAINCODE   = optional("FABRIC_CHAINCODE", "receiver");
export const FABRIC_MSP_ID      = optional("FABRIC_MSP_ID", "Org1MSP");
export const FABRIC_WALLET_PATH = optional("FABRIC_WALLET_PATH", "./fabric-wallet");
export const FABRIC_GATEWAY_URL = optional("FABRIC_GATEWAY_URL", "");

// ── API Server ────────────────────────────────────────────────────────────────

export const API_PORT           = optionalInt("API_PORT", 3001);
export const API_HOST           = optional("API_HOST", "127.0.0.1");
export const API_CORS_ORIGINS   = optional(
  "API_CORS_ORIGINS",
  "http://127.0.0.1:5173,http://localhost:5173",
).split(",").map((origin) => origin.trim()).filter(Boolean);

// ── Logging ───────────────────────────────────────────────────────────────────

export const LOG_LEVEL          = optional("LOG_LEVEL", "info");
export const LOG_PRETTY         = optional("LOG_PRETTY", "true") === "true";

// ── Summary (printed on startup) ──────────────────────────────────────────────

export function printConfig() {
  console.log("=== Smart Listener Configuration ===");
  console.log(`  Listener ID:        ${LISTENER_ID}`);
  console.log(`  Source RPC:         ${SOURCE_RPC_URL}`);
  console.log(`  Source mode:        ${SOURCE_MODE}`);
  if (SOURCE_MODE === "sepolia") console.log(`  Sepolia escrow:     ${SEPOLIA_ESCROW_ADDRESS || "(not set)"}`);
  console.log(`  SenderContract:     ${SENDER_CONTRACT_ADDRESS || "(not set)"}`);
  console.log(`  Destination type:   ${DESTINATION_TYPE}${DESTINATION_TYPE === "evm" ? ` @ ${DEST_RPC_URL}` : ""}`);
  console.log(`  DB:                 ${DATABASE_URL ? "PostgreSQL" : `SQLite (sql.js) @ ${SQLITE_PATH}`}`);
  console.log(`  Required votes:     ${REQUIRED_VOTES}/${TOTAL_LISTENERS}`);
  console.log(`  TX timeout:         ${TX_TIMEOUT_MS}ms`);
  console.log(`  Settlement windows: ΔB=${DELTA_B_SECONDS}s, ΔA=${DELTA_A_SECONDS}s, backup grace=${BACKUP_GRACE_SECONDS}s`);
  console.log(`  Settlement bound:   c=${SETTLEMENT_C}, λB=${SETTLEMENT_LAMBDA_B_SECONDS}s`);
  console.log(`  API port:           ${API_PORT}`);
  console.log("=====================================");
}
