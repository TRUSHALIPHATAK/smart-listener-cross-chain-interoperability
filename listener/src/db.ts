/**
 * db.ts — Storage abstraction layer
 *
 * Automatically uses:
 *   • PostgreSQL if DATABASE_URL is set (production)
 *   • SQLite via sql.js otherwise (development, no native build tools)
 *
 * Both backends use the identical schema.
 *
 * sql.js is in-memory WASM SQLite. To support multiple Node processes
 * (3 listeners + API), each mutating call acquires a short file lock,
 * reloads from disk, runs the SQL, then persists back to disk.
 */

import * as fs from "fs";
import * as path from "path";
import { DATABASE_URL, SQLITE_PATH } from "./config";
import { CrossChainTransaction, ListenerVote, ListenerHeartbeat, TxStatus, ListenerId, VoteValue } from "./types";

const DEFAULT_STATUS_PREDECESSORS: Partial<Record<TxStatus, TxStatus[]>> = {
  EXECUTING: ["APPROVED", "EXECUTING"],
  EXECUTED: ["APPROVED", "EXECUTING"],
  FAILED: ["EXECUTING"],
  TIMED_OUT: ["PENDING", "VOTED", "APPROVED", "EXECUTING"],
  REJECTED: ["PENDING", "VOTED", "APPROVED"],
  ROLLED_BACK: ["TIMED_OUT"],
};

// ── Schema DDL ────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS transactions (
  tx_id                TEXT PRIMARY KEY,
  sender               TEXT NOT NULL,
  destination_chain_id TEXT NOT NULL,
  destination_address  TEXT NOT NULL,
  payload              TEXT NOT NULL,
  nonce                TEXT NOT NULL,
  source_timestamp     INTEGER NOT NULL,
  source_block_number  INTEGER NOT NULL,
  source_transaction_hash TEXT,
  source_block_hash    TEXT,
  payload_text         TEXT,
  payload_hash         TEXT,
  transfer_mode        TEXT NOT NULL DEFAULT 'MESSAGE_ONLY',
  requested_amount_wei TEXT NOT NULL DEFAULT '0',
  source_value_wei     TEXT NOT NULL DEFAULT '0',
  transferred_amount_wei TEXT,
  destination_confirmation INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'PENDING',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  dest_tx_hash         TEXT,
  error_message        TEXT,
  rollback_tx_hash     TEXT,
  approve_votes        INTEGER NOT NULL DEFAULT 0,
  reject_votes         INTEGER NOT NULL DEFAULT 0,
  deadline             TEXT
);

CREATE TABLE IF NOT EXISTS votes (
  tx_id       TEXT NOT NULL,
  listener_id TEXT NOT NULL,
  vote        TEXT NOT NULL,
  reason      TEXT,
  voted_at    INTEGER NOT NULL,
  signer_address TEXT,
  signature TEXT,
  digest TEXT,
  PRIMARY KEY (tx_id, listener_id)
);

