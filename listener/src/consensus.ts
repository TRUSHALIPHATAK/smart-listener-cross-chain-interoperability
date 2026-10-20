/**
 * consensus.ts — 2-of-3 vote tallying
 *
 * This module is intentionally pure/stateless: it operates only on vote arrays
 * passed in from the DB layer. Threshold cryptography is NOT used — the three
 * Listener approvals are independent votes.
 */

import { LISTENER_IDS, ListenerVote, VoteValue } from "./types";
import { ethers } from "ethers";

export interface ConsensusResult {
  approved: boolean;
  rejected: boolean;
  /** True if no further votes can change the outcome */
  decided: boolean;
  approveCount: number;
  rejectCount: number;
  totalVotes: number;
}

export interface ConsensusConfig {
  requiredVotes: number;
  totalListeners: number;
}

/**
 * Evaluate the current consensus state given a list of votes.
 *
 * @param votes          All votes cast so far for a transaction
 * @param config         Threshold configuration (2-of-3 by default)
 */
export function evaluateConsensus(
  votes: ListenerVote[],
  config: ConsensusConfig = { requiredVotes: 2, totalListeners: 3 }
): ConsensusResult {
  const { requiredVotes, totalListeners } = config;

  const approveCount = votes.filter((v) => v.vote === "APPROVE").length;
  const rejectCount  = votes.filter((v) => v.vote === "REJECT").length;
  const totalVotes   = votes.length;

  const approved = approveCount >= requiredVotes;
  // Rejection is decided when it's impossible to reach required approves
  const maxPossibleApproves = totalListeners - rejectCount;
  const rejected = !approved && maxPossibleApproves < requiredVotes;
  const decided  = approved || rejected;

  return { approved, rejected, decided, approveCount, rejectCount, totalVotes };
}

/**
 * Validate a single vote's integrity before recording.
 * Returns null if valid, or an error string if invalid.
 */
export function validateVote(
  txId: string,
  listenerId: string,
  vote: VoteValue,
  existingVotes: ListenerVote[],
  signed?: Pick<ListenerVote, "signerAddress" | "signature" | "digest">
): string | null {
  if (!txId || typeof txId !== "string") return "Invalid txId";
  if (!(LISTENER_IDS as readonly string[]).includes(listenerId)) return `Invalid listenerId: ${listenerId}`;
  if (!["APPROVE", "REJECT"].includes(vote)) return `Invalid vote value: ${vote}`;

  const alreadyVoted = existingVotes.some((v) => v.listenerId === listenerId);
  if (alreadyVoted) return `Listener ${listenerId} has already voted on ${txId}`;
  if (signed) {
    if (!signed.signerAddress || !signed.signature || !signed.digest) return "Cryptographic signature fields are required";
    try {
      const recovered = ethers.getAddress(ethers.recoverAddress(signed.digest, signed.signature));
      if (recovered !== ethers.getAddress(signed.signerAddress)) return "Signature does not match signer address";
    } catch {
      return "Invalid cryptographic signature";
    }
    if (existingVotes.some((v) => v.signerAddress?.toLowerCase() === signed.signerAddress!.toLowerCase())) {
      return `Signer ${signed.signerAddress} has already voted`;
    }
  }

  return null; // valid
}
