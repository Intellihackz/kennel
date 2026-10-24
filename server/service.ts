// The product logic behind the API: agents, orders, tests and alerts. Every function takes the signed-in owner and refuses anything
// that is not theirs. There is no way to list agents across owners.
import { randomBytes } from "node:crypto";
import { CFG } from "./config.ts";
import type { Db } from "./db.ts";
import { checkToken, type Eligibility } from "./eligibility.ts";
import type { Indexer } from "./indexer.ts";
import { enqueue } from "./jobs.ts";
import type { AgentModel } from "./ml/train.ts";
import { orderAmount, tokenDecimals, verifyTransfer } from "./payments.ts";
import { checkWebhookUrl } from "./webhook.ts";

export type AgentRow = { id: string; owner: string; name: string; created_at: number; settings: string; model: string | null; model_version: number; deleted: number };
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const now = () => Math.floor(Date.now() / 1000);
const MAX_AGENTS = 20;
const MAX_TOKENS = 200;

export function getOwned(db: Db, owner: string, id: string): AgentRow {
  const a = db.prepare("SELECT * FROM agents WHERE id = ? AND deleted = 0").get(id) as AgentRow | undefined;
  // the same answer for "does not exist" and "belongs to someone else": nobody can probe for other people's agents
  if (!a || a.owner !== owner) throw new HttpError(404, "No such agent.");
  return a;
}

export function createAgent(db: Db, owner: string, name: string): AgentRow {
  const n = name.replace(/\s+/g, " ").trim().slice(0, 32);
  if (!n) throw new HttpError(400, "Give the agent a name.");
  const count = (db.prepare("SELECT COUNT(*) AS c FROM agents WHERE owner = ? AND deleted = 0").get(owner) as { c: number }).c;
  if (count >= MAX_AGENTS) throw new HttpError(400, `You can have up to ${MAX_AGENTS} agents.`);
  const id = randomBytes(16).toString("hex");
  db.prepare("INSERT INTO agents (id, owner, name, created_at, settings) VALUES (?,?,?,?,?)").run(id, owner, n, now(), JSON.stringify({ sensitivity: "normal", webhookUrl: "", perTrade: "0.02", daily: "0.1" }));
  return getOwned(db, owner, id);
}

export function deleteAgent(db: Db, owner: string, id: string) {
  getOwned(db, owner, id);
  db.exec("BEGIN");
  db.prepare("DELETE FROM alerts WHERE agent_id = ?").run(id);
  db.prepare("DELETE FROM tests WHERE agent_id = ?").run(id);
  db.prepare("DELETE FROM agent_tokens WHERE agent_id = ?").run(id);
  db.prepare("UPDATE agents SET deleted = 1, model = NULL, name = '', settings = '{}' WHERE id = ?").run(id); // payment records (orders) are kept
  db.exec("COMMIT");
}

export function updateSettings(db: Db, owner: string, id: string, body: Record<string, unknown>) {
  const a = getOwned(db, owner, id);
  const cur = JSON.parse(a.settings || "{}") as Record<string, string>;
  if (body.sensitivity !== undefined) {
    if (!["low", "normal", "high"].includes(String(body.sensitivity))) throw new HttpError(400, "Sensitivity must be low, normal or high.");
    cur.sensitivity = String(body.sensitivity);
  }
  if (body.webhookUrl !== undefined) {
    const u = String(body.webhookUrl).trim();
    if (u) {
      const c = checkWebhookUrl(u);
      if (!c.ok) throw new HttpError(400, c.error);
    }
    cur.webhookUrl = u;
  }
  for (const k of ["perTrade", "daily"] as const) {
    if (body[k] === undefined) continue;
    const v = String(body[k]);
    if (!/^\d{0,3}(\.\d{0,6})?$/.test(v) || Number(v) > 100) throw new HttpError(400, "Caps are amounts of ETH, up to 100.");
    cur[k] = v;
  }
  db.prepare("UPDATE agents SET settings = ? WHERE id = ?").run(JSON.stringify(cur), id);
}

type TokenView = { token: string; name: string; symbol: string; trades: number; ageHours: number; graduated: boolean; addedAt: number; state: "trained" | "training" };

