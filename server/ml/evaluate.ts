// The held-out test (SPEC section 6). The agent is scored on tokens it never saw, picked by the platform with a fixed seed per model
// version (so testing again without changing the model gives the same pool and the same answer), against two baselines.
import { createHash } from "node:crypto";
import { CFG } from "../config.ts";
import type { Db } from "../db.ts";
import { buildSamples, FEATURES } from "./features.ts";
import { loadSeries } from "./series.ts";
import { calibrated, type AgentModel } from "./train.ts";

export type Alert = { token: string; t: number; y: number; ret: number; p: number };
export type TestReport = {
  passed: boolean; reasons: string[]; poolSize: number; poolOutOfTime: number; moments: number; alerts: number; tokensWithAlerts: number;
  precision: number | null; ciLow: number | null; baseRate: number; rulePrecision: number | null; ruleAlerts: number; beatsRule: boolean; gate: "chance" | "rule";
  meanReturn: number | null; worstReturn: number | null; valPrecision: number | null; overfit: boolean; trainPositiveRate: number; notes: string[];
  objective: { x: number; hours: number }; sensitivity: string; threshold: number;
};

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Alerts with a cooldown per token, the same way the live scorer fires them. */
function fire(items: { token: string; t: number; score: number; y: number; ret: number }[], thr: number, cooldownS: number): Alert[] {
  const last = new Map<string, number>();
  const out: Alert[] = [];
  for (const it of items) {
    if (it.score < thr) continue;
    if (it.t - (last.get(it.token) ?? -Infinity) < cooldownS) continue;
    last.set(it.token, it.t);
    out.push({ token: it.token, t: it.t, y: it.y, ret: it.ret, p: it.score });
  }
  return out;
}

export function pickPool(db: Db, agentId: string, version: number, exclude: string[], size: number, latestTrainLaunch: number): { tokens: string[]; outOfTime: number; later: Set<string> } {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - (24 + CFG.objective.hours + 1) * 3600;
  const ex = new Set(exclude);
  const rows = db
    .prepare(
      `SELECT t.address, t.launched_ts FROM tokens t
       WHERE t.full_from IS NOT NULL AND t.launched_ts < ? AND (SELECT COUNT(*) FROM trades r WHERE r.curve = t.curve) >= ?
       ORDER BY t.address`,
    )
    .all(cutoff, CFG.minTrades) as { address: string; launched_ts: number }[];
  const cand = rows.filter((r) => !ex.has(r.address));
  const rand = rng(parseInt(createHash("sha256").update(`${agentId}:${version}`).digest("hex").slice(0, 8), 16));
  const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // prefer tokens launched after the agent's newest token (a true test of "tokens that came later")
  const later = shuffle(cand.filter((r) => r.launched_ts > latestTrainLaunch));
  const rest = shuffle(cand.filter((r) => r.launched_ts <= latestTrainLaunch));
  // more candidates than needed: some will be skipped for having too little steady trading to score
  const pick = [...later, ...rest].slice(0, size * 4);
  return { tokens: pick.map((r) => r.address), outOfTime: pick.filter((r) => r.launched_ts > latestTrainLaunch).length, later: new Set(later.map((r) => r.address)) } as { tokens: string[]; outOfTime: number; later: Set<string> };
}

