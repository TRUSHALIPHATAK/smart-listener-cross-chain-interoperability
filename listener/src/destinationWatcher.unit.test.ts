/**
 * Unit tests for handleCompleted (Step 2 completion confirmation).
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ethers } from "ethers";
import type { DbAdapter } from "./db";
import type { CrossChainTransaction } from "./types";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-watch-"));
let db: DbAdapter;
let closeDb: () => Promise<void>;
let handleCompleted: typeof import("./destinationWatcher").handleCompleted;

const baseTx = (txId: string, status: CrossChainTransaction["status"]): CrossChainTransaction => ({
  txId,
  sender: "0xS",
  destinationChainId: ethers.encodeBytes32String("simulated-evm-chain"),
  destinationAddress: ethers.ZeroAddress,
  payload: "0x01",
  nonce: "1", sourceTimestamp: 1, sourceBlockNumber: 1, status,
  createdAt: Date.now(), updatedAt: Date.now(), approveVotes: 0, rejectVotes: 0,
});
const validCompletion = (txId: string) => ({
  txId,
  destTxHash: "0xhash",
  payloadHash: ethers.keccak256("0x01"),
  recipient: ethers.ZeroAddress,
  amountWei: "0",
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
    expect(await handleCompleted(db, { ...validCompletion("0xa1"), destTxHash: "0xhash1" })).toBe("confirmed");
    const tx = await db.getTransaction("0xa1");
    expect(tx?.status).toBe("EXECUTED");
    expect(tx?.destTxHash).toBe("0xhash1");
  });

  it("is idempotent: a second event for the same tx is ignored", async () => {
    expect(await handleCompleted(db, { ...validCompletion("0xa1"), destTxHash: "0xhash1" })).toBe("ignored");
  });

  it("reconciles a completion after timeout before rollback", async () => {
    await db.upsertTransaction(baseTx("0xa2", "TIMED_OUT"));
    expect(await handleCompleted(db, { ...validCompletion("0xa2"), destTxHash: "0xhash2" })).toBe("confirmed");
    expect((await db.getTransaction("0xa2"))?.status).toBe("EXECUTED");
  });

  it("ignores events for unknown transactions", async () => {
    expect(await handleCompleted(db, { ...validCompletion("0xunknown"), txId: "0xunknown", destTxHash: "0xh" })).toBe("ignored");
  });

  it("does not execute a tx that has not been approved", async () => {
    await db.upsertTransaction(baseTx("0xa3", "PENDING"));
    expect(await handleCompleted(db, { ...validCompletion("0xa3"), destTxHash: "0xh3" })).toBe("ignored");
    expect((await db.getTransaction("0xa3"))?.status).toBe("PENDING");
  });

  it("rejects a completion with the wrong payload hash", async () => {
    await db.upsertTransaction(baseTx("0xa4", "EXECUTING"));
    expect(await handleCompleted(db, {
      ...validCompletion("0xa4"),
      payloadHash: ethers.keccak256("0xbeef"),
    })).toBe("invalid");
    expect((await db.getTransaction("0xa4"))?.status).toBe("EXECUTING");
  });

  it("does not overwrite a rolled-back transaction on a late completion", async () => {
    await db.upsertTransaction(baseTx("0xa5", "ROLLED_BACK"));
    expect(await handleCompleted(db, validCompletion("0xa5"))).toBe("late");
    expect((await db.getTransaction("0xa5"))?.status).toBe("ROLLED_BACK");
  });
});
