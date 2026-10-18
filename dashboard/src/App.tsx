import React, { useState, useEffect, useCallback, useRef } from "react";
import { LandingPage } from "./components/LandingPage";
import { api } from "./api";
import type { ListenerHeartbeat, Metrics, Transaction, TxStatus } from "./api";

type Page = "landing" | "dashboard" | "submit";

const STATUS_LIST: TxStatus[] = [
  "PENDING", "VOTED", "APPROVED", "EXECUTING",
  "EXECUTED", "FAILED", "TIMED_OUT", "REJECTED",
];

/* ---------- Small inline icons (replace emojis, inherit text colour) ---------- */

type IconName = "overview" | "dashboard" | "send" | "refresh";

function Icon({ name }: { name: IconName }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "icon",
  };

  switch (name) {
    case "overview":
      return (
        <svg {...common}>
          <path d="M3 11.5 12 4l9 7.5" />
          <path d="M5 10v10h14V10" />
        </svg>
      );
    case "dashboard":
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="9" rx="1.5" />
          <rect x="14" y="3" width="7" height="5" rx="1.5" />
          <rect x="14" y="12" width="7" height="9" rx="1.5" />
          <rect x="3" y="16" width="7" height="5" rx="1.5" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="M22 2 11 13" />
          <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...common}>
          <path d="M21 12a9 9 0 1 1-3-6.7" />
          <path d="M21 3v6h-6" />
        </svg>
      );
  }
}

/* ---------- Shared components ---------- */

function StatusBadge({ status }: { status: TxStatus }) {
  return (
    <span className={`badge badge-${status}`}>
      <span className="badge-dot" />
      {status}
    </span>
  );
}

