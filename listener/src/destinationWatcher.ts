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
import { DEST_CHAIN_ID, DEST_RPC_URL, DESTINATION_RECEIVER_ADDRESS, POLL_INTERVAL_MS, SOURCE_RPC_URL, SENDER_CONTRACT_ADDRESS, OWNER_MNEMONIC } from "./config";

const log = childLogger("destinationWatcher");

const ABI = [
  "event InterChainCompleted(bytes32 indexed sourceTxId, address indexed executor, bytes32 payloadHash, uint256 timestamp, address recipient, uint256 amount)",
];
const SOURCE_ABI = ["function finalizeTransaction(bytes32 txId)"];

export type CompletionOutcome = "confirmed" | "late" | "ignored";

/**
 * Apply one InterChainCompleted event to the DB.
 *  - confirmed: APPROVED/EXECUTING -> EXECUTED (this call did it)
 *  - late:      the tx had already TIMED_OUT (destination completed after the window;
 *               this is exactly the case rollback handles in Step 3)
 *  - ignored:   unknown tx, or already in some other state
 */
export async function handleCompleted(
  db: DbAdapter,
  txId: string,
  destTxHash: string,
  amountWei = "0",
): Promise<CompletionOutcome> {
  const tx = await db.getTransaction(txId);
  const changed = await db.transitionStatus(txId, ["APPROVED", "EXECUTING"], "EXECUTED", {
    destTxHash,
    destinationConfirmation: true,
    transferredAmountWei: amountWei !== "0" ? amountWei : undefined,
  });
  if (changed && tx?.transferMode === "ETH_TRANSFER") {
    try {
      const provider = new ethers.JsonRpcProvider(SOURCE_RPC_URL);
      const wallet = ethers.HDNodeWallet.fromPhrase(OWNER_MNEMONIC).connect(provider);
      const source = new ethers.Contract(SENDER_CONTRACT_ADDRESS, SOURCE_ABI, new ethers.NonceManager(wallet));
      const finalization = await source.finalizeTransaction(txId);
      await finalization.wait();
    } catch (err) {
      log.warn({ txId, err }, "Destination confirmed but source escrow finalization failed");
    }
  }
  if (changed) return "confirmed";
  const current = await db.getTransaction(txId);
  if (!current) return "ignored";
  if (current.status === "TIMED_OUT") return "late";
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
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== DEST_CHAIN_ID) {
        throw new Error(`Destination RPC chain ID ${network.chainId} does not match configured ${DEST_CHAIN_ID}`);
      }
      if (await provider.getCode(DESTINATION_RECEIVER_ADDRESS) === "0x") {
        throw new Error(`No contract code at DestinationReceiver ${DESTINATION_RECEIVER_ADDRESS} on destination chain ${DEST_CHAIN_ID}`);
      }
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
          const amount = "args" in entry ? String(entry.args[5] ?? 0) : "0";
          const outcome = await handleCompleted(this.db, txId, entry.transactionHash, amount);
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
