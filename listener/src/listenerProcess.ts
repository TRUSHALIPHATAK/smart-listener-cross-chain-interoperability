/**
 * listenerProcess.ts — Main entry point for each Smart Listener process
 *
 * Run four instances with different LISTENER_ID env vars (A, B, C, D).
 * Each instance independently:
 *   1. Connects to the source EVM chain
 *   2. Monitors TransactionSent events
 *   3. Validates each transaction
 *   4. Records a vote in the shared DB
 *   5. If the majority threshold (default 3-of-4) is met AND this listener wins the atomic APPROVED claim,
 *      triggers the executor
 *   6. Runs timeout sweeper on a schedule
 *   7. Emits heartbeat to DB
 */

import { getDb, closeDb } from "./db";
import { EvmSourceAdapter } from "./sourceAdapter/evmAdapter";
import { evaluateConsensus, validateVote } from "./consensus";
import { executeTransaction } from "./executor";
import { childLogger } from "./logger";
import { printConfig, DESTINATION_TYPE } from "./config";
import { DestinationWatcher } from "./destinationWatcher";
import {
  LISTENER_ID, REQUIRED_VOTES, TOTAL_LISTENERS, TX_TIMEOUT_MS,
  POLL_INTERVAL_MS,
} from "./config";
import { CrossChainTransaction, TransactionEvent, ListenerVote } from "./types";

const log = childLogger("listenerProcess");

// ── Validation ────────────────────────────────────────────────────────────────

function validateTransactionEvent(event: TransactionEvent): { valid: boolean; reason?: string } {
  if (!event.txId || !event.txId.startsWith("0x")) {
    return { valid: false, reason: "Invalid txId format" };
  }
  if (!event.destinationChainId || event.destinationChainId === "0x" + "00".repeat(32)) {
    return { valid: false, reason: "Zero destination chain ID" };
  }
  if (!event.destinationAddress || event.destinationAddress === "0x") {
    return { valid: false, reason: "Empty destination address" };
  }
  if (!event.payload || event.payload === "0x") {
    return { valid: false, reason: "Empty payload" };
  }
  if (event.timestamp <= 0n) {
    return { valid: false, reason: "Invalid timestamp" };
  }

  // ── Rejection test support ────────────────────────────────────────────────
  // Any payload whose UTF-8 decoded form starts with "REJECT:" causes all
  // Listeners to cast a REJECT vote, so the tx ends up REJECTED by consensus.
  // This is intentional test behaviour — not a production security rule.
  try {
    const payloadHex = event.payload.startsWith("0x") ? event.payload.slice(2) : event.payload;
    const decoded = Buffer.from(payloadHex, "hex").toString("utf8");
    if (decoded.startsWith("REJECT:")) {
      return { valid: false, reason: `Test rejection triggered by payload prefix: ${decoded.slice(0, 40)}` };
    }
  } catch {
    // If decoding fails, leave validation to pass (the payload is binary, not a REJECT test)
  }

  return { valid: true };
}


// ── Main Process ──────────────────────────────────────────────────────────────

