/**
 * Unit tests for handleCompleted (Step 2 completion confirmation).
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { DbAdapter } from "./db";
import type { CrossChainTransaction } from "./types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-watch-"));
let db: DbAdapter;
let closeDb: () => Promise<void>;
let handleCompleted: typeof import("./destinationWatcher").handleCompleted;

const baseTx = (txId: string, status: CrossChainTransaction["status"]): CrossChainTransaction => ({
  txId, sender: "0xS", destinationChainId: "0xd", destinationAddress: "0xa", payload: "0x01",
  nonce: "1", sourceTimestamp: 1, sourceBlockNumber: 1, status,
  createdAt: Date.now(), updatedAt: Date.now(), approveVotes: 0, rejectVotes: 0,
});

beforeAll(async () => {
  process.env.SQLITE_PATH = path.join(tmpDir, "test.db");
  delete process.env.DATABASE_URL;
  jest.resetModules();
  const dbMod = await import("./db");
  db = await dbMod.getDb();
  closeDb = dbMod.closeDb;
  handleCompleted = (await import("./destinationWatcher")).handleCompleted;
});

afterAll(async () => {
  if (closeDb) await closeDb();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("handleCompleted", () => {
  it("EXECUTING -> EXECUTED with the real destination hash", async () => {
    await db.upsertTransaction(baseTx("0xa1", "EXECUTING"));
    expect(await handleCompleted(db, "0xa1", "0xhash1")).toBe("confirmed");
    const tx = await db.getTransaction("0xa1");
    expect(tx?.status).toBe("EXECUTED");
    expect(tx?.destTxHash).toBe("0xhash1");
  });

  it("is idempotent: a second event for the same tx is ignored", async () => {
    expect(await handleCompleted(db, "0xa1", "0xhash1")).toBe("ignored");
  });

  it("reports 'late' when the tx already TIMED_OUT (needs rollback in Step 3)", async () => {
    await db.upsertTransaction(baseTx("0xa2", "TIMED_OUT"));
    expect(await handleCompleted(db, "0xa2", "0xhash2")).toBe("late");
    expect((await db.getTransaction("0xa2"))?.status).toBe("TIMED_OUT");
  });

  it("ignores events for unknown transactions", async () => {
    expect(await handleCompleted(db, "0xunknown", "0xh")).toBe("ignored");
  });

  it("does not execute a tx that has not been approved", async () => {
    await db.upsertTransaction(baseTx("0xa3", "PENDING"));
    expect(await handleCompleted(db, "0xa3", "0xh3")).toBe("ignored");
    expect((await db.getTransaction("0xa3"))?.status).toBe("PENDING");
  });
});
