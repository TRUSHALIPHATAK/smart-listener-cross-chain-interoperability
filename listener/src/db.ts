/**
 * db.ts — Storage abstraction layer
 *
 * Automatically uses:
 *   • PostgreSQL if DATABASE_URL is set (production)
 *   • SQLite (better-sqlite3) otherwise (development, zero-install)
 *
 * Both backends use the identical schema.
 */

import * as fs from "fs";
import * as path from "path";
import { DATABASE_URL, SQLITE_PATH } from "./config";
import { CrossChainTransaction, ListenerVote, ListenerHeartbeat, TxStatus, ListenerId, VoteValue } from "./types";

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
  status               TEXT NOT NULL DEFAULT 'PENDING',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  dest_tx_hash         TEXT,
  error_message        TEXT,
  approve_votes        INTEGER NOT NULL DEFAULT 0,
  reject_votes         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS votes (
  tx_id       TEXT NOT NULL,
  listener_id TEXT NOT NULL,
  vote        TEXT NOT NULL,
  reason      TEXT,
  voted_at    INTEGER NOT NULL,
  PRIMARY KEY (tx_id, listener_id)
);

CREATE TABLE IF NOT EXISTS listener_heartbeats (
  listener_id             TEXT PRIMARY KEY,
  last_seen_at            INTEGER NOT NULL,
  source_chain_connected  INTEGER NOT NULL DEFAULT 0,
  last_processed_block    INTEGER NOT NULL DEFAULT 0,
  pending_votes           INTEGER NOT NULL DEFAULT 0
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
  updateTransactionStatus(txId: string, status: TxStatus, extra?: Partial<CrossChainTransaction>): Promise<void>;
  listTransactions(opts?: { status?: TxStatus; limit?: number; offset?: number }): Promise<CrossChainTransaction[]>;
  countTransactions(status?: TxStatus): Promise<number>;

  recordVote(vote: ListenerVote): Promise<void>;
  getVotes(txId: string): Promise<ListenerVote[]>;
  hasVoted(txId: string, listenerId: ListenerId): Promise<boolean>;

  upsertHeartbeat(hb: ListenerHeartbeat): Promise<void>;
  getHeartbeats(): Promise<ListenerHeartbeat[]>;

  /** Transactions that have been PENDING/VOTED longer than cutoffMs */
  getTimedOutTransactions(cutoffMs: number): Promise<CrossChainTransaction[]>;
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
    sourceTimestamp:     Number(row.source_timestamp),
    sourceBlockNumber:   Number(row.source_block_number),
    status:              row.status as TxStatus,
    createdAt:           Number(row.created_at),
    updatedAt:           Number(row.updated_at),
    destTxHash:          row.dest_tx_hash ?? undefined,
    errorMessage:        row.error_message ?? undefined,
    approveVotes:        Number(row.approve_votes),
    rejectVotes:         Number(row.reject_votes),
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

// ── SQLite Adapter ────────────────────────────────────────────────────────────

class SqliteAdapter implements DbAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any; // better-sqlite3 Database

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    // Dynamic require so PG-only environments don't need better-sqlite3
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
  }

  async upsertTransaction(tx: CrossChainTransaction): Promise<void> {
    this.db.prepare(`
      INSERT OR IGNORE INTO transactions
        (tx_id, sender, destination_chain_id, destination_address, payload, nonce,
         source_timestamp, source_block_number, status, created_at, updated_at,
         approve_votes, reject_votes)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tx.txId, tx.sender, tx.destinationChainId, tx.destinationAddress,
      tx.payload, tx.nonce, tx.sourceTimestamp, tx.sourceBlockNumber,
      tx.status, tx.createdAt, tx.updatedAt, tx.approveVotes, tx.rejectVotes
    );
  }

  async getTransaction(txId: string): Promise<CrossChainTransaction | null> {
    const row = this.db.prepare("SELECT * FROM transactions WHERE tx_id = ?").get(txId);
    return row ? rowToTx(row) : null;
  }

  async updateTransactionStatus(txId: string, status: TxStatus, extra?: Partial<CrossChainTransaction>): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      UPDATE transactions SET
        status = ?,
        updated_at = ?,
        dest_tx_hash  = COALESCE(?, dest_tx_hash),
        error_message = COALESCE(?, error_message),
        approve_votes = COALESCE(?, approve_votes),
        reject_votes  = COALESCE(?, reject_votes)
      WHERE tx_id = ?
    `).run(
      status, now,
      extra?.destTxHash ?? null,
      extra?.errorMessage ?? null,
      extra?.approveVotes ?? null,
      extra?.rejectVotes ?? null,
      txId
    );
  }

  async listTransactions(opts?: { status?: TxStatus; limit?: number; offset?: number }): Promise<CrossChainTransaction[]> {
    let sql = "SELECT * FROM transactions";
    const params: (string | number)[] = [];
    if (opts?.status) { sql += " WHERE status = ?"; params.push(opts.status); }
    sql += " ORDER BY created_at DESC";
    if (opts?.limit)  { sql += " LIMIT ?";  params.push(opts.limit); }
    if (opts?.offset) { sql += " OFFSET ?"; params.push(opts.offset); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.db.prepare(sql).all(...params) as any[]).map(rowToTx);
  }

  async countTransactions(status?: TxStatus): Promise<number> {
    if (status) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this.db.prepare("SELECT COUNT(*) as c FROM transactions WHERE status = ?").get(status) as any).c;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.db.prepare("SELECT COUNT(*) as c FROM transactions").get() as any).c;
  }

  async recordVote(vote: ListenerVote): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO votes (tx_id, listener_id, vote, reason, voted_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(vote.txId, vote.listenerId, vote.vote, vote.reason ?? null, vote.votedAt);

    // Update aggregate vote counts on transaction
    const agg = this.db.prepare(`
      SELECT
        SUM(CASE WHEN vote = 'APPROVE' THEN 1 ELSE 0 END) as approves,
        SUM(CASE WHEN vote = 'REJECT'  THEN 1 ELSE 0 END) as rejects
      FROM votes WHERE tx_id = ?
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    `).get(vote.txId) as any;

    this.db.prepare(`
      UPDATE transactions SET approve_votes = ?, reject_votes = ?, updated_at = ? WHERE tx_id = ?
    `).run(agg.approves ?? 0, agg.rejects ?? 0, Date.now(), vote.txId);
  }

  async getVotes(txId: string): Promise<ListenerVote[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.db.prepare("SELECT * FROM votes WHERE tx_id = ?").all(txId) as any[]).map(rowToVote);
  }

  async hasVoted(txId: string, listenerId: ListenerId): Promise<boolean> {
    const row = this.db.prepare("SELECT 1 FROM votes WHERE tx_id = ? AND listener_id = ?").get(txId, listenerId);
    return !!row;
  }

  async upsertHeartbeat(hb: ListenerHeartbeat): Promise<void> {
    this.db.prepare(`
      INSERT OR REPLACE INTO listener_heartbeats
        (listener_id, last_seen_at, source_chain_connected, last_processed_block, pending_votes)
      VALUES (?, ?, ?, ?, ?)
    `).run(hb.listenerId, hb.lastSeenAt, hb.sourceChainConnected ? 1 : 0, hb.lastProcessedBlock, hb.pendingVotes);
  }

  async getHeartbeats(): Promise<ListenerHeartbeat[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.db.prepare("SELECT * FROM listener_heartbeats").all() as any[]).map(rowToHb);
  }

  async getTimedOutTransactions(cutoffMs: number): Promise<CrossChainTransaction[]> {
    const cutoff = Date.now() - cutoffMs;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.db.prepare(`
      SELECT * FROM transactions
      WHERE status IN ('PENDING', 'VOTED', 'APPROVED', 'EXECUTING')
        AND created_at < ?
    `).all(cutoff) as any[]).map(rowToTx);
  }

  async getAvgLatencyMs(_windowMs: number): Promise<number> {
    // Approximate latency as updated_at - created_at for EXECUTED txns
    const cutoff = Date.now() - _windowMs;
    const row = this.db.prepare(`
      SELECT AVG(updated_at - created_at) as avg_latency
      FROM transactions
      WHERE status = 'EXECUTED' AND updated_at > ?
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    `).get(cutoff) as any;
    return row?.avg_latency ?? 0;
  }

  async getThroughput(windowMs: number): Promise<number> {
    const cutoff = Date.now() - windowMs;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM transactions
      WHERE status = 'EXECUTED' AND updated_at > ?
    `).get(cutoff) as any;
    return row?.cnt ?? 0;
  }

  async close(): Promise<void> {
    this.db.close();
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
    // Replace SQLite-specific syntax for PG
    const pgSchema = SCHEMA_SQL
      .replace(/INSERT OR IGNORE/g, "INSERT OR IGNORE".replace("OR IGNORE", ""))
      .replace(/INTEGER/g, "BIGINT")
      .replace(/TEXT PRIMARY KEY/g, "TEXT PRIMARY KEY");
    
    // Use standard PG DDL
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
        status               TEXT NOT NULL DEFAULT 'PENDING',
        created_at           BIGINT NOT NULL,
        updated_at           BIGINT NOT NULL,
        dest_tx_hash         TEXT,
        error_message        TEXT,
        approve_votes        INTEGER NOT NULL DEFAULT 0,
        reject_votes         INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS votes (
        tx_id       TEXT NOT NULL,
        listener_id TEXT NOT NULL,
        vote        TEXT NOT NULL,
        reason      TEXT,
        voted_at    BIGINT NOT NULL,
        PRIMARY KEY (tx_id, listener_id)
      );
      CREATE TABLE IF NOT EXISTS listener_heartbeats (
        listener_id             TEXT PRIMARY KEY,
        last_seen_at            BIGINT NOT NULL,
        source_chain_connected  BOOLEAN NOT NULL DEFAULT FALSE,
        last_processed_block    BIGINT NOT NULL DEFAULT 0,
        pending_votes           INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_transactions_status     ON transactions(status);
      CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);
      CREATE INDEX IF NOT EXISTS idx_votes_tx_id             ON votes(tx_id);
    `);
    void pgSchema; // suppress unused warning
  }

  async upsertTransaction(tx: CrossChainTransaction): Promise<void> {
    await this.pool.query(`
      INSERT INTO transactions
        (tx_id, sender, destination_chain_id, destination_address, payload, nonce,
         source_timestamp, source_block_number, status, created_at, updated_at,
         approve_votes, reject_votes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (tx_id) DO NOTHING
    `, [
      tx.txId, tx.sender, tx.destinationChainId, tx.destinationAddress,
      tx.payload, tx.nonce, tx.sourceTimestamp, tx.sourceBlockNumber,
      tx.status, tx.createdAt, tx.updatedAt, tx.approveVotes, tx.rejectVotes
    ]);
  }

  async getTransaction(txId: string): Promise<CrossChainTransaction | null> {
    const r = await this.pool.query("SELECT * FROM transactions WHERE tx_id = $1", [txId]);
    return r.rows[0] ? rowToTx(r.rows[0]) : null;
  }

  async updateTransactionStatus(txId: string, status: TxStatus, extra?: Partial<CrossChainTransaction>): Promise<void> {
    await this.pool.query(`
      UPDATE transactions SET
        status = $1, updated_at = $2,
        dest_tx_hash  = COALESCE($3, dest_tx_hash),
        error_message = COALESCE($4, error_message),
        approve_votes = COALESCE($5, approve_votes),
        reject_votes  = COALESCE($6, reject_votes)
      WHERE tx_id = $7
    `, [status, Date.now(), extra?.destTxHash ?? null, extra?.errorMessage ?? null,
        extra?.approveVotes ?? null, extra?.rejectVotes ?? null, txId]);
  }

  async listTransactions(opts?: { status?: TxStatus; limit?: number; offset?: number }): Promise<CrossChainTransaction[]> {
    let sql = "SELECT * FROM transactions";
    const params: (string | number)[] = [];
    let idx = 1;
    if (opts?.status) { sql += ` WHERE status = $${idx++}`; params.push(opts.status); }
    sql += " ORDER BY created_at DESC";
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
      INSERT INTO votes (tx_id, listener_id, vote, reason, voted_at)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (tx_id, listener_id) DO UPDATE SET vote = $3, reason = $4, voted_at = $5
    `, [vote.txId, vote.listenerId, vote.vote, vote.reason ?? null, vote.votedAt]);

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

  async getTimedOutTransactions(cutoffMs: number): Promise<CrossChainTransaction[]> {
    const cutoff = Date.now() - cutoffMs;
    const r = await this.pool.query(`
      SELECT * FROM transactions
      WHERE status IN ('PENDING','VOTED','APPROVED','EXECUTING') AND created_at < $1
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
    console.log("[db] Using SQLite:", SQLITE_PATH);
    _db = new SqliteAdapter(SQLITE_PATH);
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
