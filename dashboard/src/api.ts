// Shared API types for the dashboard

export type TxStatus =
  | "PENDING" | "VOTED" | "APPROVED" | "EXECUTING"
  | "EXECUTED" | "FAILED" | "TIMED_OUT" | "REJECTED";

export interface Transaction {
  txId: string;
  sender: string;
  destinationChainId: string;
  destinationAddress: string;
  payload: string;
  nonce: string;
  sourceTimestamp: number;
  sourceBlockNumber: number;
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
  listenerId: "A" | "B" | "C";
  vote: "APPROVE" | "REJECT";
  reason?: string;
  votedAt: number;
}

export interface ListenerHeartbeat {
  listenerId: "A" | "B" | "C";
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

const API_BASE = "/api";

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
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
};
