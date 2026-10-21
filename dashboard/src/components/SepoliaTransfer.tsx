import React, { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import {
  explorerAddressUrl,
  explorerTransactionUrl,
  formatBalance,
  getEthereumProvider,
  SEPOLIA_CHAIN_HEX,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_ESCROW_ABI,
} from "../sepolia";
import { api, SepoliaEscrowStatus } from "../api";

type TransferStatus = "idle" | "awaiting-wallet" | "pending" | "locked" | "completed" | "failed";
type ApiTransaction = {
  status: string;
  txId: string;
  sourceTransactionHash?: string;
  destTxHash?: string;
  votes?: Array<{ listenerId: string; vote: string; reason?: string }>;
  approveVotes: number;
  rejectVotes: number;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The Sepolia escrow transfer could not be completed.";
}

export const SepoliaTransfer: React.FC = () => {
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState<bigint | null>(null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [recipient, setRecipient] = useState("");
  const [amountEth, setAmountEth] = useState("");
  const [payload, setPayload] = useState("");
  const [status, setStatus] = useState<TransferStatus>("idle");
  const [record, setRecord] = useState<ApiTransaction | null>(null);
  const [txId, setTxId] = useState("");
  const [depositHash, setDepositHash] = useState("");
  const [recipientBeforeWei, setRecipientBeforeWei] = useState<bigint | null>(null);
  const [recipientAfterWei, setRecipientAfterWei] = useState<bigint | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [escrow, setEscrow] = useState<SepoliaEscrowStatus | null>(null);
  const provider = getEthereumProvider();

  useEffect(() => {
    void api.getDeployment()
      .then((deployment) => setEscrow(deployment.sepolia))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  const refreshWallet = useCallback(async () => {
    if (!provider) return;
    const browserProvider = new ethers.BrowserProvider(provider);
    const network = await browserProvider.getNetwork();
    setChainId(network.chainId);
    const accounts = await browserProvider.send("eth_accounts", []);
    const nextAccount = accounts[0] ?? "";
    setAccount(nextAccount);
    setBalanceWei(nextAccount ? await browserProvider.getBalance(nextAccount) : null);
  }, [provider]);

  useEffect(() => {
    void refreshWallet();
    if (!provider?.on) return;
    const changed = () => void refreshWallet();
    provider.on("accountsChanged", changed);
    provider.on("chainChanged", changed);
    return () => {
      provider.removeListener?.("accountsChanged", changed);
      provider.removeListener?.("chainChanged", changed);
    };
  }, [provider, refreshWallet]);

  useEffect(() => {
    if (!txId || !depositHash || status === "completed" || status === "failed") return;
    const poll = async () => {
      try {
        const response = await fetch(`/api/transactions/${txId}`);
        if (!response.ok) return;
        const next = await response.json() as ApiTransaction;
        setRecord(next);
        if (next.status === "EXECUTED") {
          setStatus("completed");
          if (provider && recipient) {
            const browserProvider = new ethers.BrowserProvider(provider);
            setRecipientAfterWei(await browserProvider.getBalance(recipient));
            setBalanceWei(await browserProvider.getBalance(account));
          }
          setNotice("Listener consensus was verified and the escrow released funds to the recipient.");
        } else if (["REJECTED", "TIMED_OUT", "FAILED", "ROLLED_BACK"].includes(next.status)) {
          setStatus("failed");
          setError(`Escrow transaction ended with status ${next.status}. Funds remain protected by the contract refund rules.`);
        } else {
          setStatus("locked");
          setNotice(`Escrow locked. Listener approvals: ${next.approveVotes}/3.`);
        }
      } catch {
        // A transient API outage must not turn a confirmed deposit into a false failure.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => window.clearInterval(timer);
  }, [account, depositHash, provider, recipient, status, txId]);

  async function connectWallet() {
    setError("");
    if (!provider) return setError("MetaMask was not detected. Install MetaMask and reload this page.");
    try {
      await provider.request({ method: "eth_requestAccounts" });
      await refreshWallet();
    } catch (err) { setError(errorMessage(err)); }
  }

  async function switchToSepolia() {
    if (!provider) return;
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: SEPOLIA_CHAIN_HEX }] });
      await refreshWallet();
    } catch (err) { setError(errorMessage(err)); }
  }

  async function submitTransfer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "awaiting-wallet" || status === "pending" || status === "locked") return;
    setError(""); setNotice(""); setRecord(null); setDepositHash(""); setTxId("");
    try {
      if (!provider || !account) throw new Error("Connect MetaMask before depositing.");
      if (chainId !== SEPOLIA_CHAIN_ID) throw new Error("Switch MetaMask to Sepolia before depositing.");
      if (!escrow?.verified || !escrow.escrowAddress || !ethers.isAddress(escrow.escrowAddress)) {
        throw new Error(escrow?.error ?? "The Sepolia escrow is not configured and verified by the listener API.");
      }
      if (!ethers.isAddress(recipient.trim())) throw new Error("Enter a valid recipient address.");
      const amountWei = ethers.parseEther(amountEth.trim());
      if (amountWei <= 0n) throw new Error("The ETH amount must be greater than zero.");
      const browserProvider = new ethers.BrowserProvider(provider);
      const signer = await browserProvider.getSigner();
      const recipientAddress = ethers.getAddress(recipient.trim());
      const before = await browserProvider.getBalance(recipientAddress);
      setRecipientBeforeWei(before);
      const id = ethers.hexlify(ethers.randomBytes(32));
      const payloadHash = ethers.keccak256(ethers.toUtf8Bytes(payload));
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const nonce = BigInt(Date.now());
      const escrowContract = new ethers.Contract(escrow.escrowAddress, SEPOLIA_ESCROW_ABI, signer);
      const feeData = await browserProvider.getFeeData();
      const runtimeCode = await browserProvider.getCode(escrow.escrowAddress);
      if (runtimeCode === "0x") throw new Error("The configured Sepolia escrow address has no contract bytecode on the connected chain.");
      const gasLimit = await escrowContract.deposit.estimateGas(id, recipientAddress, payloadHash, deadline, nonce, { value: amountWei });
      const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
      const senderBalance = await browserProvider.getBalance(account);
      if (senderBalance < amountWei + gasLimit * gasPrice) throw new Error("The connected wallet does not have enough ETH for the deposit plus estimated gas.");
      setStatus("awaiting-wallet");
      setNotice("Review and approve the escrow deposit in MetaMask. ETH will remain locked until listener consensus.");
      const tx = await escrowContract.deposit(id, recipientAddress, payloadHash, deadline, nonce, { value: amountWei });
      setStatus("pending"); setTxId(id); setDepositHash(tx.hash);
      setNotice(`Deposit submitted. Waiting for confirmation: ${tx.hash}`);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) throw new Error("The Sepolia escrow deposit failed.");
      setStatus("locked");
      setNotice("ETH is locked in escrow. Waiting for independent listener validation and 3-of-4 consensus.");
    } catch (err) {
      setStatus("failed"); setError(errorMessage(err));
    }
  }

  const onSepolia = chainId === SEPOLIA_CHAIN_ID;
  const statusLabel = status === "awaiting-wallet" ? "Awaiting MetaMask approval"
    : status === "pending" ? "Deposit pending"
      : status === "locked" ? "ETH locked / validating"
        : status === "completed" ? "Completed"
          : status === "failed" ? "Failed" : "Ready";

  return (
    <div className="sepolia-page">
      <div className="page-heading"><div className="page-heading-text">
        <h1>Sepolia test ETH escrow transfer</h1>
        <p>Same-chain Sepolia transfer gated by the Smart Listener 3-of-4 consensus workflow.</p>
      </div><span className={`badge ${onSepolia ? "badge-EXECUTED" : "badge-FAILED"}`}><span className="badge-dot" />{onSepolia ? "Sepolia connected" : "Switch to Sepolia"}</span></div>
      <div className="sepolia-notice">Test ETH has no real monetary value. MetaMask signs only the escrow deposit; no private key is requested or stored. ETH is not sent directly to the recipient.</div>
      <div className="sepolia-grid">
        <section className="panel"><div className="panel-header"><div><h2 className="panel-title">Wallet</h2><p className="panel-description">Connected wallet and live Sepolia balance.</p></div>{!account && <button className="btn-primary" type="button" onClick={() => void connectWallet()}>Connect MetaMask</button>}</div>
          {account ? <div className="wallet-summary"><div><span>Address</span><strong className="mono-cell">{account}</strong></div><div><span>Network</span><strong>{onSepolia ? "Sepolia (11155111)" : `Wrong network (${chainId?.toString() ?? "unknown"})`}</strong></div><div><span>Live balance</span><strong>{balanceWei === null ? "Loading…" : `${formatBalance(balanceWei)} ETH`}</strong></div>{!onSepolia && <button className="btn-secondary" type="button" onClick={() => void switchToSepolia()}>Switch MetaMask to Sepolia</button>}</div> : <p className="empty-state">Connect MetaMask to read wallet details.</p>}
        </section>
        <section className="panel"><div className="panel-header"><div><h2 className="panel-title">Transfer details</h2><p className="panel-description">Deposit into the configured Sepolia escrow; payload is committed by hash.</p></div><span className="badge badge-PENDING"><span className="badge-dot" />{statusLabel}</span></div>
          <form className="transaction-form" onSubmit={(event) => void submitTransfer(event)}>
            <div className="form-group"><label htmlFor="sepolia-recipient">Recipient address</label><input id="sepolia-recipient" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…" required disabled={status === "pending" || status === "awaiting-wallet" || status === "locked"} /></div>
            <div className="form-group"><label htmlFor="sepolia-amount">ETH amount</label><input id="sepolia-amount" value={amountEth} onChange={(e) => setAmountEth(e.target.value)} placeholder="0.001" inputMode="decimal" required disabled={status === "pending" || status === "awaiting-wallet" || status === "locked"} /><p className="form-hint">The wallet is checked against deposit value plus estimated escrow gas.</p></div>
            <div className="form-group"><label htmlFor="sepolia-payload">Optional payload metadata</label><textarea id="sepolia-payload" value={payload} onChange={(e) => setPayload(e.target.value)} placeholder="Optional note committed by hash" rows={3} disabled={status === "pending" || status === "awaiting-wallet" || status === "locked"} /><p className="form-hint">The plaintext is not sent; its keccak256 hash is included in the escrow authorization.</p></div>
            <button className="btn-primary" type="submit" disabled={!account || !onSepolia || status === "pending" || status === "awaiting-wallet" || status === "locked"}>{status === "pending" ? "Waiting for deposit…" : status === "awaiting-wallet" ? "Approve in MetaMask…" : "Deposit into escrow"}</button>
          </form>
          {error && <p className="message error" role="alert">{error}</p>}{notice && <p className="message" role="status">{notice}</p>}
        </section>
      </div>
      {(txId || record) && <section className="panel sepolia-result"><h2 className="panel-title">Escrow transaction lifecycle</h2><div className="sepolia-result-grid">
        <div><span>Transaction ID</span><strong className="mono-cell">{txId}</strong></div>
        <div><span>Status</span><strong>{record?.status ?? statusLabel}</strong></div>
        <div><span>Deposit transaction</span><a href={explorerTransactionUrl(depositHash)} target="_blank" rel="noreferrer" className="mono-cell">{depositHash}</a></div>
        {record?.destTxHash && <div><span>Release transaction</span><a href={explorerTransactionUrl(record.destTxHash)} target="_blank" rel="noreferrer" className="mono-cell">{record.destTxHash}</a></div>}
        <div><span>Consensus</span><strong>{record ? `${record.approveVotes}/3 approvals, ${record.rejectVotes} rejections` : "Waiting for listeners"}</strong></div>
        {escrow?.escrowAddress && <div><span>Escrow contract</span><a href={explorerAddressUrl(escrow.escrowAddress)} target="_blank" rel="noreferrer" className="mono-cell">{escrow.escrowAddress}</a></div>}
        {record?.votes?.map((vote) => <div key={vote.listenerId}><span>Listener {vote.listenerId}</span><strong>{vote.vote}{vote.reason ? ` — ${vote.reason}` : ""}</strong></div>)}
        {recipientBeforeWei !== null && <div><span>Recipient balance before</span><strong>{formatBalance(recipientBeforeWei)} ETH</strong></div>}
        {recipientAfterWei !== null && <div><span>Recipient balance after</span><strong>{formatBalance(recipientAfterWei)} ETH</strong></div>}
      </div><p className="form-hint">Balance reads may reflect gas and unrelated transactions. A deposit hash is distinct from the final release hash.</p></section>}
    </div>
  );
};
