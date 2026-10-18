/**
 * Unit tests for sql.js SQLite adapter — uses a temp file path.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { DbAdapter } from "./db";
import type { CrossChainTransaction, ListenerVote } from "./types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-db-"));
const tmpDb = path.join(tmpDir, "test.db");

let db: DbAdapter;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  process.env.SQLITE_PATH = tmpDb;
  delete process.env.DATABASE_URL;
  jest.resetModules();
  const mod = await import("./db");
  db = await mod.getDb();
  closeDb = mod.closeDb;
});

afterAll(async () => {
  if (closeDb) await closeDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("SqliteAdapter (sql.js)", () => {
  it("initializes and counts zero transactions", async () => {
    expect(await db.countTransactions()).toBe(0);
  });

  it("upserts a transaction idempotently", async () => {
    const tx: CrossChainTransaction = {
      txId: "0xabc123",
      sender: "0xSender",
      destinationChainId: "0xdest",
      destinationAddress: "0xaddr",
      payload: "0xdead",
      nonce: "1",
      sourceTimestamp: 1000,
      sourceBlockNumber: 10,
      status: "PENDING",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      approveVotes: 0,
      rejectVotes: 0,
    };
    await db.upsertTransaction(tx);
    await db.upsertTransaction(tx);
    expect(await db.countTransactions()).toBe(1);
    const got = await db.getTransaction("0xabc123");
    expect(got?.payload).toBe("0xdead");
    expect(got?.status).toBe("PENDING");
  });

  it("records votes and updates aggregates", async () => {
    const vote: ListenerVote = {
      txId: "0xabc123",
      listenerId: "A",
      vote: "APPROVE",
      votedAt: Date.now(),
    };
    await db.recordVote(vote);
    expect(await db.hasVoted("0xabc123", "A")).toBe(true);
    expect(await db.hasVoted("0xabc123", "B")).toBe(false);
    const votes = await db.getVotes("0xabc123");
    expect(votes).toHaveLength(1);
    const tx = await db.getTransaction("0xabc123");
    expect(tx?.approveVotes).toBe(1);
  });

  it("upserts heartbeats", async () => {
    await db.upsertHeartbeat({
      listenerId: "B",
      lastSeenAt: Date.now(),
      sourceChainConnected: true,
      lastProcessedBlock: 42,
      pendingVotes: 1,
    });
    const hbs = await db.getHeartbeats();
    expect(hbs.some((h) => h.listenerId === "B" && h.lastProcessedBlock === 42)).toBe(true);
  });

  it("updates status", async () => {
    await db.updateTransactionStatus("0xabc123", "EXECUTED", { destTxHash: "0xSIM" });
    const tx = await db.getTransaction("0xabc123");
    expect(tx?.status).toBe("EXECUTED");
    expect(tx?.destTxHash).toBe("0xSIM");
  });

  it("transitionStatus only succeeds once (atomic claim) and respects `from`", async () => {
    await db.upsertTransaction({
      txId: "0xclaim", sender: "0xS", destinationChainId: "0xd", destinationAddress: "0xa",
      payload: "0x01", nonce: "1", sourceTimestamp: 1, sourceBlockNumber: 1,
      status: "PENDING", createdAt: Date.now(), updatedAt: Date.now(), approveVotes: 0, rejectVotes: 0,
    });
    const first  = await db.transitionStatus("0xclaim", ["PENDING", "VOTED"], "APPROVED");
    const second = await db.transitionStatus("0xclaim", ["PENDING", "VOTED"], "APPROVED");
    expect(first).toBe(true);
    expect(second).toBe(false);
    // a late TIMED_OUT must not overwrite a different state
    expect(await db.transitionStatus("0xclaim", ["PENDING"], "TIMED_OUT")).toBe(false);
    expect((await db.getTransaction("0xclaim"))?.status).toBe("APPROVED");
  });

  it("reports the latest updated_at", async () => {
    expect(await db.getLastUpdatedAt()).toBeGreaterThan(0);
  });
});
