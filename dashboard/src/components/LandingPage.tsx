import React from "react";

type Page = "landing" | "dashboard" | "submit";

interface Props {
  onNavigate: (page: Page) => void;
}

const steps = [
  {
    icon: "📡",
    title: "Event Emission",
    body: "A user submits a cross-chain transaction to the SenderContract on the source Hardhat network. The contract emits a TransactionSent event with a unique txId, payload, and destination chain ID.",
  },
  {
    icon: "👂",
    title: "Three Smart Listeners",
    body: "Three independent off-chain Smart Listener processes each monitor the source chain independently. Each listener validates the event — checking txId format, payload, destination, and timestamp — then casts an individual APPROVE or REJECT vote.",
  },
  {
    icon: "🗳️",
    title: "2-of-3 Consensus",
    body: "Votes are tallied in a shared database. When 2 of the 3 listeners approve, consensus is reached and the transaction is marked APPROVED. If 2 listeners reject, it becomes REJECTED. No cryptography — these are independent votes.",
  },
  {
    icon: "⚡",
    title: "Destination Execution",
    body: "The listener that cast the deciding vote acts as coordinator and triggers execution on the destination adapter (currently simulated; Hyperledger Fabric is a modular drop-in). Retries with exponential backoff handle transient failures.",
  },
  {
    icon: "🔒",
    title: "Safety Guarantees",
    body: "Replay protection prevents a transaction from being executed twice. Timeout sweeping marks stuck transactions as TIMED_OUT. Duplicate-vote prevention ensures each listener votes exactly once. No cross-chain atomicity or rollback is claimed.",
  },
];

const features = [
  { icon: "🔗", label: "Heterogeneous chains", desc: "EVM + Hyperledger Fabric adapter interface" },
  { icon: "🏛️", label: "2-of-3 majority vote", desc: "Independent Listeners, no threshold crypto" },
  { icon: "♻️", label: "Replay protection", desc: "Per-sender nonces + unique txIds" },
  { icon: "⏱️", label: "Timeout handling", desc: "Configurable TX_TIMEOUT_MS sweep" },
  { icon: "🔄", label: "Retry & recovery", desc: "Exponential backoff, up to MAX_RETRIES" },
  { icon: "📊", label: "Live dashboard", desc: "Real-time votes, metrics, listener health" },
];

export const LandingPage: React.FC<Props> = ({ onNavigate }) => (
  <div className="landing">
    {/* ── Hero ──────────────────────────────────────────────────────────── */}
    <section className="hero">
      <div className="hero-badge">Bigiotti et al., 2025 · Hybrid-Optimistic IBC Protocol</div>
      <h1 className="hero-title">
        Smart Listener–Based<br />
        <span className="hero-accent">Cross-Chain Communication</span>
      </h1>
      <p className="hero-sub">
        A modular, research-backed interoperability framework that bridges heterogeneous blockchain
        networks using three independent off-chain Smart Listeners and an optimistic 2-of-3 approval
        consensus — without requiring cross-chain atomicity or threshold cryptography.
      </p>
      <div className="hero-cta">
        <button className="btn-primary" onClick={() => onNavigate("submit")}>
          🚀 Submit a Transaction
        </button>
        <button className="btn-secondary" onClick={() => onNavigate("dashboard")}>
          📊 View Dashboard
        </button>
      </div>

      {/* ── Architecture mini-diagram ──────────────────────────────────── */}
      <div className="arch-row">
        {["Source Chain\n(Hardhat)", "Smart Listeners\nA · B · C", "2-of-3\nConsensus", "Destination\n(Simulated)"].map((label, i, arr) => (
          <React.Fragment key={label}>
            <div className="arch-box">
              <div className="arch-icon">
                {["⛓️", "👂", "🗳️", "🏁"][i]}
              </div>
              <div className="arch-label">{label}</div>
            </div>
            {i < arr.length - 1 && <div className="arch-arrow">→</div>}
          </React.Fragment>
        ))}
      </div>
    </section>

    {/* ── How it works ──────────────────────────────────────────────────── */}
    <section className="section">
      <h2 className="section-title">How It Works</h2>
      <div className="steps-grid">
        {steps.map((s, i) => (
          <div className="step-card" key={i}>
            <div className="step-num">{i + 1}</div>
            <div className="step-icon">{s.icon}</div>
            <h3 className="step-title">{s.title}</h3>
            <p className="step-body">{s.body}</p>
          </div>
        ))}
      </div>
    </section>

    {/* ── Features ──────────────────────────────────────────────────────── */}
    <section className="section">
      <h2 className="section-title">Core Features</h2>
      <div className="features-grid">
        {features.map((f) => (
          <div className="feature-card" key={f.label}>
            <span className="feature-icon">{f.icon}</span>
            <div>
              <div className="feature-label">{f.label}</div>
              <div className="feature-desc">{f.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </section>

    {/* ── Transaction states ─────────────────────────────────────────────── */}
    <section className="section">
      <h2 className="section-title">Transaction State Machine</h2>
      <div className="state-flow">
        {[
          { s: "PENDING",   note: "Event seen, awaiting votes" },
          { s: "VOTED",     note: "At least 1 vote cast" },
          { s: "APPROVED",  note: "2+ approvals received" },
          { s: "EXECUTING", note: "Coordinator submitting" },
          { s: "EXECUTED",  note: "Destination confirmed" },
        ].map((item, i, arr) => (
          <React.Fragment key={item.s}>
            <div style={{ textAlign: "center" }}>
              <span className={`badge badge-${item.s}`}>
                <span className="badge-dot" />
                {item.s}
              </span>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 4 }}>{item.note}</div>
            </div>
            {i < arr.length - 1 && <div className="state-arrow">→</div>}
          </React.Fragment>
        ))}
      </div>
      <div className="state-terminals">
        <span className={`badge badge-REJECTED`}><span className="badge-dot" />REJECTED</span>
        <span className={`badge badge-FAILED`}><span className="badge-dot" />FAILED</span>
        <span className={`badge badge-TIMED_OUT`}><span className="badge-dot" />TIMED_OUT</span>
        <span style={{ fontSize: 12, color: "var(--color-text-muted)", alignSelf: "center" }}>← terminal states (no rollback)</span>
      </div>
    </section>

    {/* ── Disclaimer ─────────────────────────────────────────────────────── */}
    <section className="disclaimer">
      <strong>⚠️ Research prototype disclaimer:</strong> This system implements optimistic
      best-effort cross-chain messaging. It does <em>not</em> guarantee atomic execution,
      cross-chain rollback, or exactly-once delivery. The three Listener votes are independent
      majority-vote signals — not threshold cryptography. Use in production requires additional
      safety analysis.
    </section>
  </div>
);