CREATE TABLE IF NOT EXISTS listener_heartbeats (
  listener_id             TEXT PRIMARY KEY,
  last_seen_at            INTEGER NOT NULL,
  source_chain_connected  INTEGER NOT NULL DEFAULT 0,
  last_processed_block    INTEGER NOT NULL DEFAULT 0,
  pending_votes           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS listener_cursors (
  listener_id             TEXT PRIMARY KEY,
  last_processed_block    INTEGER NOT NULL DEFAULT -1
);

CREATE INDEX IF NOT EXISTS idx_transactions_status     ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_votes_tx_id             ON votes(tx_id);
`;

// ── Adapter Interface ─────────────────────────────────────────────────────────

interface DbAdapter {
  /** Idempotent — only inserts if tx_id is new */
  upsertTransaction(tx: CrossChainTransaction): Promise<void>;
  getTransaction(txId: string): Promise<CrossChainTransaction | null>;
  updateTransactionStatus(txId: string, status: TxStatus, extra?: Partial<CrossChainTransaction>, from?: TxStatus[]): Promise<boolean>;
  /**
   * Atomic compare-and-set: moves the tx to `to` only if its current status is in `from`.
   * Returns true if THIS call performed the transition (used to elect exactly one executor).
   */
  transitionStatus(txId: string, from: TxStatus[], to: TxStatus, extra?: Partial<CrossChainTransaction>): Promise<boolean>;
  /** Largest updated_at across transactions (0 if none) — used to push WebSocket updates */
  getLastUpdatedAt(): Promise<number>;
  listTransactions(opts?: { status?: TxStatus; limit?: number; offset?: number }): Promise<CrossChainTransaction[]>;
  countTransactions(status?: TxStatus): Promise<number>;

  recordVote(vote: ListenerVote): Promise<void>;
  getVotes(txId: string): Promise<ListenerVote[]>;
  hasVoted(txId: string, listenerId: ListenerId): Promise<boolean>;
  getTransactionBySenderNonce(sender: string, nonce: string): Promise<CrossChainTransaction | null>;

  upsertHeartbeat(hb: ListenerHeartbeat): Promise<void>;
  getHeartbeats(): Promise<ListenerHeartbeat[]>;
  getListenerCursor(listenerId: ListenerId): Promise<number | null>;
  resetListenerCursor(listenerId: ListenerId): Promise<void>;
  advanceListenerCursor(listenerId: ListenerId, blockNumber: number): Promise<boolean>;

  /** Transactions that have been PENDING/VOTED longer than cutoffMs */
  getTimedOutTransactions(cutoffMs: number): Promise<CrossChainTransaction[]>;
  getRollbackCandidates(cutoffMs: number): Promise<CrossChainTransaction[]>;
  /** Average execution latency in ms for EXECUTED txns in last windowMs */
  getAvgLatencyMs(windowMs: number): Promise<number>;
  /** Count of EXECUTED txns in last windowMs */
  getThroughput(windowMs: number): Promise<number>;

  close(): Promise<void>;
}

// ── Row Mappers ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToTx(row: any): CrossChainTransaction {
  return {
    txId:                row.tx_id,
    sender:              row.sender,
    destinationChainId:  row.destination_chain_id,
    destinationAddress:  row.destination_address,
    payload:             row.payload,
    nonce:               row.nonce,
    deadline:            row.deadline ?? undefined,
    sourceTimestamp:     Number(row.source_timestamp),
    sourceBlockNumber:   Number(row.source_block_number),
    sourceTransactionHash: row.source_transaction_hash ?? undefined,
    sourceBlockHash:      row.source_block_hash ?? undefined,
    payloadText:          row.payload_text ?? undefined,
    payloadHash:          row.payload_hash ?? undefined,
    transferMode:         row.transfer_mode === "ETH_TRANSFER" ? "ETH_TRANSFER" : "MESSAGE_ONLY",
    requestedAmountWei:   String(row.requested_amount_wei ?? "0"),
    sourceValueWei:       String(row.source_value_wei ?? "0"),
    transferredAmountWei: row.transferred_amount_wei ?? undefined,
    destinationConfirmation: row.destination_confirmation === 1 || row.destination_confirmation === true,
    status:              row.status as TxStatus,
    createdAt:           Number(row.created_at),
    updatedAt:           Number(row.updated_at),
    destTxHash:          row.dest_tx_hash ?? undefined,
    errorMessage:        row.error_message ?? undefined,
    rollbackTxHash:       row.rollback_tx_hash ?? undefined,
    approveVotes:        Number(row.computed_approve_votes ?? row.approve_votes),
    rejectVotes:         Number(row.computed_reject_votes ?? row.reject_votes),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToVote(row: any): ListenerVote {
  return {
    txId:       row.tx_id,
    listenerId: row.listener_id as ListenerId,
    vote:       row.vote as VoteValue,
    reason:     row.reason ?? undefined,
    votedAt:    Number(row.voted_at),
    signerAddress: row.signer_address ?? undefined,
    signature: row.signature ?? undefined,
    digest: row.digest ?? undefined,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToHb(row: any): ListenerHeartbeat {
  return {
    listenerId:           row.listener_id as ListenerId,
    lastSeenAt:           Number(row.last_seen_at),
    sourceChainConnected: row.source_chain_connected === 1 || row.source_chain_connected === true,
    lastProcessedBlock:   Number(row.last_processed_block),
    pendingVotes:         Number(row.pending_votes),
  };
}

// ── File lock helpers (cross-process, Windows-friendly) ───────────────────────

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function acquireLock(lockPath: string, timeoutMs = 5000): Promise<() => void> {
  const start = Date.now();
  let delay = 5;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      // Stale lock recovery: if older than 10s, remove it
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 10_000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch { /* ignore */ }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out acquiring DB lock: ${lockPath}`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 50);
    }
  }
}

// ── SQLite Adapter (sql.js) ───────────────────────────────────────────────────

