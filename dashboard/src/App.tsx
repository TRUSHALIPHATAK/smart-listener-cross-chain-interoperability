import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { ListenerHeartbeat, Metrics, Transaction, TxStatus } from "./api";

/** Pink / dark-pink only — no other accent hues */
const colors = {
  bg: "#fff0f5",
  panel: "#fff5f8",
  panelAlt: "#ffeef3",
  border: "#f5c0d0",
  borderStrong: "#e891a8",
  text: "#6e1034",
  muted: "#9b4a66",
  pink: "#e85a8a",
  pinkMid: "#d63d72",
  darkPink: "#9b1b4a",
  darker: "#6e1034",
  onPink: "#fff5f8",
};

const statuses: TxStatus[] = [
  "PENDING", "VOTED", "APPROVED", "EXECUTING",
  "EXECUTED", "FAILED", "TIMED_OUT", "REJECTED",
];

function short(value?: string) {
  if (!value) return "—";
  return value.length > 18
    ? `${value.slice(0, 10)}…${value.slice(-6)}`
    : value;
}

function dateTime(value?: number) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

/** Distinguish statuses with pink shades + weight — never other hues */
function statusStyle(status: string): React.CSSProperties {
  const map: Record<string, React.CSSProperties> = {
    EXECUTED:  { color: "#6e1034", fontWeight: 800 },
    APPROVED:  { color: "#9b1b4a", fontWeight: 750 },
    EXECUTING: { color: "#d63d72", fontWeight: 700, fontStyle: "italic" },
    VOTED:     { color: "#b83d68", fontWeight: 650 },
    PENDING:   { color: "#c45a7a", fontWeight: 600 },
    FAILED:    { color: "#8a2048", fontWeight: 750, textDecoration: "underline dotted" },
    TIMED_OUT: { color: "#a33a5c", fontWeight: 700, textDecoration: "underline dashed" },
    REJECTED:  { color: "#7a2a48", fontWeight: 700 },
  };
  return map[status] ?? { color: colors.muted, fontWeight: 600 };
}

function Panel({ children, style = {} }: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section style={{
      background: colors.panel,
      border: `1px solid ${colors.border}`,
      borderRadius: 14,
      padding: 20,
      minWidth: 0,
      boxShadow: "0 1px 4px rgba(155, 27, 74, 0.06)",
      ...style,
    }}>
      {children}
    </section>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{
      fontSize: 15, margin: "0 0 18px", fontWeight: 700,
      color: colors.darkPink, letterSpacing: 0.2,
    }}>
      {children}
    </h2>
  );
}

function MetricCard({ label, value, hint }: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Panel>
      <div style={{ color: colors.muted, fontSize: 12, fontWeight: 600 }}>{label}</div>
      <div style={{
        fontSize: 29, fontWeight: 800, marginTop: 12,
        color: colors.darker, overflowWrap: "anywhere",
      }}>{value}</div>
      <div style={{ color: colors.muted, fontSize: 11, marginTop: 8 }}>
        {hint || "Live project metrics"}
      </div>
    </Panel>
  );
}

function ListenerCard({ listener }: { listener: ListenerHeartbeat }) {
  const online = listener.online;
  return (
    <div style={{
      border: `1px solid ${online ? colors.pinkMid : colors.border}`,
      borderRadius: 10,
      padding: 14,
      background: colors.panelAlt,
    }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "center", gap: 8,
      }}>
        <strong style={{ color: colors.darkPink }}>Listener {listener.listenerId}</strong>
        <span style={{
          fontSize: 11, fontWeight: 700,
          color: online ? colors.onPink : colors.darkPink,
          background: online ? colors.darkPink : colors.bg,
          border: `1px solid ${colors.borderStrong}`,
          padding: "4px 8px", borderRadius: 4,
        }}>{online ? "ONLINE" : "OFFLINE"}</span>
      </div>
      <div style={{ color: colors.muted, fontSize: 12, marginTop: 14 }}>
        Source chain:{" "}
        <span style={{
          color: colors.darkPink, fontWeight: 650,
          textDecoration: listener.sourceChainConnected ? "none" : "underline dashed",
        }}>
          {listener.sourceChainConnected ? "Connected" : "Disconnected"}
        </span>
      </div>
      <div style={{ color: colors.muted, fontSize: 12, marginTop: 7 }}>
        Last processed block: {listener.lastProcessedBlock}
      </div>
      <div style={{ color: colors.muted, fontSize: 12, marginTop: 7 }}>
        Pending votes: {listener.pendingVotes}
      </div>
      <div style={{ color: colors.muted, fontSize: 11, marginTop: 10 }}>
        Last heartbeat: {dateTime(listener.lastSeenAt)}
      </div>
    </div>
  );
}

