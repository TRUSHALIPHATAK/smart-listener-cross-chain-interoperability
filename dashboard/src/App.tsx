import React, { useState, useEffect, useCallback, useRef } from "react";
import { LandingPage } from "./components/LandingPage";
import { Dashboard } from "./components/Dashboard";
import { SubmitTransaction } from "./components/SubmitTransaction";

type Page = "landing" | "dashboard" | "submit";

export default function App() {
  const [page, setPage] = useState<Page>("landing");
  const [wsStatus, setWsStatus] = useState<"connecting" | "connected" | "disconnected">("disconnected");
  const wsRef = useRef<WebSocket | null>(null);

  // ── WebSocket live push ────────────────────────────────────────────────────
  const connectWs = useCallback(() => {
    setWsStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onopen  = () => setWsStatus("connected");
    ws.onclose = () => {
      setWsStatus("disconnected");
      setTimeout(connectWs, 3000);
    };
    ws.onerror = () => ws.close();
    return ws;
  }, []);

  useEffect(() => {
    const ws = connectWs();
    return () => { ws.close(); wsRef.current = null; };
  }, [connectWs]);

  return (
    <div className="app">
      {/* ── Top bar ─────────────────────────────────────────────────── */}
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

        <nav className="topbar-nav">
          {(["landing", "dashboard", "submit"] as Page[]).map((p) => (
            <button
              key={p}
              className={`nav-btn${page === p ? " active" : ""}`}
              onClick={() => setPage(p)}
            >
              {p === "landing" ? "🏠 Overview" : p === "dashboard" ? "📊 Dashboard" : "🚀 Submit Tx"}
            </button>
          ))}
        </nav>

        <div className="topbar-right">
          <div className="ws-indicator">
            <div className={`ws-dot ${wsStatus}`} />
            <span style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>
              {wsStatus === "connected" ? "Live" : wsStatus === "connecting" ? "Connecting…" : "Offline"}
            </span>
          </div>
        </div>
      </header>

      {/* ── Main content ─────────────────────────────────────────────── */}
      <main className="main-content">
        {page === "landing"   && <LandingPage onNavigate={setPage} />}
        {page === "dashboard" && <Dashboard wsRef={wsRef} />}
        {page === "submit"    && <SubmitTransaction onNavigate={setPage} />}
      </main>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <footer className="footer">
        <span>Smart Listener · Bigiotti et al. (2025) · Optimistic 2-of-3 Inter-Blockchain Protocol</span>
        <span className="footer-note">Simulated destination · No cross-chain atomicity guarantee</span>
      </footer>
    </div>
  );
}
