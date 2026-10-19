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
import { API_PORT, API_HOST, API_CORS_ORIGINS, SOURCE_RPC_URL, EXECUTOR_MNEMONIC } from "./config";
import { TxStatus, CrossChainTransaction, TransferMode } from "./types";

// ── SenderContract ABI (minimal — only sendCrossChainTransaction) ──────────────
const SENDER_ABI = [
  "function sendCrossChainTransaction(bytes32 destinationChainId, bytes calldata destinationAddress, bytes calldata payload) external payable returns (bytes32 txId)",
  "function getNonce(address sender) external view returns (uint256)",
];

function loadDeploymentContracts(): Record<string, string> {
  const p = path.join(__dirname, "..", "config", "deployment.json");
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")).contracts ?? {}; } catch { /* fall through */ }
  }
  return {};
}

const log = childLogger("apiServer");
export const app = express();
export function isApiOriginAllowed(origin: string | undefined): boolean {
  return !origin || API_CORS_ORIGINS.includes(origin);
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (!isApiOriginAllowed(origin)) {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  return next();
});
app.use(cors({
  origin: (origin, callback) => callback(null, isApiOriginAllowed(origin)),
}));
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

export function validateSubmissionBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Request body must be an object";
  if (Object.prototype.hasOwnProperty.call(body, "privateKey")) {
    return "privateKey must not be supplied by the client";
  }
  const payload = (body as { payload?: unknown }).payload;
  if (
    (typeof payload !== "string" || payload.trim() === "") &&
    (typeof payload !== "object" || payload === null)
  ) return "payload is required";
  const mode = (body as { transferMode?: unknown }).transferMode ?? "MESSAGE_ONLY";
  if (mode !== "MESSAGE_ONLY" && mode !== "ETH_TRANSFER") return "transferMode must be MESSAGE_ONLY or ETH_TRANSFER";
  const amountEth = (body as { amountEth?: unknown }).amountEth;
  if (mode === "ETH_TRANSFER") {
    if (typeof amountEth !== "string" || amountEth.trim() === "") return "amountEth is required for ETH_TRANSFER";
    try {
      if (ethers.parseEther(amountEth) <= 0n) return "amountEth must be greater than zero";
    } catch {
      return "amountEth must be a valid positive ETH amount";
    }
  } else if (amountEth !== undefined && amountEth !== "" && amountEth !== "0") {
    return "Message-only transactions must use amountEth 0 or omit it";
  }
  const destinationAddress = (body as { destinationAddress?: unknown }).destinationAddress;
  if (mode === "ETH_TRANSFER" && (typeof destinationAddress !== "string" || !ethers.isAddress(destinationAddress))) {
    return "destinationAddress must be a valid EVM address for ETH_TRANSFER";
  }
  return null;
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
    const contracts = loadDeploymentContracts();
    res.json({
      ...tx,
      votes,
      sourceChainId: 31337,
      sourceNetwork: "local Hardhat",
      sourceContractAddress: contracts.SenderContract,
      destinationNetwork: "local Hardhat (31338)",
      destinationReceiverAddress: contracts.DestinationReceiver,
    });
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
      failed, timedOut, rejected, rolledBack,
      avgLatency, throughput, listeners
    ] = await Promise.all([
      db.countTransactions(),
      db.countTransactions("PENDING"),
      db.countTransactions("APPROVED"),
      db.countTransactions("EXECUTED"),
      db.countTransactions("FAILED"),
      db.countTransactions("TIMED_OUT"),
      db.countTransactions("ROLLED_BACK"),
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
// Body: { destinationChainId?: string, destinationAddress?: string, payload: string|object, transferMode?: TransferMode, amountEth?: string }
// Signs with the server-configured executor wallet. Clients can NOT supply keys.

app.post("/api/transactions/submit", async (req: Request, res: Response) => {
  try {
    const validationError = validateSubmissionBody(req.body);
    if (validationError) return res.status(400).json({ error: validationError });

    const {
      destinationChainId = "simulated-evm-chain",
      destinationAddress = "0xRecipientAddress",
      payload,
      transferMode = "MESSAGE_ONLY",
      amountEth = "0",
    } = req.body as {
      destinationChainId?: string;
      destinationAddress?: string;
      payload: string | Record<string, unknown>;
      transferMode?: TransferMode;
      amountEth?: string;
    };
    const payloadText = typeof payload === "string" ? payload : JSON.stringify(payload);
    const amountWei = transferMode === "ETH_TRANSFER" ? ethers.parseEther(amountEth) : 0n;

    const contracts = loadDeploymentContracts();
    if (!contracts.SenderContract) {
      return res.status(503).json({
        error: "SenderContract not deployed. Run `npm run deploy:local` first.",
      });
    }

    const provider = new ethers.JsonRpcProvider(SOURCE_RPC_URL);
    // The server-owned executor wallet is derived from the configured mnemonic.
    // No signing material is accepted from or returned to API clients.
    const wallet   = ethers.HDNodeWallet.fromPhrase(EXECUTOR_MNEMONIC).connect(provider);
    const contract = new ethers.Contract(contracts.SenderContract, SENDER_ABI, wallet);

    const destChainBytes32 = ethers.encodeBytes32String(destinationChainId.slice(0, 31));
    const destAddressBytes  = transferMode === "ETH_TRANSFER"
      ? ethers.getBytes(destinationAddress)
      : ethers.toUtf8Bytes(destinationAddress);
    const payloadBytes      = ethers.toUtf8Bytes(payloadText);
    const balance = await provider.getBalance(wallet.address);
    if (amountWei > balance) {
      return res.status(400).json({ error: "Requested ETH amount exceeds the server wallet balance." });
    }

    log.info({ payload: payloadText.slice(0, 50), dest: destinationChainId, transferMode, amountWei: amountWei.toString() }, "Submitting cross-chain tx");

    const txn = await contract.sendCrossChainTransaction(
      destChainBytes32,
      destAddressBytes,
      payloadBytes,
      { value: amountWei }
    );
    const receipt = await txn.wait();

    // Extract the emitted txId
    const iface = new ethers.Interface([
      "event TransactionSent(bytes32 indexed txId, address indexed sender, bytes32 indexed destinationChainId, bytes destinationAddress, bytes payload, uint256 nonce, uint256 timestamp, uint256 amount)",
    ]);
    const parsedLog = receipt?.logs
      .map((l: ethers.Log) => { try { return iface.parseLog({ topics: [...l.topics], data: l.data }); } catch { return null; } })
      .find((e: { name?: string } | null) => e?.name === "TransactionSent");

    const txId = parsedLog?.args?.txId ?? null;

    if (!parsedLog || !txId) {
      return res.status(502).json({
        error: "Source transaction was mined, but TransactionSent could not be decoded.",
        transactionHash: receipt?.hash,
        blockNumber: receipt?.blockNumber,
      });
    }

    const eventArgs = parsedLog.args;
    const now = Date.now();
    const submitted: CrossChainTransaction = {
      txId: String(txId),
      sender: String(eventArgs.sender),
      destinationChainId: String(eventArgs.destinationChainId),
      destinationAddress: String(eventArgs.destinationAddress),
      payload: String(eventArgs.payload),
      payloadText,
      payloadHash: ethers.keccak256(payloadBytes),
      transferMode,
      requestedAmountWei: amountWei.toString(),
      sourceValueWei: String(eventArgs.amount),
      nonce: String(eventArgs.nonce),
      sourceTimestamp: Number(eventArgs.timestamp) * 1000,
      sourceBlockNumber: Number(receipt?.blockNumber ?? 0),
      sourceTransactionHash: receipt?.hash,
      sourceBlockHash: receipt?.blockHash,
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
      approveVotes: 0,
      rejectVotes: 0,
    };
    await (await getDb()).upsertTransaction(submitted);

    log.info({ txId, hash: receipt?.hash, block: receipt?.blockNumber }, "Cross-chain tx submitted");

    return res.json({
      success: true,
      txId,
      transactionHash: receipt?.hash,
      blockNumber: receipt?.blockNumber,
      senderAddress: wallet.address,
      transferMode,
      requestedAmountWei: amountWei.toString(),
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
    ws.send(JSON.stringify({
      type: "update",
      data: { lastUpdatedAt: lastSeen },
      ts: Date.now(),
    }));
    ws.on("close", () => {
      wsClients.delete(ws);
      log.debug("WebSocket client disconnected");
    });
  });

  // Push a WebSocket message whenever any transaction changes (listeners run in other processes,
  // so the API watches the shared DB instead of being called directly).
  let lastSeen = await (await getDb()).getLastUpdatedAt();
  const changeTimer = setInterval(async () => {
    try {
      const db = await getDb();
      const latest = await db.getLastUpdatedAt();
      if (latest !== lastSeen) {
        lastSeen = latest;
        broadcastUpdate({ lastUpdatedAt: latest });
      }
    } catch (err) {
      log.warn({ err }, "WS change-watcher error");
    }
  }, 1000);

  server.listen(API_PORT, API_HOST, () => {
    log.info({ port: API_PORT, host: API_HOST }, "API server listening");
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "API server shutting down");
    clearInterval(changeTimer);
    for (const client of wsClients) {
      try { client.close(); } catch { /* ignore close errors */ }
    }
    wsClients.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error("Fatal API server error:", err);
    process.exit(1);
  });
}

export { startServer };
