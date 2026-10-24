// "Ask your agent": score one token right now with a ready agent, and say why. It only judges what the agent learned to judge,
// tokens in their first 24 hours that are trading, and says so plainly when it cannot. Nothing is stored about the question.
import { CFG } from "./config.ts";
import type { Db } from "./db.ts";
import type { Indexer } from "./indexer.ts";
import { buildSamples, FEATURE_LABELS } from "./ml/features.ts";
import { contributions } from "./ml/gbdt.ts";
import { loadSeries } from "./ml/series.ts";
import { calibrated, select, type AgentModel } from "./ml/train.ts";
import { fmtVal } from "./scorer.ts";
import { agentView, getOwned, HttpError } from "./service.ts";

type Reason = { feature: string; label: string; value: string };
export type AskResult =
  | { ok: false; reason: string; name?: string; symbol?: string }
  | {
      ok: true; token: string; curve: string; name: string; symbol: string; ageMinutes: number; probability: number; threshold: number; sensitivity: string;
      verdict: "above" | "below"; up: Reason[]; down: Reason[]; price: number; trades: number; lastTradeSecondsAgo: number;
    };

export async function askAgent(db: Db, ix: Indexer, owner: string, agentId: string, tokenAddr: string): Promise<AskResult> {
  const a = getOwned(db, owner, agentId);
  const view = agentView(db, a);
  if (view.status !== "ready" || !a.model) throw new HttpError(409, "Your agent can be asked once it has passed its test and its room is open.");
  const model = JSON.parse(a.model) as AgentModel;
  const settings = JSON.parse(a.settings || "{}") as { sensitivity?: "low" | "normal" | "high" };
  const sens = settings.sensitivity ?? "normal";

  const t = await ix.resolveToken(tokenAddr);
  if (!t) return { ok: false, reason: "That is not a token launched on Pons, or we cannot find it yet." };
  const meta = await ix.meta(t.address);
  const now = Math.floor(Date.now() / 1000);
  const ageH = (now - t.launched_ts) / 3600;
  if (ageH > 24) return { ok: false, ...meta, reason: `Your agent judges tokens in their first 24 hours, and this one launched ${ageH < 48 ? `${Math.round(ageH)} hours` : `${Math.round(ageH / 24)} days`} ago. Ask about a newer token.` };
  if (await ix.graduated(t.address)) return { ok: false, ...meta, reason: "This token has graduated, so it no longer trades on the curve your agent learned from." };
  await ix.backfillToken(t.address); // a young token is normally complete already; this covers one that was added just now
  const s = loadSeries(db, t.address);
  if (!s || s.n === 0) return { ok: false, ...meta, reason: "There are no trades for this token yet, so there is nothing to judge." };
  const lastAgo = now - s.ts[s.n - 1];
  const smp = buildSamples(s, { horizonH: CFG.objective.hours, x: CFG.objective.x, labelled: false, single: now });
  if (smp.length === 0) return { ok: false, ...meta, reason: `The last trade was ${lastAgo < 3600 ? `${Math.max(1, Math.round(lastAgo / 60))} minutes` : `${Math.round(lastAgo / 3600)} hours`} ago. Your agent only judges a token that has traded in the last 5 minutes, so there is nothing to read right now.` };

  const x = smp[0].x;
  const p = calibrated(model, x);
  const thr = model.thresholds[sens];
  const xs = select(model, x);
  const contrib = contributions(model.gbdt, xs)
    .map((c, i) => ({ f: model.featureNames[i], c, v: xs[i] }))
    .filter((r) => !r.f.startsWith("hour_"));
  const reason = (r: { f: string; v: number }): Reason => ({ feature: r.f, label: FEATURE_LABELS[r.f] ?? r.f, value: fmtVal(r.f, r.v) });
  const up = contrib.filter((r) => r.c > 0.02).sort((u, v) => v.c - u.c).slice(0, 3).map(reason);
  const down = contrib.filter((r) => r.c < -0.02).sort((u, v) => u.c - v.c).slice(0, 2).map(reason);
  return {
    ok: true, token: t.address, curve: t.curve, ...meta, ageMinutes: Math.round((now - t.launched_ts) / 60), probability: p, threshold: thr, sensitivity: sens,
    verdict: p >= thr ? "above" : "below", up, down, price: s.price[s.n - 1], trades: s.n, lastTradeSecondsAgo: lastAgo,
  };
}
