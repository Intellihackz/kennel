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
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY, curve TEXT NOT NULL UNIQUE, deployer TEXT NOT NULL, launched_block INTEGER NOT NULL, launched_ts INTEGER NOT NULL, -- launched_block is a Solana slot
  pair_token TEXT, threshold TEXT, name TEXT, symbol TEXT, graduated INTEGER NOT NULL DEFAULT 0, graduated_checked INTEGER NOT NULL DEFAULT 0,
  full_from INTEGER -- every trade since the launch is stored when this is set; NULL when the trades are not (all) here (never read, or pruned)
);
CREATE INDEX IF NOT EXISTS tokens_launched ON tokens (launched_block);
CREATE TABLE IF NOT EXISTS trades (
  curve TEXT NOT NULL, block INTEGER NOT NULL, log_index INTEGER NOT NULL, ts INTEGER NOT NULL, tx TEXT NOT NULL, -- block is the slot, log_index the event's place in its transaction
  side INTEGER NOT NULL, -- 1 buy, 0 sell
  wallet TEXT NOT NULL, recipient TEXT NOT NULL, quote TEXT NOT NULL, tokens TEXT NOT NULL, fee TEXT NOT NULL, tax TEXT NOT NULL, -- quote is lamports, tokens are raw units (6 decimals), fee is lamports
  PRIMARY KEY (curve, tx, log_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS trades_ts ON trades (ts);
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
  // a database made for the Pons version holds Ethereum addresses and cannot be reused
  const chain = (db.prepare("SELECT v FROM meta WHERE k = 'chain'").get() as { v: string } | undefined)?.v;
  if (!chain) {
    const used = (db.prepare("SELECT (SELECT COUNT(*) FROM tokens) + (SELECT COUNT(*) FROM agents) AS n").get() as { n: number }).n;
    if (used) throw new Error(`${path} was made for the Pons (Ethereum) version of Kennel and cannot be used on Solana. Point DB_PATH at a new file, or delete this one.`);
    db.prepare("INSERT INTO meta (k, v) VALUES ('chain', 'solana')").run();
  } else if (chain !== "solana") throw new Error(`${path} belongs to another chain (${chain}).`);
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
