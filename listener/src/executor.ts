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
import { childLogger } from "./logger";
import { DESTINATION_TYPE, MAX_RETRIES, RETRY_BACKOFF_MS } from "./config";

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
  // ── Idempotency guard ──────────────────────────────────────────────────────
  const current = await db.getTransaction(tx.txId);
  if (!current) {
    log.error({ txId: tx.txId }, "Transaction not found in DB — cannot execute");
    return;
  }
  if (current.status === "EXECUTED") {
    log.warn({ txId: tx.txId }, "Transaction already EXECUTED — skipping (duplicate prevention)");
    return;
  }
  if (current.status === "FAILED" || current.status === "TIMED_OUT" || current.status === "REJECTED") {
    log.warn({ txId: tx.txId, status: current.status }, "Transaction in terminal state — skipping");
    return;
  }

  // ── Mark EXECUTING ─────────────────────────────────────────────────────────
  await db.updateTransactionStatus(tx.txId, "EXECUTING");
  log.info({ txId: tx.txId, destination: DESTINATION_TYPE }, "Beginning execution");

  // ── Select destination adapter ─────────────────────────────────────────────
  const executeFn = DESTINATION_TYPE === "fabric" ? fabricExecute : simulatedExecute;

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
  if (lastResult.success) {
    await db.updateTransactionStatus(tx.txId, "EXECUTED", {
      destTxHash: lastResult.destTxHash,
    });
    log.info(
      { txId: tx.txId, destTxHash: lastResult.destTxHash, latencyMs: lastResult.latencyMs },
      "Transaction EXECUTED successfully"
    );
  } else {
    await db.updateTransactionStatus(tx.txId, "FAILED", {
      errorMessage: lastResult.errorMessage ?? "Unknown error after all retries",
    });
    log.error(
      { txId: tx.txId, error: lastResult.errorMessage },
      "Transaction FAILED after all retries"
    );
  }
}
