// Is this token one an agent may learn from? (SPEC section 4) Checked from the indexed tables, before any payment.
import { CFG } from "./config.ts";
import type { Db } from "./db.ts";
import type { Indexer } from "./indexer.ts";
import { buildSamples } from "./ml/features.ts";
import { loadSeries } from "./ml/series.ts";

export type Eligibility = { ok: boolean; reason?: string; token?: string; name: string; symbol: string; trades: number; ageHours: number; graduated: boolean; launchedAt: number; activeMinutes: number };

export async function checkToken(db: Db, ix: Indexer, address: string): Promise<Eligibility> {
  const none = (reason: string): Eligibility => ({ ok: false, reason, name: "", symbol: "", trades: 0, ageHours: 0, graduated: false, launchedAt: 0, activeMinutes: 0 });
  const t = await ix.resolveToken(address);
  if (!t) return none("That is not a token launched on Pons, or we cannot find it yet.");
  await ix.backfillToken(t.address);
  const [meta, graduated] = await Promise.all([ix.meta(t.address), ix.graduated(t.address)]);
  const trades = (db.prepare("SELECT COUNT(*) AS n FROM trades WHERE curve = ?").get(t.curve) as { n: number }).n;
  const ageHours = Math.max(0, (Date.now() / 1000 - t.launched_ts) / 3600);
  // the same measure training uses: minutes in its first day with trading in the last five minutes
  const series = loadSeries(db, t.address);
  const activeMinutes = series ? buildSamples(series, { horizonH: CFG.objective.hours, x: CFG.objective.x, labelled: true }).length : 0;
  const base = { token: t.address, ...meta, trades, ageHours: Math.round(ageHours * 10) / 10, graduated, launchedAt: t.launched_ts, activeMinutes };
  if (!graduated) {
    if (trades < CFG.minTrades) return { ok: false, reason: `Only ${trades} trades. It needs ${CFG.minTrades}.`, ...base };
    if (ageHours < CFG.minAgeHours) return { ok: false, reason: `Only ${Math.floor(ageHours)} hours old. It needs a day.`, ...base };
  } else if (trades < 30) return { ok: false, reason: `It graduated but has only ${trades} recorded trades.`, ...base };
  if (activeMinutes < CFG.minActiveMinutes) return { ok: false, reason: `It traded steadily for only ${activeMinutes} minutes. It needs at least ${CFG.minActiveMinutes} minutes of steady trading to learn from.`, ...base };
  return { ok: true, ...base };
}
