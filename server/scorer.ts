// The live scorer (SPEC section 9). When new trades arrive for a token still in its first day, every ready agent scores that moment.
// An alert fires when the calibrated probability crosses the agent's threshold, at most once per agent and token per cooldown.
import { CFG } from "./config.ts";
import type { Db } from "./db.ts";
import { postJson } from "./webhook.ts";
import { buildSamples, FEATURE_LABELS } from "./ml/features.ts";
import { contributions } from "./ml/gbdt.ts";
import { loadSeries } from "./ml/series.ts";
import { calibrated, select, type AgentModel } from "./ml/train.ts";

type ReadyAgent = { id: string; model: AgentModel; settings: { sensitivity?: "low" | "normal" | "high"; webhookUrl?: string } };

export function readyAgents(db: Db): ReadyAgent[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.model, a.settings FROM agents a
       WHERE a.deleted = 0 AND a.model IS NOT NULL
         AND (SELECT passed FROM tests t WHERE t.agent_id = a.id AND t.model_version = a.model_version ORDER BY t.id DESC LIMIT 1) = 1`,
    )
    .all() as { id: string; model: string; settings: string }[];
  return rows.map((r) => ({ id: r.id, model: JSON.parse(r.model) as AgentModel, settings: JSON.parse(r.settings || "{}") }));
}

export const fmtVal = (name: string, v: number) => {
  if (name === "age_min") return `${v.toFixed(0)} min`;
  if (name.startsWith("ret_") || name === "from_peak") return `${(v * 100).toFixed(0)}%`;
  if (name.endsWith("_share") || name === "progress" || name === "buy_ratio_5m") return `${(v * 100).toFixed(0)}%`;
  if (name.includes("flow") || name.includes("buy_5m")) return `${v.toFixed(3)} ETH`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
};

export function scoreTokens(db: Db, tokens: string[], agents = readyAgents(db)) {
  if (agents.length === 0) return 0;
  const now = Math.floor(Date.now() / 1000);
  let fired = 0;
  for (const token of tokens) {
    const row = db.prepare("SELECT launched_ts, graduated, curve FROM tokens WHERE address = ?").get(token) as { launched_ts: number; graduated: number; curve: string } | undefined;
    if (!row || row.graduated || now - row.launched_ts > 24 * 3600) continue;
    const s = loadSeries(db, token);
    if (!s || s.n === 0 || now - s.ts[s.n - 1] > 300) continue;
    const smp = buildSamples(s, { horizonH: CFG.objective.hours, x: CFG.objective.x, labelled: false, single: now });
    if (smp.length === 0) continue;
    const x = smp[0].x;
    for (const a of agents) {
      const p = calibrated(a.model, x);
      const thr = a.model.thresholds[a.settings.sensitivity ?? "normal"];
      if (p < thr) continue;
      const recent = db.prepare("SELECT ts FROM alerts WHERE agent_id = ? AND token = ? ORDER BY ts DESC LIMIT 1").get(a.id, token) as { ts: number } | undefined;
      if (recent && now - recent.ts < CFG.alertCooldownMin * 60) continue;
      const xs = select(a.model, x);
      const contrib = contributions(a.model.gbdt, xs);
      const reasons = contrib
        .map((c, i) => ({ f: a.model.featureNames[i], c, v: xs[i] }))
        .filter((r) => r.c > 0.02 && !r.f.startsWith("hour_"))
        .sort((u, v) => v.c - u.c)
        .slice(0, 3)
        .map((r) => ({ feature: r.f, label: FEATURE_LABELS[r.f], value: fmtVal(r.f, r.v) }));
      const price = s.price[s.n - 1];
      const r = db.prepare("INSERT INTO alerts (agent_id, token, curve, ts, prob, reasons, price) VALUES (?,?,?,?,?,?,?)").run(a.id, token, row.curve, now, p, JSON.stringify(reasons), String(price));
      fired++;
      const hook = a.settings.webhookUrl;
      if (hook) {
        postJson(hook, { type: "kennel.alert", agent: a.id, token, curve: row.curve, probability: Math.round(p * 1000) / 1000, reasons, price, at: now })
          .then((code) => db.prepare("UPDATE alerts SET webhook = ? WHERE id = ?").run(String(code), r.lastInsertRowid))
          .catch((e) => db.prepare("UPDATE alerts SET webhook = ? WHERE id = ?").run(`error: ${String((e as Error).message).slice(0, 80)}`, r.lastInsertRowid));
      }
    }
  }
  return fired;
}