class SqliteAdapter implements DbAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private SQL: any;
  private dbPath: string;
  private lockPath: string;
  private mtimeMs = 0;

  private constructor(SQL: unknown, dbPath: string) {
    this.SQL = SQL;
    this.dbPath = dbPath;
    this.lockPath = dbPath + ".lock";
  }

  static async create(dbPath: string): Promise<SqliteAdapter> {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const initSqlJs = require("sql.js");
    // Resolve wasm relative to the sql.js main entry (exports block package.json)
    const sqlJsEntry = require.resolve("sql.js");
    const wasmPath = path.join(path.dirname(sqlJsEntry), "sql-wasm.wasm");
    const SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });

    const adapter = new SqliteAdapter(SQL, dbPath);
    const release = await acquireLock(adapter.lockPath);
    try {
      adapter.loadFromDisk();
      adapter.db.exec(SCHEMA_SQL);
      adapter.ensureColumns();
      adapter.persistToDisk();
    } finally {
      release();
    }
    return adapter;
  }

  private loadFromDisk(): void {
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new this.SQL.Database(buffer);
      this.mtimeMs = fs.statSync(this.dbPath).mtimeMs;
    } else {
      this.db = new this.SQL.Database();
      this.mtimeMs = 0;
    }
  }

  private persistToDisk(): void {
    const data = this.db.export();
    const tmp = this.dbPath + ".tmp";
    fs.writeFileSync(tmp, Buffer.from(data));
    // Atomic-ish replace on Windows: unlink then rename if needed
    try {
      fs.renameSync(tmp, this.dbPath);
    } catch {
      fs.copyFileSync(tmp, this.dbPath);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    this.mtimeMs = fs.statSync(this.dbPath).mtimeMs;
  }

  private reloadIfStale(): void {
    if (!fs.existsSync(this.dbPath)) return;
    const mtime = fs.statSync(this.dbPath).mtimeMs;
    if (mtime !== this.mtimeMs) {
      try { this.db.close(); } catch { /* ignore */ }
      this.loadFromDisk();
    }
  }

  /** Run a mutating operation under lock with reload + persist */
  private async withWrite<T>(fn: () => T): Promise<T> {
    const release = await acquireLock(this.lockPath);
    try {
      this.reloadIfStale();
      const result = fn();
      this.persistToDisk();
      return result;
    } finally {
      release();
    }
  }

  /** Run a read under lock with reload (ensures fresh data) */
  private async withRead<T>(fn: () => T): Promise<T> {
    const release = await acquireLock(this.lockPath);
    try {
      this.reloadIfStale();
      return fn();
    } finally {
      release();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queryAll(sql: string, params: unknown[] = []): any[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queryOne(sql: string, params: unknown[] = []): any | null {
    const rows = this.queryAll(sql, params);
    return rows[0] ?? null;
  }

  private run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params);
  }

  private ensureColumns(): void {
    const columns = this.queryAll("PRAGMA table_info(transactions)").map((row) => row.name);
    if (!columns.includes("source_transaction_hash")) {
      this.run("ALTER TABLE transactions ADD COLUMN source_transaction_hash TEXT");
    }
    if (!columns.includes("source_block_hash")) {
      this.run("ALTER TABLE transactions ADD COLUMN source_block_hash TEXT");
    }
    for (const [name, definition] of [
      ["payload_text", "TEXT"],
      ["payload_hash", "TEXT"],
      ["transfer_mode", "TEXT NOT NULL DEFAULT 'MESSAGE_ONLY'"],
      ["requested_amount_wei", "TEXT NOT NULL DEFAULT '0'"],
      ["source_value_wei", "TEXT NOT NULL DEFAULT '0'"],
      ["transferred_amount_wei", "TEXT"],
      ["destination_confirmation", "INTEGER NOT NULL DEFAULT 0"],
      ["rollback_tx_hash", "TEXT"],
      ["deadline", "TEXT"],
    ]) {
      if (!columns.includes(name)) this.run(`ALTER TABLE transactions ADD COLUMN ${name} ${definition}`);
    }
    const voteColumns = this.queryAll("PRAGMA table_info(votes)").map((row) => row.name);
    for (const [name, definition] of [["signer_address", "TEXT"], ["signature", "TEXT"], ["digest", "TEXT"]]) {
      if (!voteColumns.includes(name)) this.run(`ALTER TABLE votes ADD COLUMN ${name} ${definition}`);
    }
  }

  async upsertTransaction(tx: CrossChainTransaction): Promise<void> {
    await this.withWrite(() => {
      this.run(`
        INSERT INTO transactions
          (tx_id, sender, destination_chain_id, destination_address, payload, nonce,
           source_timestamp, source_block_number, status, created_at, updated_at,
           source_transaction_hash, source_block_hash, payload_text, payload_hash,
           transfer_mode, requested_amount_wei, source_value_wei, transferred_amount_wei,
           destination_confirmation, approve_votes, reject_votes, deadline)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tx_id) DO UPDATE SET
          source_transaction_hash = COALESCE(transactions.source_transaction_hash, excluded.source_transaction_hash),
          source_block_hash = COALESCE(transactions.source_block_hash, excluded.source_block_hash),
          payload_text = COALESCE(transactions.payload_text, excluded.payload_text),
          payload_hash = COALESCE(transactions.payload_hash, excluded.payload_hash),
          transfer_mode = CASE WHEN excluded.transfer_mode = 'ETH_TRANSFER' THEN excluded.transfer_mode ELSE transactions.transfer_mode END,
          requested_amount_wei = CASE WHEN excluded.requested_amount_wei <> '0' THEN excluded.requested_amount_wei ELSE transactions.requested_amount_wei END,
          source_value_wei = CASE WHEN excluded.source_value_wei <> '0' THEN excluded.source_value_wei ELSE transactions.source_value_wei END
      `, [
        tx.txId, tx.sender, tx.destinationChainId, tx.destinationAddress,
        tx.payload, tx.nonce, tx.sourceTimestamp, tx.sourceBlockNumber,
        tx.status, tx.createdAt, tx.updatedAt, tx.sourceTransactionHash ?? null,
        tx.sourceBlockHash ?? null, tx.payloadText ?? null, tx.payloadHash ?? null,
        tx.transferMode ?? "MESSAGE_ONLY", tx.requestedAmountWei ?? "0", tx.sourceValueWei ?? "0",
        tx.transferredAmountWei ?? null, tx.destinationConfirmation ? 1 : 0,
        tx.approveVotes, tx.rejectVotes, tx.deadline ?? null,
      ]);
    });
  }

  async getTransaction(txId: string): Promise<CrossChainTransaction | null> {
    return this.withRead(() => {
      const row = this.queryOne(`
        SELECT t.*,
          (SELECT COUNT(*) FROM votes v WHERE v.tx_id = t.tx_id AND v.vote = 'APPROVE') AS computed_approve_votes,
          (SELECT COUNT(*) FROM votes v WHERE v.tx_id = t.tx_id AND v.vote = 'REJECT') AS computed_reject_votes
        FROM transactions t
        WHERE t.tx_id = ?
      `, [txId]);
      return row ? rowToTx(row) : null;
    });
  }

  async updateTransactionStatus(txId: string, status: TxStatus, extra?: Partial<CrossChainTransaction>, from?: TxStatus[]): Promise<boolean> {
    const allowedFrom = from ?? DEFAULT_STATUS_PREDECESSORS[status] ?? [];
    return this.transitionStatus(txId, allowedFrom, status, extra);
  }

  async transitionStatus(txId: string, from: TxStatus[], to: TxStatus, extra?: Partial<CrossChainTransaction>): Promise<boolean> {
    return this.withWrite(() => {
      const marks = from.map(() => "?").join(",");
      this.run(`
        UPDATE transactions SET
          status = ?,
          updated_at = ?,
          dest_tx_hash  = COALESCE(?, dest_tx_hash),
          rollback_tx_hash = COALESCE(?, rollback_tx_hash),
          error_message = COALESCE(?, error_message)
          , destination_confirmation = CASE WHEN ? = 1 THEN 1 ELSE destination_confirmation END
          , transferred_amount_wei = COALESCE(?, transferred_amount_wei)
        WHERE tx_id = ? AND status IN (${marks})
      `, [to, Date.now(), extra?.destTxHash ?? null, extra?.rollbackTxHash ?? null, extra?.errorMessage ?? null,
        extra?.destinationConfirmation ? 1 : 0, extra?.transferredAmountWei ?? null, txId, ...from]);
      return this.db.getRowsModified() > 0;
    });
  }

  async getLastUpdatedAt(): Promise<number> {
    return this.withRead(() => {
      const row = this.queryOne("SELECT MAX(updated_at) as m FROM transactions");
      return Number(row?.m ?? 0);
    });
  }

  async listTransactions(opts?: { status?: TxStatus; limit?: number; offset?: number }): Promise<CrossChainTransaction[]> {
    return this.withRead(() => {
      let sql = `
        SELECT t.*,
          (SELECT COUNT(*) FROM votes v WHERE v.tx_id = t.tx_id AND v.vote = 'APPROVE') AS computed_approve_votes,
          (SELECT COUNT(*) FROM votes v WHERE v.tx_id = t.tx_id AND v.vote = 'REJECT') AS computed_reject_votes
        FROM transactions t
      `;
      const params: (string | number)[] = [];
      if (opts?.status) { sql += " WHERE t.status = ?"; params.push(opts.status); }
      sql += " ORDER BY t.created_at DESC";
      if (opts?.limit)  { sql += " LIMIT ?";  params.push(opts.limit); }
      if (opts?.offset) { sql += " OFFSET ?"; params.push(opts.offset); }
      return this.queryAll(sql, params).map(rowToTx);
    });
  }

  async countTransactions(status?: TxStatus): Promise<number> {
    return this.withRead(() => {
      if (status) {
        const row = this.queryOne("SELECT COUNT(*) as c FROM transactions WHERE status = ?", [status]);
        return Number(row?.c ?? 0);
      }
      const row = this.queryOne("SELECT COUNT(*) as c FROM transactions");
      return Number(row?.c ?? 0);
    });
  }

  async recordVote(vote: ListenerVote): Promise<void> {
    await this.withWrite(() => {
      this.run(`
        INSERT OR REPLACE INTO votes (tx_id, listener_id, vote, reason, voted_at, signer_address, signature, digest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [vote.txId, vote.listenerId, vote.vote, vote.reason ?? null, vote.votedAt,
        vote.signerAddress ?? null, vote.signature ?? null, vote.digest ?? null]);

      const agg = this.queryOne(`
        SELECT
          SUM(CASE WHEN vote = 'APPROVE' THEN 1 ELSE 0 END) as approves,
          SUM(CASE WHEN vote = 'REJECT'  THEN 1 ELSE 0 END) as rejects
        FROM votes WHERE tx_id = ?
      `, [vote.txId]);

      this.run(`
        UPDATE transactions SET approve_votes = ?, reject_votes = ?, updated_at = ? WHERE tx_id = ?
      `, [agg?.approves ?? 0, agg?.rejects ?? 0, Date.now(), vote.txId]);
    });
  }

  async getVotes(txId: string): Promise<ListenerVote[]> {
    return this.withRead(() => {
      return this.queryAll("SELECT * FROM votes WHERE tx_id = ?", [txId]).map(rowToVote);
    });
  }

  async hasVoted(txId: string, listenerId: ListenerId): Promise<boolean> {
    return this.withRead(() => {
      const row = this.queryOne(
        "SELECT 1 as present FROM votes WHERE tx_id = ? AND listener_id = ?",
        [txId, listenerId]
      );
      return !!row;
    });
  }

  async getTransactionBySenderNonce(sender: string, nonce: string): Promise<CrossChainTransaction | null> {
    return this.withRead(() => {
      const row = this.queryOne(`
        SELECT t.*,
          (SELECT COUNT(*) FROM votes v WHERE v.tx_id=t.tx_id AND v.vote='APPROVE') computed_approve_votes,
          (SELECT COUNT(*) FROM votes v WHERE v.tx_id=t.tx_id AND v.vote='REJECT') computed_reject_votes
        FROM transactions t WHERE lower(sender)=lower(?) AND nonce=? ORDER BY created_at DESC LIMIT 1
      `, [sender, nonce]);
      return row ? rowToTx(row) : null;
    });
  }

  async upsertHeartbeat(hb: ListenerHeartbeat): Promise<void> {
    await this.withWrite(() => {
      this.run(`
        INSERT OR REPLACE INTO listener_heartbeats
          (listener_id, last_seen_at, source_chain_connected, last_processed_block, pending_votes)
        VALUES (?, ?, ?, ?, ?)
      `, [hb.listenerId, hb.lastSeenAt, hb.sourceChainConnected ? 1 : 0, hb.lastProcessedBlock, hb.pendingVotes]);
    });
  }

  async getHeartbeats(): Promise<ListenerHeartbeat[]> {
    return this.withRead(() => {
      return this.queryAll("SELECT * FROM listener_heartbeats").map(rowToHb);
    });
  }

  async getListenerCursor(listenerId: ListenerId): Promise<number | null> {
    return this.withRead(() => {
      const row = this.queryOne("SELECT last_processed_block FROM listener_cursors WHERE listener_id = ?", [listenerId]);
      return row ? Number(row.last_processed_block) : null;
    });
  }

  async resetListenerCursor(listenerId: ListenerId): Promise<void> {
    await this.withWrite(() => {
      this.run("DELETE FROM listener_cursors WHERE listener_id = ?", [listenerId]);
    });
  }

  async advanceListenerCursor(listenerId: ListenerId, blockNumber: number): Promise<boolean> {
    return this.withWrite(() => {
      const existing = this.queryOne("SELECT last_processed_block FROM listener_cursors WHERE listener_id = ?", [listenerId]);
      if (existing && Number(existing.last_processed_block) >= blockNumber) return false;
      this.run(`
        INSERT INTO listener_cursors (listener_id, last_processed_block)
        VALUES (?, ?)
        ON CONFLICT(listener_id) DO UPDATE SET last_processed_block = excluded.last_processed_block
      `, [listenerId, blockNumber]);
      return true;
    });
  }

  async getTimedOutTransactions(cutoffMs: number): Promise<CrossChainTransaction[]> {
    return this.withRead(() => {
      const cutoff = Date.now() - cutoffMs;
      return this.queryAll(`
        SELECT * FROM transactions
        WHERE status IN ('PENDING', 'VOTED', 'APPROVED', 'EXECUTING')
          AND created_at < ?
      `, [cutoff]).map(rowToTx);
    });
  }

  async getRollbackCandidates(cutoffMs: number): Promise<CrossChainTransaction[]> {
    return this.withRead(() => {
      const cutoff = Date.now() - cutoffMs;
      return this.queryAll(`
        SELECT * FROM transactions
        WHERE status = 'TIMED_OUT' AND created_at < ?
      `, [cutoff]).map(rowToTx);
    });
  }

  async getAvgLatencyMs(_windowMs: number): Promise<number> {
    return this.withRead(() => {
      const cutoff = Date.now() - _windowMs;
      const row = this.queryOne(`
        SELECT AVG(updated_at - created_at) as avg_latency
        FROM transactions
        WHERE status = 'EXECUTED' AND updated_at > ?
      `, [cutoff]);
      return Number(row?.avg_latency ?? 0);
    });
  }

  async getThroughput(windowMs: number): Promise<number> {
    return this.withRead(() => {
      const cutoff = Date.now() - windowMs;
      const row = this.queryOne(`
        SELECT COUNT(*) as cnt FROM transactions
        WHERE status = 'EXECUTED' AND updated_at > ?
      `, [cutoff]);
      return Number(row?.cnt ?? 0);
    });
  }

  async close(): Promise<void> {
    try {
      this.persistToDisk();
    } catch { /* ignore */ }
    try {
      this.db.close();
    } catch { /* ignore */ }
  }
}

// ── PostgreSQL Adapter ────────────────────────────────────────────────────────

class PostgresAdapter implements DbAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pool: any; // pg Pool

  constructor(connectionString: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool } = require("pg");
    this.pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        tx_id                TEXT PRIMARY KEY,
        sender               TEXT NOT NULL,
        destination_chain_id TEXT NOT NULL,
        destination_address  TEXT NOT NULL,
        payload              TEXT NOT NULL,
        nonce                TEXT NOT NULL,
        source_timestamp     BIGINT NOT NULL,
        source_block_number  BIGINT NOT NULL,
        source_transaction_hash TEXT,
        source_block_hash  TEXT,
        payload_text TEXT,
        payload_hash TEXT,
        transfer_mode TEXT NOT NULL DEFAULT 'MESSAGE_ONLY',
        requested_amount_wei TEXT NOT NULL DEFAULT '0',
        source_value_wei TEXT NOT NULL DEFAULT '0',
        transferred_amount_wei TEXT,
        destination_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
        status               TEXT NOT NULL DEFAULT 'PENDING',
        created_at           BIGINT NOT NULL,
        updated_at           BIGINT NOT NULL,
        dest_tx_hash         TEXT,
        rollback_tx_hash     TEXT,
        error_message        TEXT,
        approve_votes        INTEGER NOT NULL DEFAULT 0,
        reject_votes         INTEGER NOT NULL DEFAULT 0,
        deadline             TEXT
      );
      CREATE TABLE IF NOT EXISTS votes (
        tx_id       TEXT NOT NULL,
        listener_id TEXT NOT NULL,
        vote        TEXT NOT NULL,
        reason      TEXT,
        voted_at    BIGINT NOT NULL,
        signer_address TEXT,
        signature TEXT,
        digest TEXT,
        PRIMARY KEY (tx_id, listener_id)
      );
      CREATE TABLE IF NOT EXISTS listener_heartbeats (
        listener_id             TEXT PRIMARY KEY,
        last_seen_at            BIGINT NOT NULL,
        source_chain_connected  BOOLEAN NOT NULL DEFAULT FALSE,
        last_processed_block    BIGINT NOT NULL DEFAULT 0,
        pending_votes           INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS listener_cursors (
        listener_id             TEXT PRIMARY KEY,
        last_processed_block    BIGINT NOT NULL DEFAULT -1
      );
      CREATE INDEX IF NOT EXISTS idx_transactions_status     ON transactions(status);
      CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
      CREATE INDEX IF NOT EXISTS idx_votes_tx_id             ON votes(tx_id);
    `);
    await this.pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_transaction_hash TEXT");
    await this.pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_block_hash TEXT");
    await this.pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payload_text TEXT");
    await this.pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payload_hash TEXT");
    await this.pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_mode TEXT NOT NULL DEFAULT 'MESSAGE_ONLY'");
    await this.pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS requested_amount_wei TEXT NOT NULL DEFAULT '0'");
    await this.pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_value_wei TEXT NOT NULL DEFAULT '0'");
    await this.pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transferred_amount_wei TEXT");
    await this.pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS destination_confirmation BOOLEAN NOT NULL DEFAULT FALSE");
    await this.pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS rollback_tx_hash TEXT");
    await this.pool.query("ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deadline TEXT");
    await this.pool.query("ALTER TABLE votes ADD COLUMN IF NOT EXISTS signer_address TEXT");
    await this.pool.query("ALTER TABLE votes ADD COLUMN IF NOT EXISTS signature TEXT");
    await this.pool.query("ALTER TABLE votes ADD COLUMN IF NOT EXISTS digest TEXT");
  }

  async upsertTransaction(tx: CrossChainTransaction): Promise<void> {
    await this.pool.query(`
      INSERT INTO transactions
        (tx_id, sender, destination_chain_id, destination_address, payload, nonce,
         source_timestamp, source_block_number, status, created_at, updated_at,
         source_transaction_hash, source_block_hash, payload_text, payload_hash,
         transfer_mode, requested_amount_wei, source_value_wei, transferred_amount_wei,
         destination_confirmation, approve_votes, reject_votes, deadline)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
      ON CONFLICT (tx_id) DO UPDATE SET
        source_transaction_hash = COALESCE(transactions.source_transaction_hash, EXCLUDED.source_transaction_hash),
        source_block_hash = COALESCE(transactions.source_block_hash, EXCLUDED.source_block_hash),
        payload_text = COALESCE(transactions.payload_text, EXCLUDED.payload_text),
        payload_hash = COALESCE(transactions.payload_hash, EXCLUDED.payload_hash),
        transfer_mode = CASE WHEN EXCLUDED.transfer_mode = 'ETH_TRANSFER' THEN EXCLUDED.transfer_mode ELSE transactions.transfer_mode END,
        requested_amount_wei = CASE WHEN EXCLUDED.requested_amount_wei <> '0' THEN EXCLUDED.requested_amount_wei ELSE transactions.requested_amount_wei END,
        source_value_wei = CASE WHEN EXCLUDED.source_value_wei <> '0' THEN EXCLUDED.source_value_wei ELSE transactions.source_value_wei END
    `, [
      tx.txId, tx.sender, tx.destinationChainId, tx.destinationAddress,
      tx.payload, tx.nonce, tx.sourceTimestamp, tx.sourceBlockNumber,
      tx.status, tx.createdAt, tx.updatedAt, tx.sourceTransactionHash ?? null,
      tx.sourceBlockHash ?? null, tx.payloadText ?? null, tx.payloadHash ?? null,
      tx.transferMode ?? "MESSAGE_ONLY", tx.requestedAmountWei ?? "0", tx.sourceValueWei ?? "0",
      tx.transferredAmountWei ?? null, tx.destinationConfirmation ?? false,
      tx.approveVotes, tx.rejectVotes, tx.deadline ?? null
    ]);
  }

  async getTransaction(txId: string): Promise<CrossChainTransaction | null> {
    const r = await this.pool.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM votes v WHERE v.tx_id = t.tx_id AND v.vote = 'APPROVE') AS computed_approve_votes,
        (SELECT COUNT(*) FROM votes v WHERE v.tx_id = t.tx_id AND v.vote = 'REJECT') AS computed_reject_votes
      FROM transactions t
      WHERE t.tx_id = $1
    `, [txId]);
    return r.rows[0] ? rowToTx(r.rows[0]) : null;
  }

  async updateTransactionStatus(txId: string, status: TxStatus, extra?: Partial<CrossChainTransaction>, from?: TxStatus[]): Promise<boolean> {
    const allowedFrom = from ?? DEFAULT_STATUS_PREDECESSORS[status] ?? [];
    return this.transitionStatus(txId, allowedFrom, status, extra);
  }

  async transitionStatus(txId: string, from: TxStatus[], to: TxStatus, extra?: Partial<CrossChainTransaction>): Promise<boolean> {
    const r = await this.pool.query(`
      UPDATE transactions SET
        status = $1, updated_at = $2,
        dest_tx_hash  = COALESCE($3, dest_tx_hash),
        rollback_tx_hash = COALESCE($4, rollback_tx_hash),
        error_message = COALESCE($5, error_message)
        , destination_confirmation = CASE WHEN $7 = TRUE THEN TRUE ELSE destination_confirmation END
        , transferred_amount_wei = COALESCE($8, transferred_amount_wei)
      WHERE tx_id = $6 AND status = ANY($9::text[])
    `, [to, Date.now(), extra?.destTxHash ?? null, extra?.rollbackTxHash ?? null, extra?.errorMessage ?? null,
      txId, extra?.destinationConfirmation ?? false, extra?.transferredAmountWei ?? null, from]);
    return (r.rowCount ?? 0) > 0;
  }

  async getLastUpdatedAt(): Promise<number> {
    const r = await this.pool.query("SELECT MAX(updated_at) AS m FROM transactions");
    return Number(r.rows[0]?.m ?? 0);
  }

  async listTransactions(opts?: { status?: TxStatus; limit?: number; offset?: number }): Promise<CrossChainTransaction[]> {
    let sql = `
      SELECT t.*,
        (SELECT COUNT(*) FROM votes v WHERE v.tx_id = t.tx_id AND v.vote = 'APPROVE') AS computed_approve_votes,
        (SELECT COUNT(*) FROM votes v WHERE v.tx_id = t.tx_id AND v.vote = 'REJECT') AS computed_reject_votes
      FROM transactions t
      LEFT JOIN votes v ON v.tx_id = t.tx_id
    `;
    const params: (string | number)[] = [];
    let idx = 1;
    if (opts?.status) { sql += ` WHERE t.status = $${idx++}`; params.push(opts.status); }
    sql += " ORDER BY t.created_at DESC";
    if (opts?.limit)  { sql += ` LIMIT $${idx++}`;  params.push(opts.limit); }
    if (opts?.offset) { sql += ` OFFSET $${idx++}`; params.push(opts.offset); }
    const r = await this.pool.query(sql, params);
    return r.rows.map(rowToTx);
  }

  async countTransactions(status?: TxStatus): Promise<number> {
    const r = status
      ? await this.pool.query("SELECT COUNT(*) FROM transactions WHERE status = $1", [status])
      : await this.pool.query("SELECT COUNT(*) FROM transactions");
    return parseInt(r.rows[0].count, 10);
  }

  async recordVote(vote: ListenerVote): Promise<void> {
    await this.pool.query(`
      INSERT INTO votes (tx_id, listener_id, vote, reason, voted_at, signer_address, signature, digest)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (tx_id, listener_id) DO UPDATE SET vote = $3, reason = $4, voted_at = $5,
        signer_address = $6, signature = $7, digest = $8
    `, [vote.txId, vote.listenerId, vote.vote, vote.reason ?? null, vote.votedAt,
      vote.signerAddress ?? null, vote.signature ?? null, vote.digest ?? null]);

    const agg = await this.pool.query(`
      SELECT
        SUM(CASE WHEN vote = 'APPROVE' THEN 1 ELSE 0 END) AS approves,
        SUM(CASE WHEN vote = 'REJECT'  THEN 1 ELSE 0 END) AS rejects
      FROM votes WHERE tx_id = $1
    `, [vote.txId]);
    const { approves, rejects } = agg.rows[0];
    await this.pool.query(`
      UPDATE transactions SET approve_votes = $1, reject_votes = $2, updated_at = $3 WHERE tx_id = $4
    `, [approves ?? 0, rejects ?? 0, Date.now(), vote.txId]);
  }

  async getVotes(txId: string): Promise<ListenerVote[]> {
    const r = await this.pool.query("SELECT * FROM votes WHERE tx_id = $1", [txId]);
    return r.rows.map(rowToVote);
  }

  async hasVoted(txId: string, listenerId: ListenerId): Promise<boolean> {
    const r = await this.pool.query("SELECT 1 FROM votes WHERE tx_id = $1 AND listener_id = $2", [txId, listenerId]);
    return r.rows.length > 0;
  }

  async getTransactionBySenderNonce(sender: string, nonce: string): Promise<CrossChainTransaction | null> {
    const r = await this.pool.query(`
      SELECT t.*,
        (SELECT COUNT(*) FROM votes v WHERE v.tx_id=t.tx_id AND v.vote='APPROVE') computed_approve_votes,
        (SELECT COUNT(*) FROM votes v WHERE v.tx_id=t.tx_id AND v.vote='REJECT') computed_reject_votes
      FROM transactions t WHERE lower(sender)=lower($1) AND nonce=$2 ORDER BY created_at DESC LIMIT 1
    `, [sender, nonce]);
    return r.rows[0] ? rowToTx(r.rows[0]) : null;
  }

  async upsertHeartbeat(hb: ListenerHeartbeat): Promise<void> {
    await this.pool.query(`
      INSERT INTO listener_heartbeats (listener_id, last_seen_at, source_chain_connected, last_processed_block, pending_votes)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (listener_id) DO UPDATE SET
        last_seen_at = $2, source_chain_connected = $3,
        last_processed_block = $4, pending_votes = $5
    `, [hb.listenerId, hb.lastSeenAt, hb.sourceChainConnected, hb.lastProcessedBlock, hb.pendingVotes]);
  }

  async getHeartbeats(): Promise<ListenerHeartbeat[]> {
    const r = await this.pool.query("SELECT * FROM listener_heartbeats");
    return r.rows.map(rowToHb);
  }

  async getListenerCursor(listenerId: ListenerId): Promise<number | null> {
    const r = await this.pool.query("SELECT last_processed_block FROM listener_cursors WHERE listener_id = $1", [listenerId]);
    return r.rows[0] ? Number(r.rows[0].last_processed_block) : null;
  }

  async resetListenerCursor(listenerId: ListenerId): Promise<void> {
    await this.pool.query("DELETE FROM listener_cursors WHERE listener_id = $1", [listenerId]);
  }

  async advanceListenerCursor(listenerId: ListenerId, blockNumber: number): Promise<boolean> {
    const r = await this.pool.query(`
      INSERT INTO listener_cursors (listener_id, last_processed_block)
      VALUES ($1, $2)
      ON CONFLICT (listener_id) DO UPDATE
        SET last_processed_block = EXCLUDED.last_processed_block
        WHERE listener_cursors.last_processed_block < EXCLUDED.last_processed_block
    `, [listenerId, blockNumber]);
    return (r.rowCount ?? 0) > 0;
  }

  async getTimedOutTransactions(cutoffMs: number): Promise<CrossChainTransaction[]> {
    const cutoff = Date.now() - cutoffMs;
    const r = await this.pool.query(`
      SELECT * FROM transactions
      WHERE status IN ('PENDING','VOTED','APPROVED','EXECUTING') AND created_at < $1
    `, [cutoff]);
    return r.rows.map(rowToTx);
  }

  async getRollbackCandidates(cutoffMs: number): Promise<CrossChainTransaction[]> {
    const cutoff = Date.now() - cutoffMs;
    const r = await this.pool.query(`
      SELECT * FROM transactions
      WHERE status = 'TIMED_OUT' AND created_at < $1
    `, [cutoff]);
    return r.rows.map(rowToTx);
  }

  async getAvgLatencyMs(windowMs: number): Promise<number> {
    const cutoff = Date.now() - windowMs;
    const r = await this.pool.query(`
      SELECT AVG(updated_at - created_at) AS avg_latency
      FROM transactions WHERE status = 'EXECUTED' AND updated_at > $1
    `, [cutoff]);
    return parseFloat(r.rows[0]?.avg_latency ?? "0");
  }

  async getThroughput(windowMs: number): Promise<number> {
    const cutoff = Date.now() - windowMs;
    const r = await this.pool.query(`
      SELECT COUNT(*) FROM transactions WHERE status = 'EXECUTED' AND updated_at > $1
    `, [cutoff]);
    return parseInt(r.rows[0].count, 10);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

let _db: DbAdapter | null = null;

export async function getDb(): Promise<DbAdapter> {
  if (_db) return _db;

  if (DATABASE_URL) {
    console.log("[db] Using PostgreSQL:", DATABASE_URL.replace(/:[^:@]+@/, ":***@"));
    const adapter = new PostgresAdapter(DATABASE_URL);
    await adapter.initialize();
    _db = adapter;
  } else {
    console.log("[db] Using SQLite (sql.js):", SQLITE_PATH);
    _db = await SqliteAdapter.create(SQLITE_PATH);
  }

  return _db;
}

export async function closeDb(): Promise<void> {
  if (_db) {
    await _db.close();
    _db = null;
  }
}

export type { DbAdapter };
