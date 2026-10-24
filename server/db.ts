// One SQLite file (node:sqlite, built into Node). WAL mode lets the API, the indexer and the training worker share it.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CFG } from "./config.ts";

export function openDb(path = CFG.dbPath) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 15000; PRAGMA foreign_keys = ON;");
  db.exec(`
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS anchors (block INTEGER PRIMARY KEY, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY, curve TEXT NOT NULL UNIQUE, deployer TEXT NOT NULL, launched_block INTEGER NOT NULL, launched_ts INTEGER NOT NULL,
  pair_token TEXT, threshold TEXT, name TEXT, symbol TEXT, graduated INTEGER NOT NULL DEFAULT 0, graduated_checked INTEGER NOT NULL DEFAULT 0,
  full_from INTEGER -- trades are complete from this block on (NULL until known)
);
CREATE INDEX IF NOT EXISTS tokens_launched ON tokens (launched_block);
CREATE TABLE IF NOT EXISTS trades (
  curve TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER NOT NULL, tx TEXT NOT NULL,
  side INTEGER NOT NULL, -- 1 buy, 0 sell
  wallet TEXT NOT NULL, recipient TEXT NOT NULL, quote TEXT NOT NULL, tokens TEXT NOT NULL, fee TEXT NOT NULL, tax TEXT NOT NULL,
  PRIMARY KEY (curve, block, log_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS trades_block ON trades (block);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'empty', -- empty | training | ready_to_test | testing | locked | ready
  settings TEXT NOT NULL DEFAULT '{}', model TEXT, model_version INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agents_owner ON agents (owner);
CREATE TABLE IF NOT EXISTS agent_tokens (
  agent_id TEXT NOT NULL, token TEXT NOT NULL, trades INTEGER NOT NULL, age_h REAL NOT NULL, graduated INTEGER NOT NULL, added_at INTEGER NOT NULL, order_id TEXT,
  PRIMARY KEY (agent_id, token)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, owner TEXT NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL,
  status TEXT NOT NULL, -- pending | paid | training | done | failed | credit_issued
  tx_hash TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_tx ON orders (tx_hash) WHERE tx_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS credits ( -- burned tokens cannot be returned, so a failure on our side is repaid with a free token slot
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, used_order TEXT
);
CREATE INDEX IF NOT EXISTS credits_owner ON credits (owner);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, agent_id TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued', error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, model_version INTEGER NOT NULL, created_at INTEGER NOT NULL, passed INTEGER NOT NULL, report TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, token TEXT NOT NULL, curve TEXT NOT NULL, ts INTEGER NOT NULL,
  prob REAL NOT NULL, reasons TEXT NOT NULL, price TEXT, webhook TEXT
);
CREATE INDEX IF NOT EXISTS alerts_agent ON alerts (agent_id, ts);
`);
  return db;
}

export type Db = ReturnType<typeof openDb>;

export const getMeta = (db: Db, k: string): string | undefined => (db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined)?.v;
export const setMeta = (db: Db, k: string, v: string) => void db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);

/** Runs `fn` inside a transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
