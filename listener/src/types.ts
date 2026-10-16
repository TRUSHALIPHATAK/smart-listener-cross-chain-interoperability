/**
 * Shared types for the Smart Listener system.
 * 
 * Transaction state machine:
 *   PENDING → VOTED → APPROVED → EXECUTING → EXECUTED
 *                                           → FAILED
 *                                           → TIMED_OUT
 *   PENDING → REJECTED  (if cancelled on source or validation fails)
 */

export type TxStatus =
  | "PENDING"
  | "VOTED"
  | "APPROVED"
  | "EXECUTING"
  | "EXECUTED"
  | "FAILED"
  | "TIMED_OUT"
  | "REJECTED";

export type ListenerId = "A" | "B" | "C";

export type VoteValue = "APPROVE" | "REJECT";

export interface CrossChainTransaction {
  /** Unique ID from the SenderContract event (bytes32 hex) */
  txId: string;
  /** Sender address on source chain */
  sender: string;
  /** Destination chain identifier (bytes32 hex) */
  destinationChainId: string;
  /** Destination address bytes (hex) */
  destinationAddress: string;
  /** Payload bytes (hex) */
  payload: string;
  /** Per-sender nonce */
  nonce: string;
  /** Block timestamp of source event */
  sourceTimestamp: number;
  /** Block number of source event */
  sourceBlockNumber: number;
  /** Current status */
  status: TxStatus;
  /** When first seen by any Listener (ms epoch) */
  createdAt: number;
  /** When last updated (ms epoch) */
  updatedAt: number;
  /** Transaction hash of destination execution (if EXECUTED) */
  destTxHash?: string;
  /** Error message (if FAILED) */
  errorMessage?: string;
  /** Number of approve votes received so far */
  approveVotes: number;
  /** Number of reject votes received so far */
  rejectVotes: number;
}

export interface ListenerVote {
  txId: string;
  listenerId: ListenerId;
  vote: VoteValue;
  /** Reason string (for REJECT votes especially) */
  reason?: string;
  votedAt: number;
}

export interface ListenerHeartbeat {
  listenerId: ListenerId;
  lastSeenAt: number;
  sourceChainConnected: boolean;
  lastProcessedBlock: number;
  pendingVotes: number;
}

export interface TransactionEvent {
  txId: string;
  sender: string;
  destinationChainId: string;
  destinationAddress: string;
  payload: string;
  nonce: bigint;
  timestamp: bigint;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
}

export interface DestinationResult {
  success: boolean;
  destTxHash?: string;
  errorMessage?: string;
  /** Latency in milliseconds from APPROVED to EXECUTED */
  latencyMs?: number;
}

export interface MetricsSummary {
  totalTransactions: number;
  pending: number;
  approved: number;
  executed: number;
  failed: number;
  timedOut: number;
  rejected: number;
  avgLatencyMs: number;
  throughputPerMinute: number;
  listeners: ListenerHeartbeat[];
}
