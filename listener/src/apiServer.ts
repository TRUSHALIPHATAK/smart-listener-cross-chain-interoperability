/**
 * apiServer.ts — Express REST API + WebSocket push
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/transactions          ?status=&limit=&offset=
 *   GET  /api/transactions/:txId    full detail + votes
 *   GET  /api/listeners             heartbeat status
 *   GET  /api/metrics               latency, throughput, counts
 *   POST /api/transactions/submit   submit a tx via the SenderContract
 *
 * WebSocket (ws://host:port/ws):
 *   Server pushes { type: "update", data: <transaction> } on state changes
 */

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { WebSocketServer, WebSocket } from "ws";
import { getDb, closeDb } from "./db";
import { childLogger } from "./logger";
import { API_PORT, API_HOST, SOURCE_RPC_URL } from "./config";
import { TxStatus } from "./types";

// ── SenderContract ABI (minimal — only sendCrossChainTransaction) ──────────────
const SENDER_ABI = [
  "function sendCrossChainTransaction(bytes32 destinationChainId, bytes calldata destinationAddress, bytes calldata payload) external returns (bytes32 txId)",
  "function getNonce(address sender) external view returns (uint256)",
];

function loadDeploymentContracts(): { SenderContract?: string } {
  const p = path.join(__dirname, "..", "config", "deployment.json");
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")).contracts ?? {}; } catch { /* fall through */ }
  }
  return {};
}

const log = childLogger("apiServer");
const app = express();
app.use(cors());
app.use(express.json());

// ── WebSocket clients ─────────────────────────────────────────────────────────

const wsClients = new Set<WebSocket>();