export function agentView(db: Db, a: AgentRow) {
  const toks = db
    .prepare(
      `SELECT at.token, at.trades, at.age_h, at.graduated, at.added_at, t.name, t.symbol, o.status AS ostatus
       FROM agent_tokens at LEFT JOIN tokens t ON t.address = at.token LEFT JOIN orders o ON o.id = at.order_id
       WHERE at.agent_id = ? ORDER BY at.added_at`,
    )
    .all(a.id) as { token: string; trades: number; age_h: number; graduated: number; added_at: number; name: string | null; symbol: string | null; ostatus: string | null }[];
  const tokens: TokenView[] = toks.map((r) => ({ token: r.token, name: r.name ?? "", symbol: r.symbol ?? "", trades: r.trades, ageHours: r.age_h, graduated: !!r.graduated, addedAt: r.added_at, state: r.ostatus === "training" || r.ostatus === "paid" ? "training" : "trained" }));
  const trained = tokens.filter((t) => t.state === "trained").length;
  const job = db.prepare("SELECT kind FROM jobs WHERE agent_id = ? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1").get(a.id) as { kind: string } | undefined;
  const test = a.model
    ? (db.prepare("SELECT passed, report, created_at FROM tests WHERE agent_id = ? AND model_version = ? ORDER BY id DESC LIMIT 1").get(a.id, a.model_version) as { passed: number; report: string; created_at: number } | undefined)
    : undefined;
  let status: string;
  if (job) status = job.kind === "test" ? "testing" : "training";
  else if (trained === 0) status = "empty";
  else if (trained < CFG.minTokens || !a.model) status = "collecting";
  else if (!test) status = "ready_to_test";
  else status = test.passed ? "ready" : "locked";
  const model = a.model ? (JSON.parse(a.model) as AgentModel) : null;
  const orders = db.prepare("SELECT id, token, status, error, created_at FROM orders WHERE agent_id = ? AND status IN ('pending','paid','training','failed','credit_issued') ORDER BY created_at DESC LIMIT 10").all(a.id) as { id: string; token: string; status: string; error: string | null; created_at: number }[];
  const lastFailed = db.prepare("SELECT error FROM jobs WHERE agent_id = ? AND status = 'failed' ORDER BY id DESC LIMIT 1").get(a.id) as { error: string } | undefined;
  return {
    id: a.id, name: a.name, createdAt: a.created_at, status, minTokens: CFG.minTokens, trainedCount: trained, tokens,
    orders: orders.map((o) => ({ id: o.id, token: o.token, status: o.status, error: o.error, createdAt: o.created_at })),
    test: test ? { ...JSON.parse(test.report), testedAt: test.created_at } : null,
    model: model ? { trainedAt: model.trainedAt, tokensUsed: model.stats.tokensUsed, samples: model.stats.samples, trees: model.stats.trees, positiveRate: model.stats.positiveRate, objective: model.objective } : null,
    settings: JSON.parse(a.settings || "{}"),
    alertCount: (db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE agent_id = ?").get(a.id) as { c: number }).c,
    lastError: status === "empty" || status === "collecting" || status === "ready_to_test" ? (lastFailed?.error ?? null) : null,
  };
}

// ---------------- credits ----------------
export const creditsFor = (db: Db, owner: string) => (db.prepare("SELECT COUNT(*) AS c FROM credits WHERE owner = ? AND used_order IS NULL").get(owner) as { c: number }).c;

// ---------------- orders ----------------
export type OrderRow = { id: string; agent_id: string; owner: string; token: string; amount: string; status: string; tx_hash: string | null; created_at: number; expires_at: number; error: string | null };

const orderView = (o: OrderRow, withCredit = false) => ({
  id: o.id, agentId: o.agent_id, token: o.token, amount: o.amount, decimals: tokenDecimals(), status: o.status, expiresAt: o.expires_at, error: o.error,
  platformToken: CFG.platformToken || null, burnAddress: CFG.burnAddress, mock: CFG.mockPayments, price: CFG.pricePerToken, credit: withCredit,
});

export async function createOrder(db: Db, ix: Indexer, owner: string, agentId: string, tokenAddr: string) {
  if (!CFG.mockPayments && !CFG.platformToken) throw new HttpError(503, "Payments are not set up yet, so tokens cannot be added right now.");
  const a = getOwned(db, owner, agentId);
  const addr = tokenAddr.toLowerCase();
  const have = db.prepare("SELECT 1 FROM agent_tokens WHERE agent_id = ? AND token = ?").get(a.id, addr);
  if (have) throw new HttpError(409, "This agent has already learned from that token.");
  const total = (db.prepare("SELECT COUNT(*) AS c FROM agent_tokens WHERE agent_id = ?").get(a.id) as { c: number }).c;
  if (total >= MAX_TOKENS) throw new HttpError(400, `An agent can learn from up to ${MAX_TOKENS} tokens.`);
  const open = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE agent_id = ? AND status IN ('pending','paid','training')").get(a.id) as { c: number };
  if (open.c >= 5) throw new HttpError(429, "Wait for the tokens you already added to finish training.");
  const el = await checkToken(db, ix, addr);
  if (!el.ok) throw new HttpError(422, el.reason ?? "That token cannot be used.");
  // a pending order for the same token is reused, so repeating the request never creates a second charge
  const existing = db.prepare("SELECT * FROM orders WHERE agent_id = ? AND token = ? AND status = 'pending' AND expires_at > ?").get(a.id, addr, now()) as OrderRow | undefined;
  if (existing) return orderView(existing, !CFG.mockPayments && creditsFor(db, owner) > 0);
  const id = randomBytes(12).toString("hex");
  db.prepare("INSERT INTO orders (id, agent_id, owner, token, amount, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)").run(id, a.id, owner, addr, orderAmount(), "pending", now(), now() + 3600);
  return orderView(db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow, !CFG.mockPayments && creditsFor(db, owner) > 0);
}

export function getOrder(db: Db, owner: string, id: string) {
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
  if (!o || o.owner !== owner) throw new HttpError(404, "No such order.");
  return orderView(o);
}

export async function claimOrder(db: Db, ix: Indexer, owner: string, id: string, txHash?: string) {
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
  if (!o || o.owner !== owner) throw new HttpError(404, "No such order.");
  if (o.status !== "pending") return orderView(o); // already settled: claiming again changes nothing
  if (o.expires_at < now()) throw new HttpError(410, "This order expired. Add the token again to start a new one.");
  const a = getOwned(db, owner, o.agent_id);
  // a credit (issued when a run failed on our side after a burn, which cannot be undone) pays for a token without a new burn
  let credit: number | null = null;
  if (!CFG.mockPayments) {
    if (!txHash) {
      const c = db.prepare("SELECT id FROM credits WHERE owner = ? AND used_order IS NULL ORDER BY id LIMIT 1").get(owner) as { id: number } | undefined;
      if (!c) throw new HttpError(400, "Send the transaction hash of your payment.");
      credit = c.id;
    } else {
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new HttpError(400, "That is not a transaction hash.");
      const used = db.prepare("SELECT 1 FROM orders WHERE tx_hash = ?").get(txHash.toLowerCase());
      if (used) throw new HttpError(409, "That transaction has already paid for an order.");
      const v = await verifyTransfer(owner, txHash.toLowerCase(), o.amount);
      if (!v.ok) throw new HttpError(402, v.error);
    }
  }
  const el = await checkToken(db, ix, o.token);
  if (!el.ok) {
    // a verified burn for a token that can no longer be used cannot be returned, so it becomes a credit for the owner's next token
    if (!CFG.mockPayments && txHash) {
      db.exec("BEGIN");
      db.prepare("UPDATE orders SET status = 'credit_issued', tx_hash = ?, error = ? WHERE id = ?").run(txHash.toLowerCase(), el.reason ?? "ineligible after payment", o.id);
      db.prepare("INSERT INTO credits (owner, reason, created_at) VALUES (?,?,?)").run(owner, el.reason ?? "token no longer usable after payment", now());
      db.exec("COMMIT");
    }
    throw new HttpError(422, `${el.reason ?? "That token can no longer be used."}${CFG.mockPayments || !txHash ? "" : " Your burn was kept as a credit for your next token."}`);
  }
  db.exec("BEGIN");
  try {
    const claimed = db.prepare("UPDATE orders SET status = 'training', tx_hash = ? WHERE id = ? AND status = 'pending'").run(txHash ? txHash.toLowerCase() : null, o.id);
    if (credit !== null && Number(claimed.changes) > 0) {
      const used = db.prepare("UPDATE credits SET used_order = ? WHERE id = ? AND used_order IS NULL").run(o.id, credit);
      if (Number(used.changes) === 0) throw new HttpError(409, "That credit was just used. Try again.");
    }
    if (Number(claimed.changes) === 0) {
      // another request settled this order while we were checking the chain: do nothing twice
      db.exec("ROLLBACK");
      return orderView(db.prepare("SELECT * FROM orders WHERE id = ?").get(o.id) as OrderRow);
    }
    db.prepare("INSERT OR IGNORE INTO agent_tokens (agent_id, token, trades, age_h, graduated, added_at, order_id) VALUES (?,?,?,?,?,?,?)").run(a.id, o.token, el.trades, el.ageHours, el.graduated ? 1 : 0, now(), o.id);
    enqueue(db, "train", a.id, { orderId: o.id });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return orderView(db.prepare("SELECT * FROM orders WHERE id = ?").get(o.id) as OrderRow);
}

// ---------------- tests and alerts ----------------
export function queueTest(db: Db, owner: string, id: string) {
  const a = getOwned(db, owner, id);
  const v = agentView(db, a);
  if (v.status === "testing" || v.status === "training") throw new HttpError(409, "Wait for the agent to finish what it is doing.");
  if (v.trainedCount < CFG.minTokens || !a.model) throw new HttpError(422, `The test opens once the agent has learned from ${CFG.minTokens} tokens.`);
  // the test pool is fixed for a given model, so testing again without changing anything would give the same answer.
  // A different alert sensitivity is a different test (same tokens, different threshold), so it is allowed once per setting.
  const sens = (JSON.parse(a.settings || "{}") as { sensitivity?: string }).sensitivity ?? "normal";
  if (v.test && (v.test as { sensitivity?: string }).sensitivity === sens) return { queued: false, reason: "This version of the agent has already been tested at this sensitivity. Add a token to train a new version, or change the sensitivity, then test again." };
  enqueue(db, "test", a.id);
  return { queued: true };
}

export function listAlerts(db: Db, owner: string, id: string, limit = 50) {
  getOwned(db, owner, id);
  const rows = db
    .prepare("SELECT al.id, al.token, al.curve, al.ts, al.prob, al.reasons, al.price, al.webhook, t.name, t.symbol FROM alerts al LEFT JOIN tokens t ON t.address = al.token WHERE al.agent_id = ? ORDER BY al.ts DESC LIMIT ?")
    .all(id, Math.min(200, limit)) as { id: number; token: string; curve: string; ts: number; prob: number; reasons: string; price: string | null; webhook: string | null; name: string | null; symbol: string | null }[];
  return rows.map((r) => ({ id: r.id, token: r.token, curve: r.curve, name: r.name ?? "", symbol: r.symbol ?? "", at: r.ts, probability: r.prob, reasons: JSON.parse(r.reasons), price: r.price, webhook: r.webhook }));
}

export type { Eligibility };

// ---------------- burns ----------------
const E = 10n ** 18n;
/** Totals for the public fees and burns page. Aggregates only: nothing here says who burned what, or for which token. */
export function burnStats(db: Db) {
  const rows = db.prepare("SELECT amount, created_at FROM orders WHERE tx_hash IS NOT NULL AND status IN ('training','done')").all() as { amount: string; created_at: number }[];
  const dec = BigInt(tokenDecimals());
  const unit = 10n ** dec;
  let total = 0n, last24 = 0n;
  const days = new Map<string, bigint>();
  const cut = now() - 86400;
  for (const r of rows) {
    const a = BigInt(r.amount);
    total += a;
    if (r.created_at >= cut) last24 += a;
    const d = new Date(r.created_at * 1000).toISOString().slice(0, 10);
    days.set(d, (days.get(d) ?? 0n) + a);
  }
  const out: { day: string; burned: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date((now() - i * 86400) * 1000).toISOString().slice(0, 10);
    out.push({ day: d, burned: Number((days.get(d) ?? 0n) / unit) });
  }
  const credits = db.prepare("SELECT COUNT(*) AS c FROM credits").get() as { c: number };
  return {
    totalBurned: Number(total / unit), last24h: Number(last24 / unit), tokensTrained: rows.length, perToken: CFG.pricePerToken, days: out,
    platformToken: CFG.platformToken || null, burnAddress: CFG.burnAddress, creditsIssued: credits.c, live: !!CFG.platformToken && !CFG.mockPayments,
  };
}

/** The signed-in owner's own burns, for their private view. */
export function myBurns(db: Db, owner: string) {
  const rows = db
    .prepare(
      `SELECT o.id, o.token, o.amount, o.tx_hash, o.created_at, o.status, t.symbol, t.name FROM orders o LEFT JOIN tokens t ON t.address = o.token
       WHERE o.owner = ? AND o.status IN ('training','done','credit_issued')
         AND (o.tx_hash IS NOT NULL OR EXISTS (SELECT 1 FROM credits c WHERE c.used_order = o.id)) -- a real burn, or a real credit: never a development order
       ORDER BY o.created_at DESC LIMIT 200`,
    )
    .all(owner) as { id: string; token: string; amount: string; tx_hash: string | null; created_at: number; status: string; symbol: string | null; name: string | null }[];
  const unit = 10n ** BigInt(tokenDecimals());
  return {
    // a token paid for with a credit has no transaction: nothing was burned for it, and the list says so
    burns: rows.map((r) => ({ id: r.id, token: r.token, symbol: r.symbol ?? "", name: r.name ?? "", amount: r.tx_hash ? Number(BigInt(r.amount) / unit) : 0, txHash: r.tx_hash, at: r.created_at, status: r.tx_hash ? r.status : "credit" })),
    credits: creditsFor(db, owner),
    total: rows.filter((r) => r.tx_hash).reduce((a, r) => a + Number(BigInt(r.amount) / unit), 0),
  };
}
void E;
