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

function CopyValue({ value }: { value?: string }) {
  if (!value) return <span>Not available</span>;
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span>{truncate(value, 72)}</span>
      <button
        type="button"
        onClick={() => void navigator.clipboard?.writeText(value)}
        style={{
          background: "#ffeef3", border: "1px solid #f5c0d0", borderRadius: 5,
          color: "#9b1b4a", cursor: "pointer", padding: "3px 7px", fontSize: 11,
        }}
      >Copy</button>
    </span>
  );
}

function formatWei(value?: string) {
  if (!value) return "Not available";
  try {
    const whole = value.padStart(19, "0");
    const split = whole.length - 18;
    return `${whole.slice(0, split)}.${whole.slice(split).replace(/0+$/, "") || "0"} ETH`;
  } catch {
    return "Not available";
  }
}

export const TransactionDetail: React.FC<Props> = ({ tx, onClose }) => {
  const votes: Vote[] = tx.votes ?? [];
  const fields: Array<[string, string | undefined]> = [
    ["Internal transaction ID", tx.txId],
    ["Source transaction hash", tx.sourceTransactionHash],
    ["Source block hash", tx.sourceBlockHash],
    ["Sender", tx.sender],
    ["Source block", String(tx.sourceBlockNumber)],
    ["Source chain", `${tx.sourceChainId ?? 31337} (${tx.sourceNetwork ?? "local Hardhat"})`],
    ["Source contract", tx.sourceContractAddress],
    ["Destination chain", tx.destinationChainId],
    ["Destination network", tx.destinationNetwork],
    ["Destination receiver", tx.destinationReceiverAddress],
    ["Destination address", tx.destinationAddress],
    ["Nonce", tx.nonce],
    ["Payload", tx.payload],
    ["Decoded payload", tx.payloadText],
    ["Payload hash", tx.payloadHash],
    ["Transfer mode", tx.transferMode === "ETH_TRANSFER" ? "ETH transfer with payload" : "Message-only transaction — no ETH transfer"],
    ["Requested amount", tx.transferMode === "ETH_TRANSFER" ? formatWei(tx.requestedAmountWei) : "0 ETH"],
    ["Source value accepted", formatWei(tx.sourceValueWei)],
    ["Transferred amount", tx.transferredAmountWei ? formatWei(tx.transferredAmountWei) : "Not confirmed"],
    ["Destination confirmation", tx.destinationConfirmation ? "Confirmed" : "Not confirmed"],
    ["Destination tx hash", tx.destTxHash],
    ["Created", fmt(tx.createdAt)],
    ["Updated", fmt(tx.updatedAt)],
  ];

  return (
    <div className="detail-overlay" onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(110, 16, 52, 0.35)",
      zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div
        className="detail-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#fff5f8", border: "1px solid #f5c0d0",
          borderRadius: "14px 14px 0 0", width: "100%", maxWidth: 720,
          maxHeight: "80vh", overflowY: "auto", padding: 24, color: "#6e1034",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4, color: "#9b1b4a" }}>
              Transaction Detail
            </h2>
            <span style={{ fontSize: 12, color: "#d63d72", fontFamily: "monospace" }}>
              {tx.txId}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "#ffeef3", border: "1px solid #f5c0d0", borderRadius: 6,
              color: "#9b1b4a", cursor: "pointer", padding: "6px 10px",
            }}
          >✕</button>
        </div>

        <div style={{ padding: "12px 0", borderBottom: "1px solid #f5c0d0" }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#9b4a66", textTransform: "uppercase" }}>
            Status
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
            <span className={`badge badge-${tx.status}`}>
              <span className="badge-dot" />
              {tx.status}
            </span>
            {tx.errorMessage && <span style={{ fontSize: 12, color: "#8a2048" }}>{tx.errorMessage}</span>}
          </div>
        </div>

        <div style={{ padding: "12px 0", borderBottom: "1px solid #f5c0d0" }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: "#9b4a66", textTransform: "uppercase" }}>
            Listener Votes (3-of-4 required)
          </span>
          <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
            {votes.length === 0 && (
              <span style={{ color: "#9b4a66", fontSize: 12 }}>No votes yet</span>
            )}
            {votes.map((v) => (
              <div key={v.listenerId} style={{
                border: "1px solid #f5c0d0", borderRadius: 8, padding: 10,
                background: "#ffeef3", minWidth: 100,
              }}>
                <div style={{ fontWeight: 700, color: "#9b1b4a" }}>Listener {v.listenerId}</div>
                <div style={{
                  marginTop: 4, fontWeight: 650, color: "#6e1034",
                  textDecoration: v.vote === "REJECT" ? "underline dashed" : "none",
                }}>{v.vote}</div>
                {v.reason && <div style={{ fontSize: 11, color: "#9b4a66", marginTop: 4 }}>{v.reason}</div>}
                <div style={{ fontSize: 11, color: "#9b4a66", marginTop: 4 }}>{fmt(v.votedAt)}</div>
              </div>
            ))}
          </div>
        </div>

        {fields.map(([label, value]) => (
          <div key={label} style={{ padding: "12px 0", borderBottom: "1px solid #f5c0d0" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#9b4a66", textTransform: "uppercase" }}>
              {label}
            </div>
            <div style={{
              fontFamily: "monospace", fontSize: 13, color: "#6e1034",
              wordBreak: "break-all", marginTop: 4,
            }}>{label.toLowerCase().includes("hash") || label.includes("address") || label.includes("ID")
              ? <CopyValue value={value} />
              : (value || "Not available")}</div>
          </div>
        ))}
      </div>
    </div>
  );
};