export default function App() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [listeners, setListeners] = useState<ListenerHeartbeat[]>([]);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [filter, setFilter] = useState("ALL");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [tab, setTab] = useState<"monitor" | "about-submit">("monitor");

  const refresh = useCallback(async () => {
    try {
      const [txResult, metricsResult, listenerResult] = await Promise.all([
        api.getTransactions({ limit: 100 }),
        api.getMetrics(),
        api.getListeners(),
      ]);

      setTransactions(txResult.transactions);
      setMetrics(metricsResult);
      setListeners(listenerResult.listeners);
      setLastUpdated(new Date());
      setError("");

      setSelected((previous) => {
        if (!previous) return null;
        const updated = txResult.transactions.find((tx) => tx.txId === previous.txId);
        if (!updated) return previous;
        return { ...updated, votes: previous.votes };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect to the API.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const selectTransaction = async (tx: Transaction) => {
    setSelected(tx);
    setDetailLoading(true);
    try {
      const full = await api.getTransaction(tx.txId);
      setSelected(full);
    } catch {
      // Keep list row data if detail fetch fails
    } finally {
      setDetailLoading(false);
    }
  };

  const visibleTransactions = transactions.filter(
    (tx) => filter === "ALL" || tx.status === filter,
  );

  const cardStyle: React.CSSProperties = {
    color: colors.darkPink,
    background: colors.panelAlt,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    padding: "9px 11px",
    fontSize: 12,
  };

  const tabBtn = (id: "monitor" | "about-submit", label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      style={{
        background: tab === id ? colors.darkPink : colors.panelAlt,
        color: tab === id ? colors.onPink : colors.darkPink,
        border: `1px solid ${tab === id ? colors.darkPink : colors.border}`,
        borderRadius: 8,
        padding: "10px 16px",
        fontWeight: 650,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <main style={{
      minHeight: "100vh", background: colors.bg, color: colors.text,
      fontFamily: '"Nunito Sans", "Segoe UI", system-ui, sans-serif',
      padding: "28px 4%",
    }}>
      <header style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "center", gap: 18, flexWrap: "wrap", marginBottom: 24,
      }}>
        <div>
          <div style={{
            color: colors.pinkMid, fontSize: 11, fontWeight: 800,
            letterSpacing: 2, textTransform: "uppercase",
          }}>Cross-chain communication research</div>
          <h1 style={{
            fontSize: 28, margin: "9px 0 7px", letterSpacing: -0.7,
            color: colors.darker,
          }}>
            Smart Listener
          </h1>
          <p style={{ margin: 0, color: colors.muted, fontSize: 13 }}>
            Hybrid-optimistic inter-blockchain transaction monitor · 2-of-3 consensus
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} style={{
          background: colors.darkPink, color: colors.onPink,
          border: `1px solid ${colors.darker}`, borderRadius: 9,
          padding: "11px 16px", fontWeight: 650, cursor: "pointer",
        }}>↻ Refresh data</button>
      </header>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 18 }}>
        {tabBtn("monitor", "Monitor requests")}
        {tabBtn("about-submit", "Submit a test request")}
      </div>

      <div style={{
        display: "flex", justifyContent: "space-between",
        flexWrap: "wrap", gap: 8, marginBottom: 18,
        color: colors.muted, fontSize: 12,
      }}>
        <span>Environment: Local Hardhat network · Destination: [SIMULATED] adapter</span>
        <span>Auto-refresh: every 5 seconds · Last update: {lastUpdated?.toLocaleTimeString() ?? "Not yet"}</span>
      </div>

      {error && (
        <div role="alert" style={{
          background: "#ffe8ef", border: `1px solid ${colors.borderStrong}`,
          color: colors.darkPink, padding: 15, borderRadius: 10, marginBottom: 20,
        }}>
          <strong>API connection problem</strong>
          <div style={{ marginTop: 6 }}>{error}</div>
          <div style={{ fontSize: 12, marginTop: 7 }}>
            Start the backend with <code>.\start-all.ps1</code> or <code>npm run api</code>.
          </div>
        </div>
      )}

      {tab === "about-submit" ? (
        <Panel style={{ marginBottom: 20, maxWidth: 720 }}>
          <Heading>Submit a test request</Heading>
          <p style={{ color: colors.muted, fontSize: 13, marginBottom: 14 }}>
            This dashboard <strong style={{ color: colors.darkPink }}>monitors</strong> requests
            detected by the Smart Listeners. It does not submit transactions itself.
          </p>
          <p style={{ color: colors.muted, fontSize: 13, marginBottom: 14 }}>
            To send a <strong style={{ color: colors.darkPink }}>test</strong> request through the
            configured <code>SenderContract</code> on the local Hardhat network:
          </p>
          <pre style={{
            background: colors.panelAlt, border: `1px solid ${colors.border}`,
            borderRadius: 8, padding: 14, fontSize: 12, color: colors.darkPink,
            fontFamily: '"IBM Plex Mono", Consolas, monospace', overflowX: "auto",
          }}>
{`# With Hardhat node + listeners already running:
npm run demo:send`}
          </pre>
          <p style={{ color: colors.muted, fontSize: 13, marginTop: 16 }}>
            <strong style={{ color: colors.darkPink }}>External applications</strong> can also call
            <code> sendCrossChainTransaction </code> on any configured source contract address.
            Listeners only process events from contracts listed in{" "}
            <code>listener/config/deployment.json</code> (or <code>SENDER_CONTRACT_ADDRESS</code>).
            Arbitrary contracts are <em>not</em> monitored automatically.
          </p>
          <button
            type="button"
            onClick={() => setTab("monitor")}
            style={{
              marginTop: 18, background: colors.pink, color: colors.onPink,
              border: `1px solid ${colors.darkPink}`, borderRadius: 8,
              padding: "10px 14px", fontWeight: 650, cursor: "pointer",
            }}
          >
            Back to monitor
          </button>
        </Panel>
      ) : (
        <>
          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))",
            gap: 14, marginBottom: 20,
          }}>
            <MetricCard label="TOTAL TRANSACTIONS" value={metrics?.totalTransactions ?? "—"} />
            <MetricCard label="PENDING" value={metrics?.pending ?? "—"} />
            <MetricCard label="APPROVED" value={metrics?.approved ?? "—"} />
            <MetricCard label="EXECUTED" value={metrics?.executed ?? "—"} />
            <MetricCard label="FAILED" value={metrics?.failed ?? "—"} />
            <MetricCard
              label="AVERAGE LATENCY"
              value={metrics ? `${metrics.avgLatencyMs.toFixed(1)} ms` : "—"}
            />
          </div>

          <Panel style={{ marginBottom: 20 }}>
            <Heading>Listener network</Heading>
            <p style={{ color: colors.muted, fontSize: 12, marginTop: -8, marginBottom: 16 }}>
              Three independent listeners cast separate votes. Execution requires the configured
              2-of-3 approval threshold (not threshold cryptography).
            </p>
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
              gap: 12,
            }}>
              {(["A", "B", "C"] as const).map((id) => {
                const listener = listeners.find((item) => item.listenerId === id);
                return listener
                  ? <ListenerCard key={id} listener={listener} />
                  : <div key={id} style={{
                      border: `1px dashed ${colors.border}`, borderRadius: 10,
                      padding: 16, color: colors.muted, fontSize: 13,
                      background: colors.panelAlt,
                    }}>Listener {id}: awaiting heartbeat</div>;
              })}
            </div>
            <div style={{
              display: "flex", justifyContent: "space-between",
              gap: 10, flexWrap: "wrap", marginTop: 16, color: colors.muted, fontSize: 12,
            }}>
              <span>Throughput: {metrics?.throughputPerMinute ?? "—"} transactions/min</span>
              <span>Rejected: {metrics?.rejected ?? "—"} · Timed out: {metrics?.timedOut ?? "—"}</span>
            </div>
          </Panel>

          <div style={{
            display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(280px, 1fr)",
            gap: 20, alignItems: "start",
          }}>
            <Panel>
              <div style={{
                display: "flex", justifyContent: "space-between",
                alignItems: "center", flexWrap: "wrap", gap: 12,
              }}>
                <Heading>Transaction history</Heading>
                <select value={filter} onChange={(event) => setFilter(event.target.value)} style={{
                  ...cardStyle, cursor: "pointer", marginBottom: 16,
                }}>
                  <option value="ALL">All statuses</option>
                  {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
                </select>
              </div>

              {loading ? (
                <p style={{ color: colors.muted }}>Loading transactions…</p>
              ) : visibleTransactions.length === 0 ? (
                <div style={{
                  textAlign: "center", padding: "32px 12px", color: colors.muted,
                  border: `1px dashed ${colors.border}`, borderRadius: 10,
                  background: colors.panelAlt,
                }}>
                  <div style={{ color: colors.darkPink, marginBottom: 8, fontWeight: 650 }}>
                    No transactions to display
                  </div>
                  Use the &quot;Submit a test request&quot; tab for instructions, then watch this
                  panel for listener votes and execution results.
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{
                    width: "100%", borderCollapse: "collapse",
                    fontSize: 12, textAlign: "left",
                  }}>
                    <thead>
                      <tr style={{ color: colors.muted }}>
                        {["Transaction ID", "Status", "Votes", "Updated"].map((heading) => (
                          <th key={heading} style={{
                            padding: "10px 8px", borderBottom: `1px solid ${colors.border}`,
                            fontWeight: 600, whiteSpace: "nowrap",
                          }}>{heading}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTransactions.map((tx) => (
                        <tr key={tx.txId}
                          onClick={() => void selectTransaction(tx)}
                          style={{
                            cursor: "pointer",
                            background: selected?.txId === tx.txId ? colors.panelAlt : "transparent",
                          }}>
                          <td style={{ padding: 10, borderBottom: `1px solid ${colors.border}` }}>
                            <code style={{ color: colors.darkPink }}>{short(tx.txId)}</code>
                          </td>
                          <td style={{ padding: 10, borderBottom: `1px solid ${colors.border}` }}>
                            <span style={statusStyle(tx.status)}>{tx.status}</span>
                          </td>
                          <td style={{
                            padding: 10, borderBottom: `1px solid ${colors.border}`,
                            whiteSpace: "nowrap", color: colors.muted,
                          }}>
                            {tx.approveVotes} approve / {tx.rejectVotes} reject
                          </td>
                          <td style={{
                            padding: 10, borderBottom: `1px solid ${colors.border}`,
                            whiteSpace: "nowrap", color: colors.muted,
                          }}>
                            {dateTime(tx.updatedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel>
              <Heading>Transaction details</Heading>
              {!selected ? (
                <p style={{ color: colors.muted, fontSize: 13 }}>
                  Select a transaction from the table to inspect its details and votes.
                </p>
              ) : (
                <div style={{ fontSize: 12 }}>
                  {detailLoading && (
                    <p style={{ color: colors.muted, marginBottom: 10 }}>
                      <span className="spinner" /> Loading vote details…
                    </p>
                  )}
                  {[
                    ["Transaction ID", selected.txId],
                    ["Status", selected.status],
                    ["Sender", selected.sender],
                    ["Destination chain", selected.destinationChainId],
                    ["Destination address", selected.destinationAddress],
                    ["Nonce", selected.nonce],
                    ["Source block", String(selected.sourceBlockNumber)],
                    ["Source timestamp", dateTime(selected.sourceTimestamp)],
                    ["Created", dateTime(selected.createdAt)],
                    ["Destination transaction", selected.destTxHash || "Not available"],
                  ].map(([label, value]) => (
                    <div key={label} style={{
                      padding: "10px 0", borderBottom: `1px solid ${colors.border}`,
                    }}>
                      <div style={{ color: colors.muted, marginBottom: 5 }}>{label}</div>
                      <div style={{
                        color: label === "Status" ? undefined : colors.text,
                        overflowWrap: "anywhere",
                        ...(label === "Status" ? statusStyle(String(value)) : {}),
                      }}>{value}</div>
                    </div>
                  ))}

                  <div style={{ marginTop: 16, color: colors.muted }}>Payload</div>
                  <pre style={{
                    whiteSpace: "pre-wrap", overflowWrap: "anywhere",
                    background: colors.panelAlt, padding: 12, borderRadius: 8,
                    border: `1px solid ${colors.border}`,
                    color: colors.darkPink, fontSize: 11,
                    fontFamily: '"IBM Plex Mono", Consolas, monospace',
                  }}>{selected.payload || "(empty)"}</pre>

                  {selected.errorMessage && (
                    <p style={{ color: colors.darkPink, fontWeight: 650, marginTop: 10 }}>
                      Error: {selected.errorMessage}
                    </p>
                  )}

                  <div style={{ marginTop: 18, fontWeight: 700, color: colors.darkPink }}>
                    Listener votes
                  </div>
                  {!selected.votes?.length ? (
                    <p style={{ color: colors.muted }}>
                      {detailLoading ? "Loading…" : "No votes recorded yet."}
                    </p>
                  ) : selected.votes.map((vote) => (
                    <div key={`${vote.listenerId}-${vote.txId}`} style={{
                      border: `1px solid ${colors.border}`, borderRadius: 8,
                      padding: 10, marginTop: 8, background: colors.panelAlt,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <span style={{ color: colors.text }}>Listener {vote.listenerId}</span>
                        <strong style={{
                          color: colors.darkPink,
                          textDecoration: vote.vote === "REJECT" ? "underline dashed" : "none",
                        }}>{vote.vote}</strong>
                      </div>
                      {vote.reason && <div style={{ color: colors.muted, marginTop: 6 }}>{vote.reason}</div>}
                      <div style={{ color: colors.muted, marginTop: 6 }}>{dateTime(vote.votedAt)}</div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </>
      )}

      <footer style={{
        color: colors.muted, textAlign: "center", fontSize: 11,
        marginTop: 28, paddingBottom: 12,
      }}>
        Smart Listener research prototype · Local development · [SIMULATED] destination ·
        Metrics depend on API data
      </footer>

      <style>{`
        @media (max-width: 900px) {
          main > div[style*="1.6fr"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>
    </main>
  );
}