export function runTest(db: Db, agentId: string, model: AgentModel, version: number, sensitivity: "low" | "normal" | "high" = "normal"): TestReport {
  const obj = model.objective;
  const launches = model.tokens.map((t) => (db.prepare("SELECT launched_ts FROM tokens WHERE address = ?").get(t) as { launched_ts: number } | undefined)?.launched_ts ?? 0);
  const latest = Math.max(0, ...launches);
  const cand = pickPool(db, agentId, version, model.tokens, CFG.testPoolSize, latest);
  const pool = { tokens: [] as string[], outOfTime: 0 };
  const notes: string[] = [];
  const thr = model.thresholds[sensitivity];
  const idx5 = FEATURES.indexOf("trades_5m");
  const items: { token: string; t: number; score: number; y: number; ret: number; trades5: number }[] = [];
  for (const token of cand.tokens) {
    if (pool.tokens.length >= CFG.testPoolSize) break;
    const s = loadSeries(db, token);
    if (!s) continue;
    const smp = buildSamples(s, { horizonH: obj.hours, x: obj.x, labelled: true });
    if (smp.length < CFG.minActiveMinutes) continue; // too little steady trading to score
    pool.tokens.push(token);
    if (cand.later.has(token)) pool.outOfTime++;
    for (const m of smp) items.push({ token, t: m.t, score: calibrated(model, m.x), y: m.y!, ret: m.ret!, trades5: m.x[idx5] });
  }
  const empty = (why: string): TestReport => ({
    passed: false, reasons: [why], poolSize: pool.tokens.length, poolOutOfTime: pool.outOfTime, moments: items.length, alerts: 0, tokensWithAlerts: 0, precision: null, ciLow: null,
    baseRate: 0, rulePrecision: null, ruleAlerts: 0, beatsRule: false, gate: CFG.testGate, meanReturn: null, worstReturn: null, valPrecision: model.stats.valPrecisionNormal, overfit: false, trainPositiveRate: model.stats.positiveRate,
    notes, objective: obj, sensitivity, threshold: thr,
  });
  if (pool.tokens.length < 10) return empty(`Only ${pool.tokens.length} suitable tokens are available to test on right now. The test needs at least 10 tokens that are 27 hours old or more, were not used in training, and have enough trades.`);
  items.sort((a, b) => a.t - b.t);

  const cooldown = CFG.alertCooldownMin * 60;
  const agent = fire(items, thr, cooldown);
  const baseRate = items.reduce((a, b) => a + b.y, 0) / items.length;
  const rule = fire(items.map((i) => ({ ...i, score: i.trades5 })), model.baseline.trades5mQ80, cooldown);
  const prec = (al: Alert[]) => (al.length ? al.reduce((a, b) => a + b.y, 0) / al.length : null);
  const precision = prec(agent);
  const rulePrecision = prec(rule);
  const tokensWithAlerts = new Set(agent.map((a) => a.token)).size;

  // cluster bootstrap by token: resample whole tokens, so one lucky token cannot carry the result
  const byToken = new Map<string, Alert[]>();
  agent.forEach((a) => byToken.set(a.token, [...(byToken.get(a.token) ?? []), a]));
  const groups = [...byToken.values()];
  let ciLow: number | null = null;
  if (groups.length >= 2) {
    const rand = rng(7);
    const ps: number[] = [];
    for (let b = 0; b < 600; b++) {
      let h = 0, n = 0;
      for (let k = 0; k < groups.length; k++) { const g = groups[Math.floor(rand() * groups.length)]; n += g.length; h += g.reduce((a, x) => a + x.y, 0); }
      ps.push(h / n);
    }
    ps.sort((a, b) => a - b);
    ciLow = ps[Math.floor(0.05 * ps.length)];
  }
  // two separate questions: is it reliably better than chance, and is it better than the simple rule?
  const rule_ = rulePrecision ?? 0;
  const beat = Math.max(baseRate, rule_);
  const reasons: string[] = [];
  if (agent.length < 20) reasons.push(`It raised only ${agent.length} alerts on the test tokens. It needs at least 20 to tell luck from skill.${sensitivity !== "high" ? " A higher sensitivity raises more alerts, and changing it lets you test once more." : ""}`);
  if (tokensWithAlerts < 5) reasons.push(`Its alerts came from only ${tokensWithAlerts} tokens. It needs at least 5.`);
  if (precision !== null && ciLow !== null && ciLow <= baseRate) reasons.push(`It is not reliably better than chance: across different samples of tokens its hit rate fell to ${(ciLow * 100).toFixed(0)}%, and random alerts are right ${(baseRate * 100).toFixed(0)}% of the time.`);
  const beatsRule = precision !== null && precision >= CFG.testMargin * rule_;
  if (CFG.testGate === "rule" && !beatsRule) reasons.push(`Its alerts were right ${((precision ?? 0) * 100).toFixed(0)}% of the time. The simple rule (alert when the last 5 minutes are unusually busy) was right ${(rule_ * 100).toFixed(0)}%, and it needs to beat that by ${Math.round((CFG.testMargin - 1) * 100)}%.`);
  else if (precision !== null) notes.push(beatsRule ? `It also beat the simple rule (alert when the last 5 minutes are unusually busy): ${(precision * 100).toFixed(0)}% against ${(rule_ * 100).toFixed(0)}%.` : `It did not beat the simple rule (alert when the last 5 minutes are unusually busy): ${(precision * 100).toFixed(0)}% against ${(rule_ * 100).toFixed(0)}%. That rule is a strong one.`);
  void beat;
  const meanReturn = agent.length ? agent.reduce((a, b) => a + b.ret, 0) / agent.length : null;
  const worst = agent.length ? Math.min(...agent.map((a) => a.ret)) : null;
  const valP = model.stats.valPrecisionNormal;
  const overfit = valP !== null && precision !== null && valP - precision > 0.15;
  if (overfit) notes.push("It did much better on its own tokens than on new ones. That usually means it learned those tokens instead of a pattern.");
  const pos = model.stats.tokenPositiveRates;
  if (pos.length && pos.filter((r) => r > 0.6).length / pos.length > 0.6) notes.push("Most of the tokens it learned from mostly reached the outcome. An agent trained only on winners tends to expect winners.");
  notes.push(`Outcome tested: a net return of at least ${Math.round(obj.x * 100)}% within ${obj.hours} hours, after fees and tax paid both ways.`);
  return {
    passed: reasons.length === 0, reasons, poolSize: pool.tokens.length, poolOutOfTime: pool.outOfTime, moments: items.length, alerts: agent.length, tokensWithAlerts,
    precision, ciLow, baseRate, rulePrecision, ruleAlerts: rule.length, beatsRule, gate: CFG.testGate, meanReturn, worstReturn: worst, valPrecision: valP, overfit, trainPositiveRate: model.stats.positiveRate, notes,
    objective: obj, sensitivity, threshold: thr,
  };
}