async function main() {
  printConfig();
  log.info({ listenerId: LISTENER_ID }, "Smart Listener starting up");

  const db = await getDb();
  const sourceAdapter = new EvmSourceAdapter();

  let connected = false;
  let reconnectAttempts = 0;

  const connect = async () => {
    try {
      await sourceAdapter.connect();
      connected = true;
      reconnectAttempts = 0;
      log.info("Source chain connected");
    } catch (err) {
      connected = false;
      reconnectAttempts++;
      const backoff = Math.min(30_000, 2_000 * reconnectAttempts);
      log.error({ err, attempt: reconnectAttempts, backoff }, "Source chain connection failed — retrying");
      setTimeout(connect, backoff);
    }
  };

  await connect();

  // Step 2: confirm completion by watching the destination chain's InterChainCompleted event
  let destWatcher: DestinationWatcher | null = null;
  if (DESTINATION_TYPE === "evm") {
    destWatcher = new DestinationWatcher(db);
    destWatcher.start();
  }

  // ── Event handler ──────────────────────────────────────────────────────────

  const onEvent = async (event: TransactionEvent) => {
    const { txId } = event;
    log.info({ txId, blockNumber: event.blockNumber }, "Processing TransactionSent event");

    // 1. Validate event
    const validation = validateTransactionEvent(event);
    if (!validation.valid) {
      log.warn({ txId, reason: validation.reason }, "Event validation failed — REJECT vote");
    }

    // 2. Upsert transaction in DB (idempotent)
    const tx: CrossChainTransaction = {
      txId,
      sender:              event.sender,
      destinationChainId:  event.destinationChainId,
      destinationAddress:  event.destinationAddress,
      payload:             event.payload,
      nonce:               event.nonce.toString(),
      // Contract emits seconds; store milliseconds for consistent UI/API timestamps
      sourceTimestamp:     Number(event.timestamp) * 1000,
      sourceBlockNumber:   event.blockNumber,
      status:              "PENDING",
      createdAt:           Date.now(),
      updatedAt:           Date.now(),
      approveVotes:        0,
      rejectVotes:         0,
    };
    await db.upsertTransaction(tx);

    // 3. Check if already voted
    const alreadyVoted = await db.hasVoted(txId, LISTENER_ID);
    if (alreadyVoted) {
      log.debug({ txId }, "Already voted — skipping");
      return;
    }

    // 4. Check for duplicate/already-executed
    const existing = await db.getTransaction(txId);
    if (existing && ["EXECUTED", "FAILED", "REJECTED", "TIMED_OUT"].includes(existing.status)) {
      log.debug({ txId, status: existing.status }, "Transaction in terminal state — skipping vote");
      return;
    }

    // 5. Cast vote
    const voteValue = validation.valid ? "APPROVE" : "REJECT";
    const vote: ListenerVote = {
      txId,
      listenerId: LISTENER_ID,
      vote:       voteValue,
      reason:     validation.valid ? undefined : validation.reason,
      votedAt:    Date.now(),
    };

    // Validate before recording (belt-and-suspenders)
    const existingVotes = await db.getVotes(txId);
    const voteError = validateVote(txId, LISTENER_ID, voteValue, existingVotes);
    if (voteError) {
      log.warn({ txId, error: voteError }, "Vote validation failed — skipping");
      return;
    }

    await db.recordVote(vote);
    log.info({ txId, vote: voteValue, listenerId: LISTENER_ID }, "Vote recorded");

    // 6. Evaluate consensus
    const updatedVotes = await db.getVotes(txId);
    const consensus = evaluateConsensus(updatedVotes, { requiredVotes: REQUIRED_VOTES, totalListeners: TOTAL_LISTENERS });
    log.info({ txId, ...consensus }, "Consensus state");

    if (consensus.rejected) {
      const changed = await db.transitionStatus(txId, ["PENDING", "VOTED"], "REJECTED", {
        errorMessage: "Insufficient approval votes",
      });
      if (changed) log.warn({ txId }, "Transaction REJECTED by consensus");
      return;
    }

    if (consensus.approved) {
      // Atomic claim: exactly ONE listener wins the PENDING/VOTED -> APPROVED transition
      // and becomes the execution coordinator. No race, no double execution.
      const won = await db.transitionStatus(txId, ["PENDING", "VOTED"], "APPROVED");
      if (won) {
        log.info({ txId, listenerId: LISTENER_ID }, "Transaction APPROVED — this Listener is the execution coordinator");
        const currentTx = await db.getTransaction(txId);
        if (currentTx) {
          executeTransaction(currentTx, db).catch((err) => {
            log.error({ txId, err }, "Execution threw unexpectedly");
          });
        }
      } else {
        log.debug({ txId }, "Already APPROVED/executing — another Listener is coordinator");
      }
      return;
    }

    // Not yet decided
    await db.transitionStatus(txId, ["PENDING"], "VOTED");
  };

  // ── Cancel handler ─────────────────────────────────────────────────────────

  const onCancel = async (txId: string, _sender: string) => {
    const changed = await db.transitionStatus(txId, ["PENDING", "VOTED", "APPROVED"], "REJECTED", {
      errorMessage: "Cancelled by sender",
    });
    if (changed) log.info({ txId }, "Transaction cancelled by sender — marked REJECTED");
  };

  // ── Start listening ────────────────────────────────────────────────────────

  if (connected) {
    await sourceAdapter.listen(onEvent, onCancel);
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────

  const heartbeat = async () => {
    try {
      const pendingVotes = await db.countTransactions("PENDING") + await db.countTransactions("VOTED");
      await db.upsertHeartbeat({
        listenerId:           LISTENER_ID,
        lastSeenAt:           Date.now(),
        sourceChainConnected: connected,
        lastProcessedBlock:   sourceAdapter.getLastProcessedBlock(),
        pendingVotes,
      });
    } catch (err) {
      log.warn({ err }, "Heartbeat update failed");
    }
  };

  setInterval(heartbeat, 5_000);
  await heartbeat();

  // ── Timeout sweeper ────────────────────────────────────────────────────────

  const sweepTimeouts = async () => {
    try {
      const timedOut = await db.getTimedOutTransactions(TX_TIMEOUT_MS);
      for (const tx of timedOut) {
        log.warn({ txId: tx.txId, status: tx.status, ageMs: Date.now() - tx.createdAt }, "Transaction timed out");
        await db.transitionStatus(tx.txId, [tx.status], "TIMED_OUT", {
          errorMessage: `Timed out after ${TX_TIMEOUT_MS}ms in status ${tx.status}`,
        });
      }
      if (timedOut.length > 0) {
        log.info({ count: timedOut.length }, "Timeout sweep complete");
      }
    } catch (err) {
      log.warn({ err }, "Timeout sweep error");
    }
  };

  setInterval(sweepTimeouts, Math.max(POLL_INTERVAL_MS * 5, 10_000));
  await sweepTimeouts();

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = async (signal: string) => {
    log.info({ signal }, "Shutting down...");
    destWatcher?.stop();
    await sourceAdapter.stop();
    await closeDb();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  log.info({ listenerId: LISTENER_ID }, "Listener is running");
}

main().catch((err) => {
  console.error("Fatal error in Listener process:", err);
  process.exit(1);
});
