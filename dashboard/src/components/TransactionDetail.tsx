import React from "react";
import { Transaction, Vote } from "../api";

interface Props {
  tx: Transaction;
  onClose: () => void;
}

function fmt(ts: number) {
  return new Date(ts).toLocaleString();
}

function truncate(s: string, n = 40) {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export const TransactionDetail: React.FC<Props> = ({ tx, onClose }) => {
  const votes: Vote[] = tx.votes ?? [];

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        <div className="detail-header">
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Transaction Detail</h2>
            <span className="cell-mono" style={{ fontSize: 12, color: "var(--color-accent)" }}>
              {tx.txId}
            </span>
          </div>
          <button className="detail-close" onClick={onClose}>✕</button>
        </div>

        {/* Status */}
        <div className="detail-field">
          <span className="detail-field-label">Status</span>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
            <span className={`badge badge-${tx.status}`}>
              <span className="badge-dot" />
              {tx.status}
            </span>
            {tx.errorMessage && (
              <span style={{ fontSize: 12, color: "var(--color-danger)" }}>{tx.errorMessage}</span>
            )}
          </div>
        </div>

        {/* Votes */}
        <div className="detail-field">
          <span className="detail-field-label">Listener Votes (2-of-3 required)</span>
          <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
            {(["A", "B", "C"] as const).map((id) => {
              const v = votes.find((x) => x.listenerId === id);
              return (
                <div key={id} style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <div className={`vote-bubble ${v ? (v.vote === "APPROVE" ? "approve" : "reject") : ""}`}>
                    {id}
                  </div>
                  <span style={{ fontSize: 10, color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>
                    {v ? v.vote.slice(0, 3) : "–"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Fields */}
        {[
          ["Sender", tx.sender],
          ["Destination Chain ID", tx.destinationChainId],
          ["Destination Address", truncate(tx.destinationAddress, 64)],
          ["Payload", truncate(tx.payload, 80)],
          ["Nonce", tx.nonce],
          ["Source Block", String(tx.sourceBlockNumber)],
          ["Created", fmt(tx.createdAt)],
          ["Updated", fmt(tx.updatedAt)],
          ...(tx.destTxHash ? [["Dest Tx Hash", tx.destTxHash]] : []),
        ].map(([label, value]) => (
          <div className="detail-field" key={label}>
            <span className="detail-field-label">{label}</span>
            <span className="detail-field-value">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
