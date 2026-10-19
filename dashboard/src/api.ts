// Shared API types for the dashboard

export type TxStatus =
  | "PENDING" | "VOTED" | "APPROVED" | "EXECUTING"
  | "EXECUTED" | "FAILED" | "TIMED_OUT" | "REJECTED"
  | "ROLLED_BACK";
export type TransferMode = "MESSAGE_ONLY" | "ETH_TRANSFER";
export interface Transaction {
  txId: string;
  sender: string;
  destinationChainId: string;
  destinationAddress: string;
  payload: string;
  nonce: string;
  sourceTimestamp: number;
  sourceBlockNumber: number;
  sourceTransactionHash?: string;
  sourceBlockHash?: string;
  payloadText?: string;
  payloadHash?: string;
  transferMode: TransferMode;
  requestedAmountWei: string;
  sourceValueWei: string;
  transferredAmountWei?: string;
  destinationConfirmation?: boolean;
  sourceChainId?: number;
  sourceNetwork?: string;
  sourceContractAddress?: string;
  destinationNetwork?: string;
  destinationReceiverAddress?: string;
  status: TxStatus;
  createdAt: number;
  updatedAt: number;
  destTxHash?: string;
  errorMessage?: string;
  approveVotes: number;
  rejectVotes: number;
  votes?: Vote[];
}

export interface Vote {
  txId: string;
  listenerId: "A" | "B" | "C" | "D";
  vote: "APPROVE" | "REJECT";
  reason?: string;
  votedAt: number;
}

export interface ListenerHeartbeat {
  listenerId: "A" | "B" | "C" | "D";
  lastSeenAt: number;
  sourceChainConnected: boolean;
  lastProcessedBlock: number;
  pendingVotes: number;
  online: boolean;
}

export interface Metrics {
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
  windowSeconds: number;
}

export interface SubmitTransactionRequest {
  destinationChainId?: string;
  destinationAddress?: string;
  payload: string | Record<string, unknown>;
  transferMode?: TransferMode;
  amountEth?: string;
}

export interface SubmitTransactionResponse {
  success: boolean;
  txId: string | null;
  transactionHash?: string;
  txHash?: string;
  hash?: string;
  blockNumber?: number;
  senderAddress?: string;
  transferMode?: TransferMode;
  requestedAmountWei?: string;
}

const API_BASE = "/api";

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  const body = await res.json().catch(() => null) as { error?: string; message?: string } | null;
  if (!res.ok) {
    throw new Error(body?.error || body?.message || `API ${path} → ${res.status}`);
  }
  return body as T;
}

export const api = {
  getTransactions: (params?: { status?: TxStatus; limit?: number; offset?: number }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set("status", params.status);
    if (params?.limit)  q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    const qs = q.toString() ? `?${q}` : "";
    return apiFetch<{ transactions: Transaction[]; total: number }>(`/transactions${qs}`);
  },
  getTransaction: (txId: string) =>
    apiFetch<Transaction>(`/transactions/${txId}`),
  getListeners: () =>
    apiFetch<{ listeners: ListenerHeartbeat[] }>(`/listeners`),
  getMetrics: () =>
    apiFetch<Metrics>(`/metrics`),
  submitTransaction: async (request: SubmitTransactionRequest): Promise<SubmitTransactionResponse> => {
    const res = await fetch(`${API_BASE}/transactions/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const result = await res.json() as SubmitTransactionResponse & { error?: string; message?: string };
    if (!res.ok) throw new Error(result.error || result.message || `API /transactions/submit -> ${res.status}`);
    return result;
  },
};