export function broadcastUpdate(data: unknown) {
  const msg = JSON.stringify({ type: "update", data, ts: Date.now() });
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use((req: Request, _res: Response, next: NextFunction) => {
  log.debug({ method: req.method, path: req.path }, "Request");
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/transactions", async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const status = req.query.status as TxStatus | undefined;
    const limit  = Math.min(parseInt(req.query.limit  as string ?? "50",  10), 200);
    const offset = parseInt(req.query.offset as string ?? "0",  10);
    const txns = await db.listTransactions({ status, limit, offset });
    const total = await db.countTransactions(status);
    res.json({ transactions: txns, total, limit, offset });
  } catch (err) {
    log.error({ err }, "GET /api/transactions error");
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/transactions/:txId", async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const txId = req.params.txId;
    if (typeof txId !== "string") {
      return res.status(400).json({ error: "Invalid transaction ID" });
    }
    const tx = await db.getTransaction(txId);
    if (!tx) {
      return res.status(404).json({ error: "Transaction not found" });
    }
    const votes = await db.getVotes(txId);
    res.json({ ...tx, votes });
  } catch (err) {
    log.error({ err }, "GET /api/transactions/:txId error");
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/listeners", async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const heartbeats = await db.getHeartbeats();
    // Mark listeners as offline if not seen in last 30s
    const now = Date.now();
    const enriched = heartbeats.map((hb) => ({
      ...hb,
      online: now - hb.lastSeenAt < 30_000,
    }));
    res.json({ listeners: enriched });
  } catch (err) {
    log.error({ err }, "GET /api/listeners error");
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/metrics", async (_req: Request, res: Response) => {
  try {
    const db = await getDb();
    const WINDOW = 60_000; // last 60 seconds

    const [
      total, pending, approved, executed,
      failed, timedOut, rejected,
      avgLatency, throughput, listeners
    ] = await Promise.all([
      db.countTransactions(),
      db.countTransactions("PENDING"),
      db.countTransactions("APPROVED"),
      db.countTransactions("EXECUTED"),
      db.countTransactions("FAILED"),
      db.countTransactions("TIMED_OUT"),
      db.countTransactions("REJECTED"),
      db.getAvgLatencyMs(WINDOW),
      db.getThroughput(WINDOW),
      db.getHeartbeats(),
    ]);

    res.json({
      totalTransactions: total,
      pending,
      approved,
      executed,
      failed,
      timedOut,
      rejected,
      avgLatencyMs: Math.round(avgLatency),
      throughputPerMinute: throughput,
      listeners,
      windowSeconds: WINDOW / 1000,
    });
  } catch (err) {
    log.error({ err }, "GET /api/metrics error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /api/transactions/submit ─────────────────────────────────────────────
// Submits a cross-chain tx to the SenderContract on the local Hardhat node.
// Body: { destinationChainId?: string, destinationAddress?: string, payload: string, privateKey?: string }
// privateKey should come from the client (Hardhat test account) — never stored.

app.post("/api/transactions/submit", async (req: Request, res: Response) => {
  try {
    const {
      destinationChainId = "simulated-evm-chain",
      destinationAddress = "0xRecipientAddress",
      payload,
      privateKey,
    } = req.body as {
      destinationChainId?: string;
      destinationAddress?: string;
      payload?: string;
      privateKey?: string;
    };

    if (!payload || payload.trim() === "") {
      return res.status(400).json({ error: "payload is required" });
    }

    const contracts = loadDeploymentContracts();
    if (!contracts.SenderContract) {
      return res.status(503).json({
        error: "SenderContract not deployed. Run `npm run deploy:local` first.",
      });
    }

    // Use provided private key OR Hardhat default account #0
    const HARDHAT_DEFAULT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const signerKey = privateKey || HARDHAT_DEFAULT_KEY;

    const provider = new ethers.JsonRpcProvider(SOURCE_RPC_URL);
    const wallet   = new ethers.Wallet(signerKey, provider);
    const contract = new ethers.Contract(contracts.SenderContract, SENDER_ABI, wallet);

    const destChainBytes32 = ethers.encodeBytes32String(destinationChainId.slice(0, 31));
    const destAddressBytes  = ethers.toUtf8Bytes(destinationAddress);
    const payloadBytes      = ethers.toUtf8Bytes(payload);

    log.info({ payload: payload.slice(0, 50), dest: destinationChainId }, "Submitting cross-chain tx");

    const txn = await contract.sendCrossChainTransaction(
      destChainBytes32,
      destAddressBytes,
      payloadBytes
    );
    const receipt = await txn.wait();

    // Extract the emitted txId
    const iface = new ethers.Interface([
      "event TransactionSent(bytes32 indexed txId, address indexed sender, bytes32 indexed destinationChainId, bytes destinationAddress, bytes payload, uint256 nonce, uint256 timestamp)",
    ]);
    const parsedLog = receipt?.logs
      .map((l: ethers.Log) => { try { return iface.parseLog({ topics: [...l.topics], data: l.data }); } catch { return null; } })
      .find((e) => e?.name === "TransactionSent");

    const txId = parsedLog?.args?.txId ?? null;

    log.info({ txId, hash: receipt?.hash, block: receipt?.blockNumber }, "Cross-chain tx submitted");

    return res.json({
      success: true,
      txId,
      transactionHash: receipt?.hash,
      blockNumber: receipt?.blockNumber,
      senderAddress: wallet.address,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, "POST /api/transactions/submit error");
    return res.status(500).json({ error: msg });
  }
});

// ── GET /api/deployment ───────────────────────────────────────────────────────

app.get("/api/deployment", (_req: Request, res: Response) => {
  const contracts = loadDeploymentContracts();
  const hasDeployment = !!contracts.SenderContract;
  res.json({
    deployed: hasDeployment,
    contracts,
    rpcUrl: SOURCE_RPC_URL,
  });
});

// ── Server Bootstrap ──────────────────────────────────────────────────────────


async function startServer() {
  await getDb(); // initialise DB schema

  const server = http.createServer(app);

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    wsClients.add(ws);
    log.debug("WebSocket client connected");
    ws.on("close", () => {
      wsClients.delete(ws);
      log.debug("WebSocket client disconnected");
    });
  });

  server.listen(API_PORT, API_HOST, () => {
    log.info({ port: API_PORT, host: API_HOST }, "API server listening");
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "API server shutting down");
    server.close();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

startServer().catch((err) => {
  console.error("Fatal API server error:", err);
  process.exit(1);
});
