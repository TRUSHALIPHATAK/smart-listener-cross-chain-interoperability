import { ethers } from "ethers";
import { DbAdapter } from "./db";
import {
  DELTA_A_SECONDS,
  DESTINATION_TYPE,
  OWNER_MNEMONIC,
  SOURCE_RPC_URL,
  SENDER_CONTRACT_ADDRESS,
} from "./config";
import { CrossChainTransaction } from "./types";
import { childLogger } from "./logger";

const log = childLogger("settlement");

const SOURCE_ABI = [
  "function txSenders(bytes32) view returns (address)",
  "function txFinalized(bytes32) view returns (bool)",
  "function txRefunded(bytes32) view returns (bool)",
  "function txRolledBack(bytes32) view returns (bool)",
  "function rollbackTransaction(bytes32)",
];

export interface SourceEscrowState {
  sender: string;
  finalized: boolean;
  refunded: boolean;
  rolledBack: boolean;
}

export async function getSourceEscrowState(txId: string): Promise<SourceEscrowState> {
  const provider = new ethers.JsonRpcProvider(SOURCE_RPC_URL);
  const source = new ethers.Contract(SENDER_CONTRACT_ADDRESS, SOURCE_ABI, provider);
  return {
    sender: String(await source.txSenders(txId)),
    finalized: Boolean(await source.txFinalized(txId)),
    refunded: Boolean(await source.txRefunded(txId)),
    rolledBack: Boolean(await source.txRolledBack(txId)),
  };
}

/**
 * Reclaim a timed-out source escrow only after the configured backup window.
 * The source contract is the final authority; the DB transition is conditional
 * so concurrent listeners cannot overwrite a terminal state.
 */
export async function rollbackTimedOutTransaction(
  db: DbAdapter,
  tx: CrossChainTransaction,
): Promise<boolean> {
  if (tx.status !== "TIMED_OUT") return false;

  if (tx.transferMode !== "ETH_TRANSFER") {
    return db.transitionStatus(tx.txId, ["TIMED_OUT"], "ROLLED_BACK", {
      errorMessage: "Destination did not confirm before the settlement window",
    });
  }

  const state = await getSourceEscrowState(tx.txId);
  if (state.finalized) {
    log.warn({ txId: tx.txId }, "Source escrow is finalized; refusing rollback");
    return false;
  }
  if (state.refunded || state.rolledBack) {
    return db.transitionStatus(tx.txId, ["TIMED_OUT"], "ROLLED_BACK", {
      errorMessage: state.refunded
        ? "Source escrow was refunded after destination reconciliation"
        : "Source escrow was already rolled back",
    });
  }
  if (state.sender === ethers.ZeroAddress) {
    throw new Error(`Source escrow for ${tx.txId} has no sender but is not finalized/refunded`);
  }

  const provider = new ethers.JsonRpcProvider(SOURCE_RPC_URL);
  const wallet = ethers.HDNodeWallet.fromPhrase(OWNER_MNEMONIC).connect(provider);
  const source = new ethers.Contract(
    SENDER_CONTRACT_ADDRESS,
    SOURCE_ABI,
    new ethers.NonceManager(wallet),
  );
  const response = await source.rollbackTransaction(tx.txId);
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Source rollback transaction did not succeed for ${tx.txId}`);
  }

  return db.transitionStatus(tx.txId, ["TIMED_OUT"], "ROLLED_BACK", {
    rollbackTxHash: receipt.hash,
    errorMessage: `Rolled back after ${DELTA_A_SECONDS}s settlement window`,
  });
}

export function settlementCutoffMs(): number {
  return DELTA_A_SECONDS * 1000;
}

export const settlementDestinationType = DESTINATION_TYPE;
