import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { api } from "../api";
import type { ExplorerAccount, ExplorerSnapshot, Transaction, Vote } from "../api";

interface Props {
  snapshot: ExplorerSnapshot | null;
  transactions: Transaction[];
  highlightedTransactionId?: string;
  onRefresh: () => Promise<void>;
  onOpenTransaction: (txId: string) => Promise<void>;
}

function short(value: string, size = 14) {
  return value.length > size ? `${value.slice(0, size)}…` : value;
}

async function copyAddress(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.focus();
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Clipboard access is unavailable in this browser.");
}

function AccountTable({
  accounts,
  copiedAddress,
  onCopy,
}: {
  accounts: ExplorerAccount[];
  copiedAddress: string;
  onCopy: (account: ExplorerAccount) => Promise<void>;
}) {
  return (
    <div className="table-wrap">
      <table className="data-table explorer-table">
        <thead>
          <tr><th>Account</th><th>Address</th><th>Balance</th><th>Copy</th></tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.address}>
              <td>{account.index}</td>
              <td className="mono-cell">{account.address}</td>
              <td>{account.balanceEth} ETH</td>
              <td>
                <button
                  type="button"
                  className="table-action"
                  onClick={() => void onCopy(account)}
                >
                  {copiedAddress === account.address ? "Copied" : "Copy address"}
                </button>
              </td>
            </tr>
          ))}
          {accounts.length === 0 && (
            <tr><td colSpan={4} className="empty-state">No local Hardhat accounts are available.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function VoteSummary({ votes }: { votes: Vote[] }) {
  const byListener = new Map(votes.map((vote) => [vote.listenerId, vote]));
  return (
    <div className="listener-grid">
      {(["A", "B", "C", "D"] as const).map((listenerId) => {
        const vote = byListener.get(listenerId);
        return (
          <div className="listener-card" key={listenerId}>
            <div className="listener-card-header">
              <h3>Listener {listenerId}</h3>
              <span className={`badge ${vote?.vote === "APPROVE" ? "badge-EXECUTED" : vote?.vote === "REJECT" ? "badge-REJECTED" : "badge-PENDING"}`}>
                <span className="badge-dot" /> {vote?.vote ?? "PENDING"}
              </span>
            </div>
            <div className="listener-detail">
              <span>Decision</span>
              <strong>{vote?.reason ?? (vote ? "Validated" : "Waiting for vote")}</strong>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export const BlockchainExplorer: React.FC<Props> = ({
  snapshot,
  transactions,
  highlightedTransactionId,
  onRefresh,
  onOpenTransaction,
}) => {
  const [copiedAddress, setCopiedAddress] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [copyError, setCopyError] = useState("");
  const [search, setSearch] = useState("");
  const [highlightedTransaction, setHighlightedTransaction] = useState<Transaction | null>(null);
  const [resultLoading, setResultLoading] = useState(false);

  const accounts = snapshot?.source.accounts ?? [];
  const filteredTransactions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return transactions;
    return transactions.filter((tx) => [
      tx.txId, tx.sender, tx.destinationAddress,
      tx.sourceTransactionHash ?? "", tx.destTxHash ?? "",
    ].some((value) => value.toLowerCase().includes(needle)));
  }, [search, transactions]);

  useEffect(() => {
    if (!highlightedTransactionId) {
      setHighlightedTransaction(null);
      return;
    }

    let active = true;
    const load = async () => {
      setResultLoading(true);
      try {
        const transaction = await api.getTransaction(highlightedTransactionId);
        if (active) setHighlightedTransaction(transaction);
      } catch {
        if (active) setHighlightedTransaction(null);
      } finally {
        if (active) setResultLoading(false);
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [highlightedTransactionId]);

  async function handleCopy(account: ExplorerAccount) {
    setCopyError("");
    try {
      await copyAddress(account.address);
      setCopiedAddress(account.address);
      setCopyMessage(`Copied ${account.address} to the clipboard.`);
      window.setTimeout(() => setCopiedAddress(""), 1800);
    } catch (error) {
      setCopyMessage("");
      setCopyError(error instanceof Error ? error.message : "Unable to copy the address.");
    }
  }

  async function refresh() {
    setCopyMessage("");
    setCopyError("");
    await onRefresh();
  }

  return (
    <div className="explorer-page">
      <div className="page-heading">
        <div className="page-heading-text">
          <h1>Local Accounts</h1>
          <p>Live Hardhat accounts, balances, and Smart Listener transaction results.</p>
        </div>
        <button className="btn-secondary" type="button" onClick={() => void refresh()}>
          Refresh accounts
        </button>
      </div>

      {copyMessage && <p className="message" role="status">{copyMessage}</p>}
      {copyError && <p className="message error" role="alert">{copyError}</p>}
      {!snapshot && <p className="message">Loading local accounts…</p>}
      {snapshot && (
        <>
          {!snapshot.source.connected && (
            <p className="message error" role="alert">
              The local Hardhat source RPC is unavailable{snapshot.source.error ? `: ${snapshot.source.error}` : "."}
            </p>
          )}
          <section className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">Hardhat accounts</h2>
                <p className="panel-description">
                  {accounts.length} account{accounts.length === 1 ? "" : "s"} from {snapshot.source.rpcUrl ?? "the local RPC"}.
                </p>
              </div>
              <span className="badge badge-PENDING">
                <span className="badge-dot" /> {snapshot.requiredVotes}-of-{snapshot.totalListeners} consensus
              </span>
            </div>
            <AccountTable accounts={accounts} copiedAddress={copiedAddress} onCopy={handleCopy} />
          </section>

          {highlightedTransactionId && (
            <section className="panel">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">Transfer result</h2>
                  <p className="panel-description">Live protocol state for the submitted transaction.</p>
                </div>
                {highlightedTransaction && (
                  <span className={`badge badge-${highlightedTransaction.status}`}>
                    <span className="badge-dot" /> {highlightedTransaction.status}
                  </span>
                )}
              </div>
              {resultLoading && !highlightedTransaction && <p className="message">Loading transaction status…</p>}
              {highlightedTransaction && (
                <>
                  <div className="explorer-summary">
                    <span><strong>Sender</strong> <code>{highlightedTransaction.sender}</code></span>
                    <span><strong>Recipient</strong> <code>{highlightedTransaction.destinationAddress}</code></span>
                    <span><strong>Amount</strong> {ethers.formatEther(highlightedTransaction.requestedAmountWei)} ETH</span>
                    <span><strong>Consensus</strong> {highlightedTransaction.approveVotes}/{snapshot.requiredVotes} approvals</span>
                  </div>
                  <VoteSummary votes={highlightedTransaction.votes ?? []} />
                  <div className="explorer-summary">
                    <span><strong>Source transaction</strong> <code>{highlightedTransaction.sourceTransactionHash ?? "Pending"}</code></span>
                    <span><strong>Destination transaction</strong> <code>{highlightedTransaction.destTxHash ?? "Pending"}</code></span>
                  </div>
                  {highlightedTransaction.errorMessage && (
                    <p className="message error" role="alert">{highlightedTransaction.errorMessage}</p>
                  )}
                  <button className="btn-secondary" type="button" onClick={() => void onOpenTransaction(highlightedTransaction.txId)}>
                    Open full transaction detail
                  </button>
                </>
              )}
            </section>
          )}

          <section className="panel">
            <div className="panel-header">
              <div>
                <h2 className="panel-title">Transaction history</h2>
                <p className="panel-description">Actual source and destination hashes from the persisted protocol state.</p>
              </div>
              <input
                className="explorer-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search address, ID, or hash"
              />
            </div>
            <div className="table-wrap">
              <table className="data-table explorer-table">
                <thead>
                  <tr><th>Transaction</th><th>Sender → recipient</th><th>Amount</th><th>Consensus</th><th>Status</th><th>Source / destination</th></tr>
                </thead>
                <tbody>
                  {filteredTransactions.map((tx) => (
                    <tr key={tx.txId} onClick={() => void onOpenTransaction(tx.txId)} style={{ cursor: "pointer" }}>
                      <td className="mono-cell">{short(tx.txId)}</td>
                      <td className="mono-cell">{short(tx.sender, 12)} → {short(tx.destinationAddress, 12)}</td>
                      <td>{tx.transferMode === "ETH_TRANSFER" ? `${ethers.formatEther(tx.requestedAmountWei)} ETH` : "—"}</td>
                      <td>{tx.approveVotes}/{snapshot.requiredVotes}</td>
                      <td><span className={`badge badge-${tx.status}`}><span className="badge-dot" />{tx.status}</span></td>
                      <td className="mono-cell">{short(tx.sourceTransactionHash ?? "pending", 12)} / {short(tx.destTxHash ?? "pending", 12)}</td>
                    </tr>
                  ))}
                  {filteredTransactions.length === 0 && (
                    <tr><td colSpan={6} className="empty-state">No persisted transactions match this search.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
};
