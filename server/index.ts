// Kennel server: the API, the indexer, the job runner, the live scorer and (in production) the built site, in one process.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { createChallenge, isAddress, sessionAddress, verifyChallenge } from "./auth.ts";
import { CFG } from "./config.ts";
import { openDb } from "./db.ts";
import { checkToken } from "./eligibility.ts";
import { Indexer } from "./indexer.ts";
import { JobRunner } from "./jobs.ts";
import { askAgent } from "./ask.ts";
import { initPayments } from "./payments.ts";
import { scoreTokens } from "./scorer.ts";
import { agentView, burnStats, claimOrder, createAgent, createOrder, creditsFor, deleteAgent, getOrder, getOwned, HttpError, listAlerts, myBurns, queueTest, updateSettings, type AgentRow } from "./service.ts";
import { tokenDecimals } from "./payments.ts";

const db = openDb();
const ix = new Indexer(db);
await ix.init();
await initPayments();
if (CFG.indexer) ix.start();
ix.onTrades((tokens) => {
  try {
    if (scoreTokens(db, tokens) > 0) {
      // alerts should show a token's name, not just its address: read the names of any alerted tokens that do not have one yet
      const unnamed = db.prepare("SELECT DISTINCT al.token FROM alerts al JOIN tokens t ON t.address = al.token WHERE t.name IS NULL LIMIT 20").all() as { token: string }[];
      for (const r of unnamed) void ix.meta(r.token);
    }
  } catch (e) {
    console.error("[scorer]", (e as Error).message);
  }
});
new JobRunner(db).start();

const app = new Hono();
const ipOf = (c: Context) => (CFG.trustProxy ? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() : undefined) ?? (c.env as { incoming?: { socket?: { remoteAddress?: string } } }).incoming?.socket?.remoteAddress ?? "unknown";

// ---- a small per-key rate limit ----
const hits = new Map<string, { n: number; t: number }>();
const limited = (key: string, max: number, windowMs = 60_000) => {
  const t = Date.now();
  const h = hits.get(key);
  if (!h || t - h.t > windowMs) return hits.set(key, { n: 1, t }), false;
  return ++h.n > max;
};
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of hits) if (t - v.t > 180_000) hits.delete(k);
}, 60_000).unref();

app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  c.res.headers.set("x-frame-options", "DENY");
  c.res.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (c.req.path.startsWith("/api/")) c.res.headers.set("cache-control", "no-store");
});
app.onError((e, c) => {
  if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 400);
  console.error("[api]", e);
  return c.json({ error: "Something went wrong on our side." }, 500);
});

const me = (c: Context): string => {
  const a = sessionAddress(c.req.header("authorization"));
  if (!a) throw new HttpError(401, "Connect your wallet first.");
  return a;
};
const guard = (c: Context, key: string, max: number, windowMs?: number) => {
  if (limited(`${key}:${ipOf(c)}`, max, windowMs)) throw new HttpError(429, "Slow down a little.");
};
const body = async (c: Context) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
const owned = (c: Context): AgentRow => getOwned(db, me(c), c.req.param("id") ?? "");

app.get("/health", (c) => c.json({ ok: true }));
app.get("/api/status", (c) => {
  const q = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','running')").get() as { n: number };
  return c.json({ indexer: ix.status(), jobsInQueue: q.n, mockPayments: CFG.mockPayments });
});
app.get("/api/config", (c) =>
  c.json({
    chainId: CFG.chainId, platformToken: CFG.platformToken || null, burnAddress: CFG.burnAddress, decimals: tokenDecimals(), pricePerToken: CFG.pricePerToken,
    minTokens: CFG.minTokens, minTrades: CFG.minTrades, minAgeHours: CFG.minAgeHours, minActiveMinutes: CFG.minActiveMinutes, mockPayments: CFG.mockPayments,
    objective: CFG.objective, testGate: CFG.testGate, indexerReady: ix.ready,
  }),
);

// ---- sign in ----
app.get("/api/auth/challenge", (c) => {
  guard(c, "auth", 30);
  const a = c.req.query("address");
  if (!isAddress(a)) throw new HttpError(400, "That is not a wallet address.");
  return c.json({ message: createChallenge(a, new URL(c.req.url).host) });
});
app.post("/api/auth/verify", async (c) => {
  guard(c, "auth", 30);
  const b = await body(c);
  if (!isAddress(b.address) || typeof b.signature !== "string") throw new HttpError(400, "Bad request.");
  const r = await verifyChallenge(b.address, b.signature);
  if (!r) throw new HttpError(401, "That signature did not check out. Try again.");
  return c.json(r);
});

