import React, { useState, useEffect, useCallback, useRef } from "react";
import { LandingPage } from "./components/LandingPage";
import { api } from "./api";
import { TransactionDetail } from "./components/TransactionDetail";
import type { ListenerHeartbeat, Metrics, Transaction, TxStatus } from "./api";
import { SepoliaTransfer } from "./components/SepoliaTransfer";
import { ethers } from "ethers";
import { BlockchainExplorer } from "./components/BlockchainExplorer";
import type { ExplorerSnapshot } from "./api";

type Page = "landing" | "dashboard" | "submit" | "sepolia" | "explorer";

const STATUS_LIST: TxStatus[] = [
  "PENDING", "VOTED", "APPROVED", "EXECUTING",
  "EXECUTED", "FAILED", "TIMED_OUT", "REJECTED", "ROLLED_BACK",
];
const STATUS_FILTERS = [
  { value: "", label: "All statuses" },
  ...STATUS_LIST.map((status) => ({ value: status, label: status })),
  { value: "ERROR", label: "ERROR (failed/rejected/timed out)" },
] as const;

function normalizeStatus(status: string): TxStatus {
  const normalized = status.trim().toUpperCase();
  if (normalized === "ERROR") return "FAILED";
  return STATUS_LIST.includes(normalized as TxStatus)
    ? normalized as TxStatus
    : "FAILED";
}

/* ---------- Small inline icons (replace emojis, inherit text colour) ---------- */

