/**
 * executor.ts — Destination execution engine with retry and failure recovery
 *
 * Triggered by the consensus module when a transaction reaches 2-of-3 approvals.
 * Implements:
 *   - Duplicate-execution prevention (idempotency check before execution)
 *   - Exponential backoff retries
 *   - Timeout handling
 *   - Structured logging of all state transitions
 */

import { CrossChainTransaction, DestinationResult } from "./types";
import { DbAdapter } from "./db";
import { simulatedExecute } from "./destinationAdapter/simulatedAdapter";
import { fabricExecute } from "./destinationAdapter/fabricAdapter";
import { evmExecute } from "./destinationAdapter/evmDestinationAdapter";
import { sepoliaEscrowExecute } from "./sourceAdapter/sepoliaEscrowAdapter";
import { childLogger } from "./logger";
import { DESTINATION_ROUTE_ID, DESTINATION_TYPE, MAX_RETRIES, RETRY_BACKOFF_MS, SOURCE_MODE } from "./config";
import { ethers } from "ethers";

const log = childLogger("executor");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Execute an approved cross-chain transaction with retry logic.
 * Updates DB state at each transition: EXECUTING → EXECUTED | FAILED
 */
export async function executeTransaction(
  tx: CrossChainTransaction,
  db: DbAdapter
): Promise<void> {
  // ── Atomic claim: only one executor may move APPROVED -> EXECUTING ─────────
  const claimed = await db.transitionStatus(tx.txId, ["APPROVED"], "EXECUTING");
  if (!claimed) {
    log.warn({ txId: tx.txId }, "Could not claim transaction (not APPROVED any more) — skipping duplicate execution");
    return;
  }
  log.info({ txId: tx.txId, destination: DESTINATION_TYPE }, "Beginning execution");

  if (
    SOURCE_MODE !== "sepolia" &&
    DESTINATION_TYPE === "evm" &&
    tx.destinationChainId !== ethers.encodeBytes32String(DESTINATION_ROUTE_ID.slice(0, 31))
  ) {
    await db.transitionStatus(tx.txId, ["EXECUTING"], "FAILED", {
      errorMessage: `Unsupported destination route: ${tx.destinationChainId}`,
    });
    log.error({ txId: tx.txId, destinationChainId: tx.destinationChainId }, "No destination route configured");
    return;
  }

  // ── Select destination adapter ─────────────────────────────────────────────
  const executeFn =
    SOURCE_MODE === "sepolia" ? (current: CrossChainTransaction) => sepoliaEscrowExecute(current) :
    DESTINATION_TYPE === "fabric" ? fabricExecute :
    DESTINATION_TYPE === "evm"    ? evmExecute    :
    simulatedExecute;

  // ── Retry loop ─────────────────────────────────────────────────────────────
  let lastResult: DestinationResult = { success: false };
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    log.info({ txId: tx.txId, attempt, maxRetries: MAX_RETRIES }, "Execution attempt");
    try {
      lastResult = await executeFn(tx);
      if (lastResult.success) break;
    } catch (err) {
      lastResult = { success: false, errorMessage: String(err) };
      log.warn({ txId: tx.txId, attempt, err }, "Execution attempt threw");
    }

    if (attempt < MAX_RETRIES) {
      const backoff = RETRY_BACKOFF_MS * Math.pow(2, attempt - 1);
      log.info({ txId: tx.txId, backoffMs: backoff }, "Backing off before retry");
      await sleep(backoff);
    }
  }

  // ── Update final state ─────────────────────────────────────────────────────
  if (lastResult.success && DESTINATION_TYPE === "evm" && SOURCE_MODE !== "sepolia") {
    // Step 2: the destination tx is mined, but EXECUTED is only set once the
    // DestinationWatcher sees the Receiver's InterChainCompleted event.
    await db.transitionStatus(tx.txId, ["EXECUTING"], "EXECUTING", {
      destTxHash: lastResult.destTxHash,
      transferredAmountWei: lastResult.transferredAmountWei,
    });
    log.info(
      { txId: tx.txId, destTxHash: lastResult.destTxHash },
      "Destination tx mined - awaiting InterChainCompleted confirmation"
    );
    return;
  }

  if (lastResult.success) {
    const ok = await db.transitionStatus(tx.txId, ["EXECUTING"], "EXECUTED", {
      destTxHash: lastResult.destTxHash,
      transferredAmountWei: lastResult.transferredAmountWei,
    });
    if (!ok) log.warn({ txId: tx.txId }, "Executed on destination but status was changed meanwhile (e.g. timed out)");
    log.info(
      { txId: tx.txId, destTxHash: lastResult.destTxHash, latencyMs: lastResult.latencyMs },
      "Transaction EXECUTED successfully"
    );
  } else {
    await db.transitionStatus(tx.txId, ["EXECUTING"], "FAILED", {
      errorMessage: lastResult.errorMessage ?? "Unknown error after all retries",
    });
    log.error(
      { txId: tx.txId, error: lastResult.errorMessage },
      "Transaction FAILED after all retries"
    );
  }
}
