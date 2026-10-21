import React from "react";

type Page = "landing" | "dashboard" | "submit";

interface Props {
  onNavigate: (page: Page) => void;
}

/* ---------- Inline icons (stroke = currentColor, so they follow your palette) ---------- */

type IconName =
  | "broadcast" | "eye" | "vote" | "bolt" | "shield"
  | "link" | "scale" | "repeat" | "clock" | "retry" | "chart"
  | "chain" | "flag" | "send" | "dashboard" | "alert" | "arrow";

const PATHS: Record<IconName, React.ReactNode> = {
  broadcast: (
    <>
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8a6 6 0 0 1 0 8.4M7.8 16.2a6 6 0 0 1 0-8.4" />
      <path d="M19 5a10 10 0 0 1 0 14M5 19A10 10 0 0 1 5 5" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  vote: (
    <>
      <path d="m9 11 3 3 8-8" />
      <path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />,
  shield: (
    <>
      <path d="M12 3 4 6v6c0 4.5 3.2 8 8 9 4.8-1 8-4.5 8-9V6l-8-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
  scale: (
    <>
      <path d="M12 3v18M7 21h10" />
      <path d="M5 7h14" />
      <path d="m5 7-3 7a3 3 0 0 0 6 0L5 7ZM19 7l-3 7a3 3 0 0 0 6 0l-3-7Z" />
    </>
  ),
  repeat: (
    <>
      <path d="m17 2 4 4-4 4" />
      <path d="M3 11V9a3 3 0 0 1 3-3h15" />
      <path d="m7 22-4-4 4-4" />
      <path d="M21 13v2a3 3 0 0 1-3 3H3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  retry: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </>
  ),
  chart: (
    <>
      <path d="M3 3v18h18" />
      <path d="M7 15v3M12 10v8M17 6v12" />
    </>
  ),
  chain: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <path d="M10 6.5h4a3 3 0 0 1 3 3V14M14 17.5h-4a3 3 0 0 1-3-3V10" />
    </>
  ),
  flag: (
    <>
      <path d="M5 21V4" />
      <path d="M5 4h12l-2 4 2 4H5" />
    </>
  ),
  send: (
    <>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </>
  ),
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
};

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

/* ---------- Content ---------- */

const steps: { icon: IconName; title: string; body: string }[] = [
  {
    icon: "broadcast",
    title: "Event Emission",
    body: "A user submits a cross-chain transaction to the SenderContract on the source Hardhat network. The contract emits a TransactionSent event with a unique txId, payload, and destination chain ID.",
  },
  {
    icon: "eye",
    title: "Four Smart Listeners",
    body: "Four independent off-chain Smart Listener processes each monitor the source chain independently. Each listener validates the event — checking txId format, payload, destination, and timestamp — then casts an individual APPROVE or REJECT vote.",
  },
  {
    icon: "vote",
    title: "Majority Consensus (3-of-4)",
    body: "Votes are tallied for coordination, but the destination contract verifies the listeners' distinct signatures. When 3 of the 4 listeners approve, the signed request can cross the execution boundary.",
  },
  {
    icon: "bolt",
    title: "Destination Execution",
    body: "The elected listener coordinator submits the signed request to the local EVM DestinationReceiver, which releases reserve-backed ETH only after on-chain signature verification. Hyperledger Fabric remains a modular adapter path.",
  },
  {
    icon: "shield",
    title: "Safety Guarantees",
    body: "Replay protection prevents a transaction from being executed twice. Destination completion is reconciled before timeout settlement, and source escrow can be safely rolled back after the configured backup window.",
  },
];

const features: { icon: IconName; label: string; desc: string }[] = [
  { icon: "link", label: "Heterogeneous chains", desc: "EVM + Hyperledger Fabric adapter interface" },
  { icon: "scale", label: "3-of-4 majority vote", desc: "Independent Listeners, no threshold crypto" },
  { icon: "repeat", label: "Replay protection", desc: "Per-sender nonces + unique txIds" },
  { icon: "clock", label: "Timeout handling", desc: "Configurable TX_TIMEOUT_MS sweep" },
  { icon: "retry", label: "Retry & recovery", desc: "Exponential backoff, up to MAX_RETRIES" },
  { icon: "chart", label: "Live dashboard", desc: "Real-time votes, metrics, listener health" },
];

const architecture: { icon: IconName; title: string; sub: string }[] = [
  { icon: "chain", title: "Source Chain", sub: "Hardhat" },
  { icon: "eye", title: "Smart Listeners", sub: "A · B · C · D" },
  { icon: "vote", title: "Majority Consensus (3-of-4)", sub: "Majority vote" },
  { icon: "flag", title: "Destination", sub: "Simulated" },
];

const stateFlow = [
  { s: "PENDING", note: "Event seen, awaiting votes" },
  { s: "VOTED", note: "At least 1 vote cast" },
  { s: "APPROVED", note: "3-of-4 approvals received" },
  { s: "EXECUTING", note: "Coordinator submitting" },
  { s: "EXECUTED", note: "Destination confirmed" },
];

/* ---------- Page ---------- */

export const LandingPage: React.FC<Props> = ({ onNavigate }) => (
  <div className="landing">
    {/* Hero */}
    <section className="hero">
      <div className="hero-badge">Bigiotti et al., 2025 · Hybrid-Optimistic IBC Protocol</div>
      <h1 className="hero-title">
        Smart Listener–Based<br />
        <span className="hero-accent">Cross-Chain Communication</span>
      </h1>
      <p className="hero-sub">
        A modular, research-backed interoperability framework that bridges heterogeneous blockchain
        networks using four independent off-chain Smart Listeners and an optimistic majority (3-of-4) approval
        consensus — without requiring cross-chain atomicity or threshold cryptography.
      </p>
      <div className="hero-cta">
        <button className="btn-primary" onClick={() => onNavigate("submit")}>
          <Icon name="send" size={17} />
          Submit a transaction
        </button>
        <button className="btn-secondary" onClick={() => onNavigate("dashboard")}>
          <Icon name="dashboard" size={17} />
          View dashboard
        </button>
      </div>

      {/* Architecture mini-diagram */}
      <div className="arch-row" aria-label="Architecture overview">
        {architecture.map((box, i) => (
          <React.Fragment key={box.title}>
            <div className="arch-box">
              <div className="arch-icon"><Icon name={box.icon} size={22} /></div>
              <div className="arch-label">{box.title}</div>
              <div className="arch-sub">{box.sub}</div>
            </div>
            {i < architecture.length - 1 && (
              <div className="arch-arrow"><Icon name="arrow" size={18} /></div>
            )}
          </React.Fragment>
        ))}
      </div>
    </section>

    {/* How it works */}
    <section className="section">
      <h2 className="section-title">How it works</h2>
      <div className="steps-grid">
        {steps.map((s, i) => (
          <div className="step-card" key={s.title}>
            <div className="step-head">
              <div className="step-icon"><Icon name={s.icon} size={22} /></div>
              <div className="step-num">{i + 1}</div>
            </div>
            <h3 className="step-title">{s.title}</h3>
            <p className="step-body">{s.body}</p>
          </div>
        ))}
      </div>
    </section>

    {/* Features */}
    <section className="section">
      <h2 className="section-title">Core features</h2>
      <div className="features-grid">
        {features.map((f) => (
          <div className="feature-card" key={f.label}>
            <span className="feature-icon"><Icon name={f.icon} size={20} /></span>
            <div>
              <div className="feature-label">{f.label}</div>
              <div className="feature-desc">{f.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </section>

    {/* Transaction states */}
    <section className="section">
      <h2 className="section-title">Transaction state machine</h2>
      <div className="state-flow">
        {stateFlow.map((item, i) => (
          <React.Fragment key={item.s}>
            <div className="state-item">
              <span className={`badge badge-${item.s}`}>
                <span className="badge-dot" />
                {item.s}
              </span>
              <div className="state-note">{item.note}</div>
            </div>
            {i < stateFlow.length - 1 && (
              <div className="state-arrow"><Icon name="arrow" size={16} /></div>
            )}
          </React.Fragment>
        ))}
      </div>
      <div className="state-terminals">
        <span className="state-terminals-label">Terminal states (no rollback):</span>
        <span className="badge badge-REJECTED"><span className="badge-dot" />REJECTED</span>
        <span className="badge badge-FAILED"><span className="badge-dot" />FAILED</span>
        <span className="badge badge-TIMED_OUT"><span className="badge-dot" />TIMED_OUT</span>
      </div>
    </section>

    {/* Disclaimer */}
    <section className="disclaimer">
      <span className="disclaimer-icon"><Icon name="alert" size={18} /></span>
      <p>
        <strong>Research prototype disclaimer:</strong> This system implements optimistic
        best-effort cross-chain messaging. It does <em>not</em> guarantee atomic execution,
        cross-chain rollback, or exactly-once delivery. The four Listener votes are independent
        majority-vote signals — not threshold cryptography. Use in production requires additional
        safety analysis.
      </p>
    </section>
  </div>
);