function Panel({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2 className="panel-title">{title}</h2>
          {description && <p className="panel-description">{description}</p>}
        </div>
        {actions && <div className="panel-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function Message({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <p
      role={error ? "alert" : "status"}
      className={`message ${error ? "error" : "success"}`}
    >
      {children}
    </p>
  );
}

/* ---------- App ---------- */

export default function App() {
  const [page, setPage] = useState<Page>("landing");
  const [wsStatus, setWsStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("disconnected");
  const wsRef = useRef<WebSocket | null>(null);

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [listeners, setListeners] = useState<ListenerHeartbeat[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filter, setFilter] = useState("");

  const [destinationAddress, setDestinationAddress] = useState(
    "0xRecipientAddressOnDest"
  );
  const [payload, setPayload] = useState("Hello from Smart Listener");
  const [submitting, setSubmitting] = useState(false);
  const [submittedHash, setSubmittedHash] = useState("");

  const loadDashboard = useCallback(async () => {
    setLoading(true);

    try {
      const [txResult, listenerResult, metricsResult] = await Promise.all([
        api.getTransactions({ limit: 100 }),
        api.getListeners(),
        api.getMetrics(),
      ]);

      setTransactions(
        Array.isArray(txResult)
          ? txResult
          : (txResult as { transactions?: Transaction[] }).transactions ?? []
      );
      setListeners(
        Array.isArray(listenerResult)
          ? listenerResult
          : (listenerResult as { listeners?: ListenerHeartbeat[] }).listeners ?? []
      );
      setMetrics(metricsResult);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load dashboard data.");
    } finally {
      setLoading(false);
    }
  }, []);

  const connectWs = useCallback(() => {
    setWsStatus("connecting");

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => setWsStatus("connected");
    ws.onclose = () => setWsStatus("disconnected");
    ws.onerror = () => ws.close();
    ws.onmessage = () => void loadDashboard();

    return ws;
  }, [loadDashboard]);

  useEffect(() => {
    const ws = connectWs();
    void loadDashboard();

    const refresh = window.setInterval(() => void loadDashboard(), 5000);

    return () => {
      window.clearInterval(refresh);
      ws.close();
      wsRef.current = null;
    };
  }, [connectWs, loadDashboard]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setNotice("");
    setSubmittedHash("");

    try {
      const response = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destinationAddress, payload }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || result.message || "Transaction submission failed.");
      }

      const hash = result.transactionHash ?? result.txHash ?? result.hash ?? "";
      setSubmittedHash(hash);
      setNotice(
        hash
          ? "Transaction submitted to the source chain. Listener processing may still be in progress."
          : "The API accepted the request. Check the response and dashboard for transaction details."
      );
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit the transaction.");
    } finally {
      setSubmitting(false);
    }
  }

  const visibleTransactions = transactions.filter(
    (tx) => !filter || tx.status === filter
  );

  const navItems: { page: Page; label: string; icon: IconName }[] = [
    { page: "landing", label: "Overview", icon: "overview" },
    { page: "dashboard", label: "Dashboard", icon: "dashboard" },
    { page: "submit", label: "Submit transaction", icon: "send" },
  ];

  const metricCards: [string, string | number][] = metrics
    ? [
        ["Total transactions", metrics.totalTransactions],
        ["Pending", metrics.pending],
        ["Approved", metrics.approved],
        ["Executed", metrics.executed],
        ["Failed", metrics.failed],
        ["Rejected", metrics.rejected],
        ["Average latency", `${metrics.avgLatencyMs} ms`],
        ["Throughput", `${metrics.throughputPerMinute}/min`],
      ]
    : [];

  const wsLabel =
    wsStatus === "connected"
      ? "Live"
      : wsStatus === "connecting"
        ? "Connecting…"
        : "Offline";

  return (
    <div className="app">
      <header className="topbar">
        <div
          className="topbar-brand"
          onClick={() => setPage("landing")}
          style={{ cursor: "pointer" }}
        >
          <div className="topbar-logo">SL</div>
          <div>
            <div className="topbar-title">Smart Listener</div>
            <div className="topbar-subtitle">Cross-Chain Interoperability</div>
          </div>
        </div>

        <nav className="topbar-nav" aria-label="Main">
          {navItems.map(({ page: target, label, icon }) => (
            <button
              key={target}
              className={`nav-btn${page === target ? " active" : ""}`}
              aria-current={page === target ? "page" : undefined}
              onClick={() => {
                setPage(target);
                setError("");
                setNotice("");
                if (target === "dashboard") void loadDashboard();
              }}
            >
              <Icon name={icon} />
              {label}
            </button>
          ))}
        </nav>

        <div className="topbar-right">
          <div className="ws-indicator">
            <div className={`ws-dot ${wsStatus}`} />
            <span className="ws-label">{wsLabel}</span>
          </div>
        </div>
      </header>

      <main className="main-content">
        {page === "landing" && <LandingPage onNavigate={setPage} />}

        {page === "dashboard" && (
          <div className="dashboard-page">
            <div className="page-heading">
              <div className="page-heading-text">
                <h1>Transaction dashboard</h1>
                <p>Monitor source-chain transactions, listener votes and execution status.</p>
              </div>
              <button
                className="btn-secondary"
                onClick={() => void loadDashboard()}
                disabled={loading}
              >
                <span className={loading ? "icon-spin" : undefined}>
                  <Icon name="refresh" />
                </span>
                {loading ? "Refreshing…" : "Refresh"}
              </button>
            </div>

            {error && <Message error>{error}</Message>}

            {metrics && (
              <div className="metrics-grid">
                {metricCards.map(([label, value]) => (
                  <div className="metric-card" key={label}>
                    <div className="metric-label">{label}</div>
                    <div className="metric-value">{value}</div>
                  </div>
                ))}
              </div>
            )}

            <Panel
              title="Listener health"
              description="Heartbeat from each independent listener."
            >
              <div className="listener-grid">
                {listeners.length === 0 && (
                  <p className="empty-state">No listener heartbeat data available.</p>
                )}
                {listeners.map((listener) => (
                  <div className="listener-card" key={listener.listenerId}>
                    <div className="listener-card-header">
                      <h3>Listener {listener.listenerId}</h3>
                      <span
                        className={`badge ${
                          listener.online ? "badge-EXECUTED" : "badge-FAILED"
                        }`}
                      >
                        <span className="badge-dot" />
                        {listener.online ? "Online" : "Offline"}
                      </span>
                    </div>
                    <div className="listener-detail">
                      <span>Source chain</span>
                      <span>{listener.sourceChainConnected ? "Connected" : "Disconnected"}</span>
                    </div>
                    <div className="listener-detail">
                      <span>Last processed block</span>
                      <span className="mono-cell">{listener.lastProcessedBlock ?? "—"}</span>
                    </div>
                    <div className="listener-detail">
                      <span>Pending votes</span>
                      <span>{listener.pendingVotes ?? 0}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel
              title="Transactions"
              description={`${visibleTransactions.length} shown`}
              actions={
                <div className="filter-row">
                  <label htmlFor="status-filter">Status</label>
                  <select
                    id="status-filter"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    <option value="">All statuses</option>
                    {STATUS_LIST.map((status) => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                  </select>
                </div>
              }
            >
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Transaction ID</th>
                      <th>Destination</th>
                      <th>Status</th>
                      <th>Votes</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTransactions.map((tx) => (
                      <tr key={tx.txId}>
                        <td className="mono-cell" title={tx.txId}>
                          {tx.txId.slice(0, 12)}…
                        </td>
                        <td className="mono-cell">{tx.destinationAddress}</td>
                        <td><StatusBadge status={tx.status} /></td>
                        <td>{tx.approveVotes ?? 0} approve / {tx.rejectVotes ?? 0} reject</td>
                        <td>{tx.errorMessage || "—"}</td>
                      </tr>
                    ))}
                    {!loading && visibleTransactions.length === 0 && (
                      <tr>
                        <td colSpan={5} className="empty-state">No transactions found.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        )}

        {page === "submit" && (
          <div className="submit-page">
            <div className="page-heading">
              <div className="page-heading-text">
                <h1>Submit a transaction</h1>
                <p>Send a cross-chain request to the local Hardhat source chain.</p>
              </div>
            </div>

            <div className="submit-layout">
              <Panel title="Transaction details">
                <form onSubmit={handleSubmit} className="transaction-form">
                  <div className="form-group">
                    <label htmlFor="destination">Destination address</label>
                    <input
                      id="destination"
                      value={destinationAddress}
                      onChange={(event) => setDestinationAddress(event.target.value)}
                      required
                      maxLength={200}
                      placeholder="Destination address"
                    />
                  </div>

                  <div className="form-group">
                    <label htmlFor="payload">Payload</label>
                    <textarea
                      id="payload"
                      value={payload}
                      onChange={(event) => setPayload(event.target.value)}
                      required
                      rows={5}
                      maxLength={10000}
                      placeholder="Enter a message or REJECT: test rejection"
                    />
                    <p className="form-hint">
                      To trigger the configured rejection test, start the payload with REJECT:
                    </p>
                  </div>

                  <div className="form-actions">
                    <button className="btn-primary" type="submit" disabled={submitting}>
                      <Icon name="send" />
                      {submitting ? "Submitting…" : "Submit transaction"}
                    </button>
                  </div>
                </form>

                {error && <Message error>{error}</Message>}
                {notice && <Message>{notice}</Message>}
                {submittedHash && (
                  <div className="transaction-result">
                    <strong>Source transaction hash</strong>
                    <p className="mono-cell">{submittedHash}</p>
                    <button className="btn-secondary" onClick={() => setPage("dashboard")}>
                      <Icon name="dashboard" />
                      View dashboard
                    </button>
                  </div>
                )}
              </Panel>

              <aside className="submit-aside">
                <Panel title="What happens next">
                  <ol className="workflow-list">
                    <li>The source contract emits a transaction event.</li>
                    <li>Three independent listeners validate the event and cast votes.</li>
                    <li>Two matching approval votes are required for approval.</li>
                    <li>The destination adapter processes an approved transaction.</li>
                  </ol>
                  <p className="form-hint" style={{ marginTop: 16 }}>
                    A successful source submission does not by itself confirm destination execution.
                  </p>
                </Panel>
              </aside>
            </div>
          </div>
        )}
      </main>

      <footer className="footer">
        <span>
          Smart Listener · Bigiotti et al. (2025) · Optimistic 2-of-3 Inter-Blockchain Protocol
        </span>
        <span className="footer-note">
          Simulated destination · No cross-chain atomicity guarantee
        </span>
      </footer>
    </div>
  );
}