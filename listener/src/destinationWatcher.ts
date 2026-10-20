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
import { DEST_CHAIN_ID, DEST_RPC_URL, DESTINATION_RECEIVER_ADDRESS, DESTINATION_ROUTE_ID, POLL_INTERVAL_MS, SOURCE_RPC_URL, SENDER_CONTRACT_ADDRESS, OWNER_MNEMONIC } from "./config";

const log = childLogger("destinationWatcher");

const ABI = [
  "event InterChainCompleted(bytes32 indexed sourceTxId, address indexed executor, bytes32 payloadHash, uint256 timestamp, address recipient, uint256 amount)",
];
const SOURCE_ABI = [
  "function txSenders(bytes32) view returns (address)",
  "function txFinalized(bytes32) view returns (bool)",
  "function txRefunded(bytes32) view returns (bool)",
  "function txRolledBack(bytes32) view returns (bool)",
  "function finalizeTransaction(bytes32 txId)",
];

export type CompletionOutcome = "confirmed" | "late" | "ignored" | "invalid";

export interface CompletionEvent {
  txId: string;
  destTxHash: string;
  payloadHash: string;
  recipient: string;
  amountWei: string;
  blockNumber?: number;
}

function expectedRouteId(): string {
  return ethers.encodeBytes32String(DESTINATION_ROUTE_ID.slice(0, 31));
}

function isExpectedRecipient(tx: Awaited<ReturnType<DbAdapter["getTransaction"]>>, recipient: string): boolean {
  if (!tx || tx.transferMode !== "ETH_TRANSFER") return recipient === ethers.ZeroAddress;
  if (!ethers.isHexString(tx.destinationAddress, 20)) return false;
  return ethers.getAddress(tx.destinationAddress) === ethers.getAddress(recipient);
}

async function finalizeSourceEscrow(tx: NonNullable<Awaited<ReturnType<DbAdapter["getTransaction"]>>>): Promise<void> {
  if (tx.transferMode !== "ETH_TRANSFER") return;
  const provider = new ethers.JsonRpcProvider(SOURCE_RPC_URL);
  const read = new ethers.Contract(SENDER_CONTRACT_ADDRESS, SOURCE_ABI, provider);
  if (Boolean(await read.txFinalized(tx.txId)) || Boolean(await read.txRefunded(tx.txId)) || Boolean(await read.txRolledBack(tx.txId))) {
    return;
  }
  if (String(await read.txSenders(tx.txId)) === ethers.ZeroAddress) return;
  const wallet = ethers.HDNodeWallet.fromPhrase(OWNER_MNEMONIC).connect(provider);
  const source = new ethers.Contract(SENDER_CONTRACT_ADDRESS, SOURCE_ABI, new ethers.NonceManager(wallet));
  const finalization = await source.finalizeTransaction(tx.txId);
  const receipt = await finalization.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`Source finalization failed for ${tx.txId}`);
}

/**
 * Apply one InterChainCompleted event to the DB.
 *  - confirmed: APPROVED/EXECUTING -> EXECUTED (this call did it)
 *  - late:      the tx had already TIMED_OUT (destination completed after the window;
 *               this is exactly the case rollback handles in Step 3)
 *  - ignored:   unknown tx, or already in some other state
 */
export async function handleCompleted(
  db: DbAdapter,
  completion: CompletionEvent,
): Promise<CompletionOutcome> {
  const { txId, destTxHash, amountWei } = completion;
  const tx = await db.getTransaction(txId);
  if (!tx) return "ignored";
  if (
    completion.payloadHash !== ethers.keccak256(tx.payload) ||
    !isExpectedRecipient(tx, completion.recipient) ||
    (tx.transferMode === "ETH_TRANSFER"
      ? amountWei !== (tx.requestedAmountWei ?? "0")
      : amountWei !== "0") ||
    (tx.destinationChainId !== expectedRouteId())
  ) {
    log.warn({ txId, destTxHash }, "Ignoring destination completion with mismatched transaction data");
    return "invalid";
  }

  const changed = await db.transitionStatus(txId, ["APPROVED", "EXECUTING", "TIMED_OUT"], "EXECUTED", {
    destTxHash,
    destinationConfirmation: true,
    transferredAmountWei: amountWei !== "0" ? amountWei : undefined,
  });
  if (changed || tx.status === "EXECUTED") {
    try {
      await finalizeSourceEscrow(tx);
    } catch (err) {
      log.warn({ txId, err }, "Destination confirmed but source escrow finalization failed");
    }
  }
  if (changed) return "confirmed";
  const current = await db.getTransaction(txId);
  if (!current) return "ignored";
  if (current.status === "ROLLED_BACK") return "late";
  if (current.status === "TIMED_OUT") return "late";
  if (current.status === "EXECUTED") return "ignored";
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

  async reconcile(txId: string): Promise<CompletionOutcome> {
    const { provider, contract } = this.ensure();
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== DEST_CHAIN_ID) {
      throw new Error(`Destination RPC chain ID ${network.chainId} does not match configured ${DEST_CHAIN_ID}`);
    }
    const latest = await provider.getBlockNumber();
    const logs = await contract.queryFilter(contract.filters.InterChainCompleted(txId), 0, latest);
    for (const entry of logs) {
      if (!("args" in entry)) continue;
      const receipt = await provider.getTransactionReceipt(entry.transactionHash);
      if (!receipt || receipt.status !== 1 || entry.address.toLowerCase() !== DESTINATION_RECEIVER_ADDRESS.toLowerCase()) {
        continue;
      }
      return handleCompleted(this.db, {
        txId: String(entry.args[0]),
        destTxHash: entry.transactionHash,
        payloadHash: String(entry.args[2]),
        recipient: String(entry.args[4]),
        amountWei: String(entry.args[5]),
        blockNumber: entry.blockNumber,
      });
    }
    return "ignored";
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
          const receipt = await provider.getTransactionReceipt(entry.transactionHash);
          if (!receipt || receipt.status !== 1 || entry.address.toLowerCase() !== DESTINATION_RECEIVER_ADDRESS.toLowerCase()) continue;
          const outcome = await handleCompleted(this.db, {
            txId,
            destTxHash: entry.transactionHash,
            payloadHash: String(entry.args[2]),
            recipient: String(entry.args[4]),
            amountWei: String(entry.args[5]),
            blockNumber: entry.blockNumber,
          });
          if (outcome === "confirmed") {
            log.info({ txId, destTxHash: entry.transactionHash, block: entry.blockNumber }, "InterChainCompleted seen - transaction EXECUTED");
          } else if (outcome === "late" || outcome === "invalid") {
            log.warn({ txId, destTxHash: entry.transactionHash, outcome }, "Destination completion was not applied to the current settlement state");
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
