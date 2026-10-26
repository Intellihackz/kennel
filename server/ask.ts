// "Ask your agent": score any token right now with a ready agent, and say why. An agent learned from tokens in their first 24 hours that
// were trading, so for an older or quieter token it is outside what it practised on. It still answers, and says so plainly: in our own
// checks (SPEC.md) agents were no better than chance on tokens older than a day. Nothing is stored about the question.
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
      verdict: "above" | "below"; scope: "inside" | "outside"; notes: string[]; up: Reason[]; down: Reason[]; price: number; trades: number; lastTradeSecondsAgo: number;
    };

const span = (secs: number) => (secs < 5400 ? `${Math.max(1, Math.round(secs / 60))} minutes` : secs < 172800 ? `${Math.round(secs / 3600)} hours` : `${Math.round(secs / 86400)} days`);

export async function askAgent(db: Db, ix: Indexer, owner: string, agentId: string, tokenAddr: string): Promise<AskResult> {
  const a = getOwned(db, owner, agentId);
  const view = agentView(db, a);
  if (view.status !== "ready" || !a.model) throw new HttpError(409, "Your agent can be asked once it has passed its test and its room is open.");
  const model = JSON.parse(a.model) as AgentModel;
  const settings = JSON.parse(a.settings || "{}") as { sensitivity?: "low" | "normal" | "high" };
  const sens = settings.sensitivity ?? "normal";

  const t = await ix.resolveToken(tokenAddr);
  if (!t) return { ok: false, reason: "That is not a token launched on pump.fun, or we cannot find it yet." };
  const meta = await ix.meta(t.address);
  const now = Math.floor(Date.now() / 1000);
  const ageH = (now - t.launched_ts) / 3600;
  if (await ix.graduated(t.address)) return { ok: false, ...meta, reason: "This token has graduated. It no longer trades on the curve your agent learned from, and Kennel does not read the market it moved to." };
  await ix.backfillToken(t.address); // an older token, or one added just now, may not be indexed yet
  const s = loadSeries(db, t.address);
  if (!s || s.n === 0) return { ok: false, ...meta, reason: "This token has no trades yet, so there is nothing to read." };
  const lastAgo = now - s.ts[s.n - 1];
  const smp = buildSamples(s, { horizonH: CFG.objective.hours, x: CFG.objective.x, labelled: false, single: now, quiet: true });
  if (smp.length === 0) return { ok: false, ...meta, reason: "This token has no trades yet, so there is nothing to read." };

  const notes: string[] = [];
  if (ageH > 24) notes.push(`This token is ${ageH < 48 ? `${Math.round(ageH)} hours` : `${Math.round(ageH / 24)} days`} old. I only learned from the first day of a token's life, so for one this old I have no track record, and Kennel has not tested agents on tokens this old. Treat this as a rough guess.`);
  if (lastAgo > 300) notes.push(`Nothing has traded for ${span(lastAgo)}. I learned from moments with trading in the last 5 minutes, so there is little for me to read. Tokens this quiet rarely move, and I usually say low.`);

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
    verdict: p >= thr ? "above" : "below", scope: notes.length ? "outside" : "inside", notes, up, down, price: s.price[s.n - 1], trades: s.n, lastTradeSecondsAgo: lastAgo,
  };
}