// ---- tokens ----
app.get("/api/tokens/check", async (c) => {
  me(c);
  guard(c, "check", 40);
  const a = c.req.query("address");
  if (!isAddress(a)) throw new HttpError(400, "That is not a contract address. It starts with 0x and has 40 more characters.");
  if (!ix.ready) throw new HttpError(503, "Kennel is still catching up with the chain. Try again in a minute.");
  return c.json(await checkToken(db, ix, a));
});

// ---- agents (every route checks the signed-in wallet owns the agent) ----
app.get("/api/agents", (c) => {
  const owner = me(c);
  const rows = db.prepare("SELECT * FROM agents WHERE owner = ? AND deleted = 0 ORDER BY created_at").all(owner) as AgentRow[];
  return c.json({ agents: rows.map((r) => agentView(db, r)) });
});
app.post("/api/agents", async (c) => {
  const owner = me(c);
  guard(c, "mk", 20);
  const b = await body(c);
  return c.json(agentView(db, createAgent(db, owner, String(b.name ?? ""))));
});
app.get("/api/agents/:id", (c) => c.json(agentView(db, owned(c))));
app.delete("/api/agents/:id", (c) => (deleteAgent(db, me(c), c.req.param("id")), c.json({ ok: true })));
app.put("/api/agents/:id/settings", async (c) => {
  const owner = me(c);
  updateSettings(db, owner, c.req.param("id"), await body(c));
  return c.json(agentView(db, getOwned(db, owner, c.req.param("id"))));
});
app.post("/api/agents/:id/train", async (c) => {
  const owner = me(c);
  guard(c, "train", 20);
  if (!ix.ready) throw new HttpError(503, "Kennel is still catching up with the chain. Try again in a minute.");
  const b = await body(c);
  if (!isAddress(b.token)) throw new HttpError(400, "That is not a contract address.");
  return c.json(await createOrder(db, ix, owner, c.req.param("id"), b.token));
});
app.post("/api/agents/:id/test", (c) => {
  const owner = me(c);
  guard(c, "test", 10);
  return c.json(queueTest(db, owner, c.req.param("id")));
});
app.post("/api/agents/:id/ask", async (c) => {
  const owner = me(c);
  guard(c, "ask", 30);
  const b = await body(c);
  if (!isAddress(b.token)) throw new HttpError(400, "That is not a contract address. It starts with 0x and has 40 more characters.");
  if (!ix.ready) throw new HttpError(503, "Kennel is still catching up with the chain. Try again in a minute.");
  return c.json(await askAgent(db, ix, owner, c.req.param("id"), b.token));
});
app.get("/api/agents/:id/alerts", (c) => c.json({ alerts: listAlerts(db, me(c), c.req.param("id"), Number(c.req.query("limit") ?? 50)) }));

// ---- orders ----
app.get("/api/orders/:id", (c) => c.json(getOrder(db, me(c), c.req.param("id"))));
app.post("/api/orders/:id/claim", async (c) => {
  const owner = me(c);
  guard(c, "claim", 20);
  const b = await body(c);
  return c.json(await claimOrder(db, ix, owner, c.req.param("id"), typeof b.txHash === "string" ? b.txHash : undefined));
});
// ---- burns and credits ----
app.get("/api/burns", (c) => c.json(burnStats(db))); // public totals only, never who or which token
app.get("/api/me/burns", (c) => c.json(myBurns(db, me(c))));
app.get("/api/me/credits", (c) => c.json({ credits: creditsFor(db, me(c)) }));
app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));

// ---- the built site ----
const DIST = join(process.cwd(), CFG.distDir);
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain", ".ico": "image/x-icon" };
app.get("*", (c) => {
  const path = normalize(decodeURIComponent(new URL(c.req.url).pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(DIST, path);
  let status = 200;
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
    file = join(DIST, "404.html");
    status = 404;
  }
  if (!existsSync(file)) return c.text("Run `npm run build` first.", 404);
  const immutable = file.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  return new Response(readFileSync(file), { status, headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": immutable } });
});

serve({ fetch: app.fetch, port: CFG.port }, (i) => console.log(`Kennel server on :${i.port}  (payments: ${CFG.mockPayments ? "development mode, no transfer needed" : "real"})`));
