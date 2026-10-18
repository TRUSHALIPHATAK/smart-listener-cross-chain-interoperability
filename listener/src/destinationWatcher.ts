/**
 * destinationWatcher.ts — Step 2: close the loop.
 *
 * Watches the DESTINATION chain for the Receiver's InterChainCompleted event.
 * A transaction becomes EXECUTED only when this event is actually seen — not
 * because the executor said "success". Every listener runs a watcher; the
 * atomic transition makes duplicate confirmations harmless.
 */

import { ethers } from "ethers";
import { DbAdapter } from "./db";
import { childLogger } from "./logger";
import { DEST_RPC_URL, DESTINATION_RECEIVER_ADDRESS, POLL_INTERVAL_MS } from "./config";

const log = childLogger("destinationWatcher");

const ABI = [
  "event InterChainCompleted(bytes32 indexed sourceTxId, address indexed executor, bytes32 payloadHash, uint256 timestamp)",
];

export type CompletionOutcome = "confirmed" | "late" | "ignored";

/**
 * Apply one InterChainCompleted event to the DB.
 *  - confirmed: APPROVED/EXECUTING -> EXECUTED (this call did it)
 *  - late:      the tx had already TIMED_OUT (destination completed after the window;
 *               this is exactly the case rollback handles in Step 3)
 *  - ignored:   unknown tx, or already in some other state
 */
export async function handleCompleted(db: DbAdapter, txId: string, destTxHash: string): Promise<CompletionOutcome> {
  const changed = await db.transitionStatus(txId, ["APPROVED", "EXECUTING"], "EXECUTED", { destTxHash });
  if (changed) return "confirmed";
  const tx = await db.getTransaction(txId);
  if (!tx) return "ignored";
  if (tx.status === "TIMED_OUT") return "late";
  return "ignored";
}

export class DestinationWatcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastBlock = -1;
  private provider: ethers.JsonRpcProvider | null = null;
  private contract: ethers.Contract | null = null;

  constructor(private readonly db: DbAdapter) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    void this.tick();
    log.info({ destRpc: DEST_RPC_URL, receiver: DESTINATION_RECEIVER_ADDRESS }, "Destination watcher started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getLastBlock(): number {
    return this.lastBlock;
  }

  private ensure(): { provider: ethers.JsonRpcProvider; contract: ethers.Contract } {
    if (!this.provider || !this.contract) {
      if (!DESTINATION_RECEIVER_ADDRESS) {
        throw new Error("DestinationReceiver address missing - run scripts/deployDestination.ts");
      }
      this.provider = new ethers.JsonRpcProvider(DEST_RPC_URL);
      this.contract = new ethers.Contract(DESTINATION_RECEIVER_ADDRESS, ABI, this.provider);
    }
    return { provider: this.provider, contract: this.contract };
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const { provider, contract } = this.ensure();
      const latest = await provider.getBlockNumber();

      // Destination chain was reset (fresh node): rescan from genesis.
      if (latest < this.lastBlock) this.lastBlock = -1;

      let from = this.lastBlock + 1;
      while (from <= latest) {
        const to = Math.min(from + 1999, latest);
        const logs = await contract.queryFilter(contract.filters.InterChainCompleted(), from, to);
        for (const entry of logs) {
          if (!("args" in entry)) continue;
          const txId = String(entry.args[0]);
          const outcome = await handleCompleted(this.db, txId, entry.transactionHash);
          if (outcome === "confirmed") {
            log.info({ txId, destTxHash: entry.transactionHash, block: entry.blockNumber }, "InterChainCompleted seen - transaction EXECUTED");
          } else if (outcome === "late") {
            log.warn({ txId, destTxHash: entry.transactionHash }, "Destination completed AFTER timeout - source/destination diverged (needs rollback)");
          }
        }
        this.lastBlock = to;
        from = to + 1;
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, "Destination watcher tick failed");
    } finally {
      this.busy = false;
    }
  }
}
