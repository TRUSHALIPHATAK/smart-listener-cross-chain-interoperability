/**
 * apiServer.ts — Express REST API + WebSocket push
 *
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/transactions          ?status=&limit=&offset=
 *   GET  /api/transactions/:txId    full detail + votes
 *   GET  /api/listeners             heartbeat status
 *   GET  /api/metrics               latency, throughput, counts
 *
 * WebSocket (ws://host:port/ws):
 *   Server pushes { type: "update", data: <transaction> } on state changes
 */

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import * as http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { getDb, closeDb } from "./db";
import { childLogger } from "./logger";
import { API_PORT, API_HOST } from "./config";
import { TxStatus } from "./types";

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
    const tx = await db.getTransaction(req.params.txId);
    if (!tx) { res.status(404).json({ error: "Transaction not found" }); return; }
    const votes = await db.getVotes(req.params.txId);
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
