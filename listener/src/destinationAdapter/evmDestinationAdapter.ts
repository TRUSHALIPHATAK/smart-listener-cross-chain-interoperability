/**
 * evmDestinationAdapter.ts — REAL EVM destination adapter (Step 1)
 *
 * Sends an actual transaction to DestinationReceiver on the destination chain.
 * Each Listener signs with its own account (Hardhat account #1..#4 for A..D) so
 * parallel listeners never collide on a nonce.
 */

import { ethers } from "ethers";
import { CrossChainTransaction, DestinationResult, LISTENER_IDS } from "../types";
import { childLogger } from "../logger";
import {
  DEST_RPC_URL,
  DESTINATION_RECEIVER_ADDRESS,
  EXECUTOR_MNEMONIC,
  LISTENER_ID,
} from "../config";

const log = childLogger("evmDestinationAdapter");

const RECEIVER_ABI = [
  "function execute(bytes32 sourceTxId, bytes payload)",
  "function executeValue(bytes32 sourceTxId, address recipient, bytes payload, uint256 amount)",
  "function wasExecuted(bytes32 txId) view returns (bool)",
  "event InterChainCompleted(bytes32 indexed sourceTxId, address indexed executor, bytes32 payloadHash, uint256 timestamp)",
];

let receiver: ethers.Contract | null = null;

function getReceiver(): ethers.Contract {
  if (receiver) return receiver;
  if (!DESTINATION_RECEIVER_ADDRESS) {
    throw new Error("DestinationReceiver address missing. Run: npx hardhat run scripts/deployDestination.ts --network destination");
  }
  const provider = new ethers.JsonRpcProvider(DEST_RPC_URL);
  const index = LISTENER_IDS.indexOf(LISTENER_ID) + 1; // A->#1, B->#2, C->#3, D->#4
  const hd = ethers.HDNodeWallet.fromPhrase(EXECUTOR_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
  const signer = new ethers.NonceManager(hd.connect(provider));
  log.info({ executor: hd.address, destRpc: DEST_RPC_URL, receiver: DESTINATION_RECEIVER_ADDRESS }, "EVM destination ready");
  receiver = new ethers.Contract(DESTINATION_RECEIVER_ADDRESS, RECEIVER_ABI, signer);
  return receiver;
}

function toHexBytes(payload: string): string {
  return ethers.isHexString(payload) ? payload : ethers.hexlify(ethers.toUtf8Bytes(payload));
}

export async function evmExecute(tx: CrossChainTransaction): Promise<DestinationResult> {
  const start = Date.now();
  try {
    const c = getReceiver();

    // Idempotent retry: if an earlier attempt already landed, return its real hash.
    if (await c.wasExecuted(tx.txId)) {
      const logs = await c.queryFilter(c.filters.InterChainCompleted(tx.txId));
      const hash = logs.length > 0 ? logs[0].transactionHash : undefined;
      log.info({ txId: tx.txId, destTxHash: hash }, "Already executed on destination");
      return { success: true, destTxHash: hash, latencyMs: Date.now() - start };
    }

    let response;
    if (tx.transferMode === "ETH_TRANSFER") {
      if (!ethers.isHexString(tx.destinationAddress, 20)) {
        return { success: false, errorMessage: "ETH destination address is not a 20-byte EVM address" };
      }
      const recipient = ethers.getAddress(tx.destinationAddress);
      response = await c.executeValue(tx.txId, recipient, toHexBytes(tx.payload), tx.requestedAmountWei ?? "0");
    } else {
      response = await c.execute(tx.txId, toHexBytes(tx.payload));
    }
    const receipt = await response.wait();
    if (!receipt || receipt.status !== 1) {
      return { success: false, errorMessage: "Destination transaction reverted" };
    }
    const latencyMs = Date.now() - start;
    log.info({ txId: tx.txId, destTxHash: receipt.hash, latencyMs }, "Executed on destination chain");
    return {
      success: true,
      destTxHash: receipt.hash,
      latencyMs,
      transferredAmountWei: tx.transferMode === "ETH_TRANSFER" ? (tx.requestedAmountWei ?? "0") : undefined,
    };
  } catch (err) {
    const msg = (err as { shortMessage?: string }).shortMessage ?? (err as Error).message;
    log.warn({ txId: tx.txId, msg }, "EVM destination execution failed");
    return { success: false, errorMessage: `EVM destination error: ${msg}` };
  }
}
