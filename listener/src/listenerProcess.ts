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
  LISTENER_ID, REQUIRED_VOTES, TOTAL_LISTENERS,
  POLL_INTERVAL_MS, DELTA_B_SECONDS, BACKUP_GRACE_SECONDS,
} from "./config";
import { CrossChainTransaction, TransactionEvent, ListenerVote } from "./types";
import { rollbackTimedOutTransaction, settlementCutoffMs } from "./settlement";
import { ethers } from "ethers";
import { transactionDigest, sepoliaEscrowDigest } from "./digest";
import { EXECUTOR_MNEMONIC, SEPOLIA_LISTENER_MNEMONIC, SOURCE_CHAIN_ID, DEST_CHAIN_ID, DESTINATION_RECEIVER_ADDRESS, SOURCE_MODE, SEPOLIA_ESCROW_ADDRESS } from "./config";
import { isLeader } from "./leader";

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
  if (SOURCE_MODE === "sepolia" && !SEPOLIA_LISTENER_MNEMONIC) {
    throw new Error("SEPOLIA_LISTENER_MNEMONIC must be set for Sepolia listener processes");
  }
  printConfig();
  log.info({ listenerId: LISTENER_ID }, "Smart Listener starting up");

  const db = await getDb();
  const sourceAdapter = new EvmSourceAdapter();
  const savedCursor = await db.getListenerCursor(LISTENER_ID);

  let connected = false;
  let reconnectAttempts = 0;

  const connect = async () => {
    try {
      await sourceAdapter.connect(savedCursor ?? undefined);
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
  if (sourceAdapter.didResetCursor()) {
    await db.resetListenerCursor(LISTENER_ID);
  }

  // Step 2: confirm completion by watching the destination chain's InterChainCompleted event
  let destWatcher: DestinationWatcher | null = null;
  if (DESTINATION_TYPE === "evm" && SOURCE_MODE !== "sepolia") {
    destWatcher = new DestinationWatcher(db);
    destWatcher.start();
  }

  // ── Event handler ──────────────────────────────────────────────────────────

  const onEvent = async (event: TransactionEvent) => {
    const { txId } = event;
    log.info({ txId, blockNumber: event.blockNumber }, "Processing TransactionSent event");

    // 1. Validate event
    const basicValidation = validateTransactionEvent(event);
    const authoritativeValidation = basicValidation.valid
      ? await sourceAdapter.validateAuthoritativeEvent(event)
      : { valid: false, reason: basicValidation.reason };
    const validation = authoritativeValidation;
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
      payloadHash:         event.payloadHash ?? event.payload,
      nonce:               event.nonce.toString(),
      // Contract emits seconds; store milliseconds for consistent UI/API timestamps
      sourceTimestamp:     Number(event.timestamp) * 1000,
      sourceBlockNumber:   event.blockNumber,
      sourceTransactionHash: event.transactionHash,
      sourceBlockHash: event.blockHash,
      transferMode:      event.amount > 0n ? "ETH_TRANSFER" : "MESSAGE_ONLY",
      requestedAmountWei: event.amount.toString(),
      sourceValueWei:    event.amount.toString(),
      deadline:          event.deadline.toString(),
      status:              "PENDING",
      createdAt:           Date.now(),
      updatedAt:           Date.now(),
      approveVotes:        0,
      rejectVotes:         0,
      escrowContractAddress: event.sourceContractAddress,
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
    const hd = ethers.HDNodeWallet.fromPhrase(
      SOURCE_MODE === "sepolia" ? SEPOLIA_LISTENER_MNEMONIC : EXECUTOR_MNEMONIC,
      undefined, `m/44'/60'/0'/0/${["A", "B", "C", "D"].indexOf(LISTENER_ID) + 1}`,
    );
    const digest = SOURCE_MODE === "sepolia"
      ? sepoliaEscrowDigest(tx, SEPOLIA_ESCROW_ADDRESS, SOURCE_CHAIN_ID)
      : transactionDigest(tx, DESTINATION_RECEIVER_ADDRESS, SOURCE_CHAIN_ID, DEST_CHAIN_ID);
    const signature = hd.signingKey.sign(digest).serialized;
    const vote: ListenerVote = {
      txId,
      listenerId: LISTENER_ID,
      vote:       voteValue,
      reason:     validation.valid ? undefined : validation.reason,
      votedAt:    Date.now(),
      signerAddress: hd.address,
      signature,
      digest,
    };

    // Validate before recording (belt-and-suspenders)
    const existingVotes = await db.getVotes(txId);
    const voteError = validateVote(txId, LISTENER_ID, voteValue, existingVotes, vote);
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

    if (consensus.approved && isLeader(LISTENER_ID)) {
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
    await sourceAdapter.listen(
      onEvent,
      onCancel,
      (blockNumber) => db.advanceListenerCursor(LISTENER_ID, blockNumber).then(() => undefined),
    );
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
      // Leadership rotates by wall-clock round. A new leader retries coordination
      // for transactions whose prior coordinator failed without client control.
      if (isLeader(LISTENER_ID)) {
        for (const approved of await db.listTransactions({ status: "APPROVED" })) {
          await executeTransaction(approved, db);
        }
        for (const pending of [
          ...(await db.listTransactions({ status: "PENDING" })),
          ...(await db.listTransactions({ status: "VOTED" })),
        ]) {
          const votes = await db.getVotes(pending.txId);
          const consensus = evaluateConsensus(votes, { requiredVotes: REQUIRED_VOTES, totalListeners: TOTAL_LISTENERS });
          if (consensus.approved && await db.transitionStatus(pending.txId, ["PENDING", "VOTED"], "APPROVED")) {
            const current = await db.getTransaction(pending.txId);
            if (current) void executeTransaction(current, db);
          }
        }
      }
      const timedOut = await db.getTimedOutTransactions(DELTA_B_SECONDS * 1000);
      for (const tx of timedOut) {
        if (destWatcher && DESTINATION_TYPE === "evm") {
          const reconciled = await destWatcher.reconcile(tx.txId);
          if (reconciled === "confirmed") continue;
        }
        log.warn({ txId: tx.txId, status: tx.status, ageMs: Date.now() - tx.createdAt }, "Transaction timed out");
        await db.transitionStatus(tx.txId, [tx.status], "TIMED_OUT", {
          errorMessage: `Timed out after ${DELTA_B_SECONDS}s in status ${tx.status}`,
        });
      }

      const rollbackCandidates = SOURCE_MODE === "sepolia" ? [] : await db.getRollbackCandidates(
        settlementCutoffMs() + BACKUP_GRACE_SECONDS * 1000,
      );
      for (const tx of rollbackCandidates) {
        if (destWatcher && DESTINATION_TYPE === "evm") {
          const reconciled = await destWatcher.reconcile(tx.txId);
          if (reconciled === "confirmed") continue;
        }
        try {
          const changed = await rollbackTimedOutTransaction(db, tx);
          if (changed) log.warn({ txId: tx.txId }, "Transaction rolled back after destination reconciliation window");
        } catch (err) {
          log.warn({ txId: tx.txId, err }, "Rollback settlement attempt failed");
        }
      }
      if (timedOut.length > 0 || rollbackCandidates.length > 0) {
        log.info({ timedOut: timedOut.length, rollbackCandidates: rollbackCandidates.length }, "Settlement sweep complete");
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