type IconName = "overview" | "dashboard" | "send" | "refresh" | "wallet";

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
    case "wallet":
      return (
        <svg {...common}>
          <rect x="3" y="6" width="18" height="14" rx="2" />
          <path d="M3 9h15a3 3 0 0 1 3 3v4h-5a2 2 0 0 1 0-4h5" />
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
  const [search, setSearch] = useState("");

  const [destinationAddress, setDestinationAddress] = useState(
    "0xRecipientAddressOnDest"
  );
  const [senderAddress, setSenderAddress] = useState("");
  const [payload, setPayload] = useState("Hello from Smart Listener");
  const [amountEth, setAmountEth] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submittedHash, setSubmittedHash] = useState("");
  const [highlightedTransactionId, setHighlightedTransactionId] = useState("");
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [explorer, setExplorer] = useState<ExplorerSnapshot | null>(null);
  const [walletAddress, setWalletAddress] = useState("");
  const [walletBalance, setWalletBalance] = useState("");

  async function connectLocalWallet() {
    if (!window.ethereum) throw new Error("MetaMask or another browser wallet is required.");
    const provider = new ethers.BrowserProvider(window.ethereum);
    let network = await provider.getNetwork();
    if (network.chainId !== 31337n) {
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x7a69" }] });
      } catch (error) {
        const code = (error as { code?: number }).code;
        if (code !== 4902) throw error;
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x7a69",
            chainName: "Smart Listener Local Hardhat",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["http://127.0.0.1:8545"],
          }],
        });
      }
      network = await provider.getNetwork();
    }
    if (network.chainId !== 31337n) throw new Error("Wallet must be connected to local Hardhat (chain ID 31337).");
    const signer = await provider.getSigner();
    const address = await signer.getAddress();
    setWalletAddress(address);
    if (!senderAddress) setSenderAddress(address);
    setWalletBalance(ethers.formatEther(await provider.getBalance(address)));
  }

  const loadDashboard = useCallback(async () => {
    setLoading(true);

    try {
      const [txResult, listenerResult, metricsResult] = await Promise.all([
        api.getTransactions({ limit: 200 }),
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

  const loadExplorer = useCallback(async () => {
    try {
      const [snapshot, txResult] = await Promise.all([
        api.getExplorer(),
        api.getTransactions({ limit: 200 }),
      ]);
      setExplorer(snapshot);
      setTransactions(txResult.transactions);
      setListeners(snapshot.listeners);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load explorer state.");
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
    void loadExplorer();

    const refresh = window.setInterval(() => {
      void loadDashboard();
      void loadExplorer();
    }, 5000);

    return () => {
      window.clearInterval(refresh);
      ws.close();
      wsRef.current = null;
    };
  }, [connectWs, loadDashboard, loadExplorer]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setNotice("");
    setSubmittedHash("");

    try {
      const sender = senderAddress.trim();
      const recipient = destinationAddress.trim();
      if (!ethers.isAddress(sender)) throw new Error("Enter a valid sender Ethereum address.");
      if (!ethers.isAddress(recipient)) throw new Error("Enter a valid recipient Ethereum address.");
      if (!payload.trim()) throw new Error("Payload is required.");
      let value = 0n;
      try {
        value = ethers.parseEther(amountEth.trim());
      } catch {
        throw new Error("Enter a valid ETH amount, for example 0.01.");
      }
      if (value <= 0n) throw new Error("ETH amount must be greater than zero.");
      if (!window.ethereum) throw new Error("Connect the sender's local Hardhat wallet before submitting.");

      const provider = new ethers.BrowserProvider(window.ethereum);
      const network = await provider.getNetwork();
      if (network.chainId !== 31337n) {
        throw new Error("MetaMask must be connected to Local Hardhat chain ID 31337.");
      }
      const signer = await provider.getSigner();
      const connectedAddress = await signer.getAddress();
      if (connectedAddress.toLowerCase() !== sender.toLowerCase()) {
        throw new Error(`Connected wallet ${connectedAddress} does not match the sender address.`);
      }

      const balance = await provider.getBalance(sender);
      const deployment = await api.getDeployment();
      const contractAddress = deployment.contracts.SenderContract;
      if (!contractAddress) throw new Error("SenderContract is not deployed. Run npm run dev first.");
      const senderContract = new ethers.Contract(contractAddress, [
        "function sendCrossChainTransaction(bytes32,bytes,bytes) payable returns (bytes32)",
      ], signer);
      const destinationBytes = ethers.getBytes(recipient);
      const gasLimit = await senderContract.sendCrossChainTransaction.estimateGas(
        ethers.encodeBytes32String("simulated-evm-chain"),
        destinationBytes,
        ethers.toUtf8Bytes(payload),
        { value },
      );
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      const estimatedFee = gasLimit * gasPrice;
      if (balance < value + estimatedFee) {
        throw new Error("Sender balance is insufficient for the ETH amount plus estimated gas.");
      }

      const tx = await senderContract.sendCrossChainTransaction(
        ethers.encodeBytes32String("simulated-evm-chain"),
        destinationBytes,
        ethers.toUtf8Bytes(payload),
        { value },
      );
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("The source transaction failed.");
      const sourceHash = receipt.hash ?? tx.hash;
      const eventInterface = new ethers.Interface([
        "event TransactionSent(bytes32 indexed txId,address indexed sender,bytes32 indexed destinationChainId,bytes destinationAddress,bytes payload,uint256 nonce,uint256 timestamp,uint256 amount,uint256 deadline)",
      ]);
      const event = receipt.logs
        .map((log: ethers.Log): ethers.LogDescription | null => {
          try {
            return eventInterface.parseLog({ topics: [...log.topics], data: log.data });
          } catch {
            return null;
          }
        })
        .find((parsed: ethers.LogDescription | null) => parsed?.name === "TransactionSent");
      const txId = event?.args?.txId;
      if (!txId) throw new Error("Source transaction succeeded, but its protocol event could not be decoded.");

      setWalletBalance(ethers.formatEther(await provider.getBalance(sender)));
      setSubmittedHash(sourceHash);
      setHighlightedTransactionId(String(txId));
      setNotice("Source transaction mined. Listeners are independently validating it before destination execution.");
      await loadDashboard();
      await loadExplorer();
      setPage("explorer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit the transaction.");
    } finally {
      setSubmitting(false);
    }
  }

  const visibleTransactions = transactions.filter((tx) => {
    const status = normalizeStatus(tx.status);
    const matchesStatus = !filter
      || (filter === "ERROR" && ["FAILED", "REJECTED", "TIMED_OUT"].includes(status))
      || status === filter;
    const needle = search.trim().toLowerCase();
    const matchesSearch = !needle || [
      tx.txId, tx.sender, tx.destinationAddress, tx.sourceTransactionHash ?? "", tx.destTxHash ?? "",
    ].some((value) => value.toLowerCase().includes(needle));
    return matchesStatus && matchesSearch;
  });

  async function openTransaction(txId: string) {
    setDetailLoading(true);
    setError("");
    try {
      setSelectedTransaction(await api.getTransaction(txId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load transaction details.");
    } finally {
      setDetailLoading(false);
    }
  }

  const navItems: { page: Page; label: string; icon: IconName }[] = [
    { page: "landing", label: "Overview", icon: "overview" },
    { page: "dashboard", label: "Dashboard", icon: "dashboard" },
    { page: "explorer", label: "Explorer / Accounts", icon: "wallet" },
    { page: "submit", label: "Submit transaction", icon: "send" },
    { page: "sepolia", label: "Sepolia transfer", icon: "wallet" },
  ];

  const metricCards: [string, string | number][] = metrics
    ? [
        ["Total transactions", metrics.totalTransactions],
        ["Pending", metrics.pending],
        ["Approved", metrics.approved],
        ["Executed", metrics.executed],
        ["Failed", metrics.failed],
        ["Rejected", metrics.rejected],
        ["Timed out", metrics.timedOut],
        ["Rolled back", metrics.rolledBack],
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
                if (target === "explorer") void loadExplorer();
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

        {page === "sepolia" && <SepoliaTransfer />}

        {page === "explorer" && (
          <BlockchainExplorer
            snapshot={explorer}
            transactions={transactions}
            highlightedTransactionId={highlightedTransactionId}
            onRefresh={loadExplorer}
            onOpenTransaction={openTransaction}
          />
        )}

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
                  <input
                    id="transaction-search"
                    aria-label="Search transactions"
                    placeholder="Search ID, address, or hash"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                  />
                  <select
                    id="status-filter"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    {STATUS_FILTERS.map((status) => (
                      <option key={status.value} value={status.value}>{status.label}</option>
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
                      <th>Destination chain</th>
                      <th>Destination</th>
                      <th>Status</th>
                      <th>Destination tx</th>
                      <th>Votes</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTransactions.map((tx) => (
                      <tr
                        key={tx.txId}
                        onClick={() => void openTransaction(tx.txId)}
                        style={{ cursor: "pointer" }}
                      >
                        <td className="mono-cell" title={tx.txId}>
                          {tx.txId.slice(0, 12)}…
                        </td>
                        <td className="mono-cell table-chain" title={tx.destinationChainId}>{tx.destinationChainId}</td>
                        <td className="mono-cell table-address" title={tx.destinationAddress}>{tx.destinationAddress}</td>
                        <td className="table-status"><StatusBadge status={normalizeStatus(tx.status)} /></td>
                        <td className="mono-cell" title={tx.destTxHash}>
                          {tx.destTxHash ? `${tx.destTxHash.slice(0, 12)}…` : "—"}
                        </td>
                        <td className="table-votes">{tx.approveVotes ?? 0} / 3 approve</td>
                        <td className="table-error" title={tx.errorMessage}>{tx.errorMessage || "—"}</td>
                      </tr>
                    ))}
                    {!loading && visibleTransactions.length === 0 && (
                      <tr>
                        <td colSpan={7} className="empty-state">
                          {loading ? "Loading transactions…" : filter ? "No transactions found for this status." : "No transactions found."}
                        </td>
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
                    <label htmlFor="sender-address">Sender address</label>
                    <input
                      id="sender-address"
                      value={senderAddress}
                      onChange={(event) => setSenderAddress(event.target.value)}
                      required
                      placeholder="0x…"
                    />
                    <p className="form-hint">
                      This address must match the account connected in MetaMask. The backend will never substitute its own account.
                    </p>
                    <button className="btn-secondary" type="button" onClick={() => void connectLocalWallet()}>
                      <Icon name="wallet" />
                      {walletAddress ? `${walletAddress.slice(0, 10)}… (${walletBalance} ETH)` : "Connect local MetaMask account"}
                    </button>
                  </div>
                  <div className="form-group">
                    <label htmlFor="destination">Recipient address</label>
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
                    <label htmlFor="amount-eth">ETH amount</label>
                    <input
                      id="amount-eth"
                      type="text"
                      inputMode="decimal"
                      value={amountEth}
                      onChange={(event) => setAmountEth(event.target.value)}
                      required
                      placeholder="0.01"
                    />
                    <p className="form-hint">The sender must have enough ETH for the transfer and source-chain gas.</p>
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
                    <li>Four independent listeners validate the event and cast votes.</li>
                    <li>Three matching approval votes (a strict majority of four) are required.</li>
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

      {detailLoading && <div className="detail-loading" role="status">Loading transaction details…</div>}
      {selectedTransaction && (
        <TransactionDetail
          tx={selectedTransaction}
          onClose={() => setSelectedTransaction(null)}
        />
      )}

      <footer className="footer">
        <span>
          Smart Listener · Bigiotti et al. (2025) · Majority-vote variant of the Smart Listeners protocol
        </span>
        <span className="footer-note">
          Local EVM destination · No cross-chain atomicity guarantee
        </span>
      </footer>
    </div>
  );
}