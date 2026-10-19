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

  it("retains source receipt metadata when listener and API upserts race", async () => {
    await db.upsertTransaction({
      txId: "0xmetadata",
      sender: "0xSender",
      destinationChainId: "0xdest",
      destinationAddress: "0xaddr",
      payload: "0xbeef",
      nonce: "2",
      sourceTimestamp: 1000,
      sourceBlockNumber: 11,
      status: "PENDING",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      approveVotes: 0,
      rejectVotes: 0,
    });
    await db.upsertTransaction({
      txId: "0xmetadata",
      sender: "0xSender",
      destinationChainId: "0xdest",
      destinationAddress: "0xaddr",
      payload: "0xbeef",
      nonce: "2",
      sourceTimestamp: 1000,
      sourceBlockNumber: 11,
      sourceTransactionHash: "0xsource",
      sourceBlockHash: "0xblock",
      status: "PENDING",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      approveVotes: 0,
      rejectVotes: 0,
    });
    expect((await db.getTransaction("0xmetadata"))?.sourceTransactionHash).toBe("0xsource");
    expect((await db.getTransaction("0xmetadata"))?.sourceBlockHash).toBe("0xblock");
  });

  it("filters every supported lifecycle status", async () => {
    for (const [index, status] of (["ROLLED_BACK", "FAILED", "EXECUTED"] as const).entries()) {
      await db.upsertTransaction({
        txId: `0xstatus${index}`,
        sender: "0xSender",
        destinationChainId: "0xdest",
        destinationAddress: "0xaddr",
        payload: "0x01",
        nonce: String(index),
        sourceTimestamp: 1000,
        sourceBlockNumber: index + 20,
        status,
        createdAt: Date.now() + index,
        updatedAt: Date.now() + index,
        approveVotes: 0,
        rejectVotes: 0,
      });
    }
    expect((await db.listTransactions({ status: "ROLLED_BACK" })).map((tx) => tx.status))
      .toEqual(["ROLLED_BACK"]);
    expect((await db.listTransactions({ status: "FAILED" })).map((tx) => tx.status))
      .toEqual(["FAILED"]);
    expect(await db.countTransactions()).toBeGreaterThanOrEqual(4);
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

    await db.recordVote({ txId: "0xabc123", listenerId: "B", vote: "REJECT", votedAt: Date.now() });
    await db.recordVote({ txId: "0xabc123", listenerId: "C", vote: "APPROVE", votedAt: Date.now() });
    expect((await db.getTransaction("0xabc123"))?.approveVotes).toBe(2);
    expect((await db.getTransaction("0xabc123"))?.rejectVotes).toBe(1);

    // Replacing a listener's vote must update the derived aggregate.
    await db.recordVote({ txId: "0xabc123", listenerId: "A", vote: "REJECT", votedAt: Date.now() });
    const updated = await db.getTransaction("0xabc123");
    expect(updated?.approveVotes).toBe(1);
    expect(updated?.rejectVotes).toBe(2);
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
    expect(await db.transitionStatus("0xabc123", ["PENDING"], "APPROVED")).toBe(true);
    expect(await db.updateTransactionStatus("0xabc123", "EXECUTED", { destTxHash: "0xSIM" }, ["APPROVED"])).toBe(true);
    const tx = await db.getTransaction("0xabc123");
    expect(tx?.status).toBe("EXECUTED");
    expect(tx?.destTxHash).toBe("0xSIM");
    expect(await db.updateTransactionStatus("0xabc123", "FAILED", { errorMessage: "late failure" }, ["EXECUTING"])).toBe(false);
    expect((await db.getTransaction("0xabc123"))?.status).toBe("EXECUTED");
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

  it("allows at most one concurrent APPROVED -> EXECUTING claim", async () => {
    await db.upsertTransaction({
      txId: "0xconcurrent", sender: "0xS", destinationChainId: "0xd", destinationAddress: "0xa",
      payload: "0x01", nonce: "1", sourceTimestamp: 1, sourceBlockNumber: 1,
      status: "APPROVED", createdAt: Date.now(), updatedAt: Date.now(), approveVotes: 3, rejectVotes: 0,
    });
    const results = await Promise.all([
      db.transitionStatus("0xconcurrent", ["APPROVED"], "EXECUTING"),
      db.transitionStatus("0xconcurrent", ["APPROVED"], "EXECUTING"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await db.getTransaction("0xconcurrent"))?.status).toBe("EXECUTING");
  });

  it("reports the latest updated_at", async () => {
    expect(await db.getLastUpdatedAt()).toBeGreaterThan(0);
  });

  it("persists a monotonic listener cursor", async () => {
    expect(await db.getListenerCursor("A")).toBeNull();
    expect(await db.advanceListenerCursor("A", 42)).toBe(true);
    expect(await db.getListenerCursor("A")).toBe(42);
    expect(await db.advanceListenerCursor("A", 41)).toBe(false);
    expect(await db.getListenerCursor("A")).toBe(42);
    await db.resetListenerCursor("A");
    expect(await db.getListenerCursor("A")).toBeNull();
  });
});
