// Features and labels (SPEC section 5). Every feature at time T uses only trades up to T. The label looks forward from T.
import type { Series } from "./series.ts";

// The full vector. Not every agent uses all of it: see FEATURE_SETS.
export const FEATURES = [
  "age_min", "trades_total", "trades_1m", "trades_5m", "trades_30m", "buyers_total", "new_buyers_5m", "buy_ratio_5m",
  "net_flow_5m", "net_flow_30m", "avg_buy_5m", "max_buy_5m", "progress", "ret_5m", "ret_30m", "ret_120m", "from_peak",
  "top1_share", "top5_share", "holders", "snipe_share_30m", "deployer_share", "deployer_sells", "hour_sin", "hour_cos",
  "act_ratio", "burst_1m", "newbuyer_ratio", "flow_per_trade",
] as const;
export const NF = FEATURES.length;
const ix = (names: string[]) => names.map((n) => FEATURES.indexOf(n as (typeof FEATURES)[number]));
/** Scale-free signals only: rates, ratios and price moves. Cumulative counters (total trades, total buyers, holders) are left out,
 *  because with few tokens a model memorises them and learns which token it is looking at instead of what a token is doing. */
export const FEATURE_SETS: Record<string, number[]> = {
  all: ix(FEATURES.slice(0, 25) as unknown as string[]),
  general: ix(["age_min", "trades_1m", "trades_5m", "trades_30m", "act_ratio", "burst_1m", "new_buyers_5m", "newbuyer_ratio", "buy_ratio_5m", "net_flow_5m", "net_flow_30m", "flow_per_trade", "avg_buy_5m", "max_buy_5m", "progress", "ret_5m", "ret_30m", "ret_120m", "from_peak", "top1_share", "top5_share", "snipe_share_30m", "deployer_share", "deployer_sells"]),
};
export const DEFAULT_SET = "general";
export const FEATURE_LABELS: Record<string, string> = {
  age_min: "token age", trades_total: "total trades", trades_1m: "trades in the last minute", trades_5m: "trades in the last 5 minutes", trades_30m: "trades in the last 30 minutes",
  buyers_total: "distinct buyers so far", new_buyers_5m: "new buyers in the last 5 minutes", buy_ratio_5m: "share of buys in the last 5 minutes", net_flow_5m: "net buying in the last 5 minutes",
  net_flow_30m: "net buying in the last 30 minutes", avg_buy_5m: "average buy size", max_buy_5m: "largest recent buy", progress: "progress toward graduation", ret_5m: "price change over 5 minutes",
  ret_30m: "price change over 30 minutes", ret_120m: "price change over 2 hours", from_peak: "price versus its peak", top1_share: "share held by the largest holder", top5_share: "share held by the top 5 holders",
  holders: "number of holders", snipe_share_30m: "share of recent buys paying snipe tax", deployer_share: "share held by the deployer", deployer_sells: "sells by the deployer", hour_sin: "time of day", hour_cos: "time of day",
};

const lastLE = (ts: Float64Array, n: number, t: number) => {
  // index of the last trade with ts <= t, or -1
  let lo = 0;
  let hi = n - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) (ans = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  return ans;
};

/** Walks a token's life minute by minute and yields the feature vector at each active moment. */
export type Sample = { t: number; x: Float64Array; ret?: number; y?: number };

export function buildSamples(s: Series, opts: { horizonH: number; x: number; maxHours?: number; until?: number; labelled: boolean; single?: number }): Sample[] {
  const out: Sample[] = [];
  const n = s.n;
  if (n === 0) return out;
  const maxT = s.launchedTs + (opts.maxHours ?? 24) * 3600;
  const times: number[] = [];
  if (opts.single !== undefined) times.push(opts.single);
  else for (let T = s.launchedTs + 60; T <= maxT; T += 60) times.push(T);

  // running state
  const balance = new Map<string, number>();
  const firstBuy = new Map<string, number>();
  let j = 0; // trades folded in so far
  let cumNet = 0;
  let sold = 0; // net tokens sold from the curve
  let peak = 0;
  let depSells = 0;
  const endTs = s.ts[n - 1];

  for (const T of times) {
    while (j < n && s.ts[j] <= T) {
      const rec = s.recipient[j];
      if (s.side[j] === 1) {
        cumNet += s.quote[j];
        sold += s.tokens[j];
        balance.set(rec, (balance.get(rec) ?? 0) + s.tokens[j]);
        if (!firstBuy.has(rec)) firstBuy.set(rec, s.ts[j]);
      } else {
        cumNet -= s.quote[j];
        sold -= s.tokens[j];
        balance.set(s.wallet[j], (balance.get(s.wallet[j]) ?? 0) - s.tokens[j]);
        if (s.wallet[j] === s.deployer) depSells++;
      }
      if (s.price[j] > peak) peak = s.price[j];
      j++;
    }
    if (j === 0) continue;
    const last = j - 1;
    // only moments with some activity in the last 5 minutes (alerts only ever fire on live trades)
    const i5 = lastLE(s.ts, n, T - 300) + 1;
    const n5 = j - i5;
    if (n5 === 0) continue;
    if (opts.until !== undefined && T > opts.until) break;

    const i1 = lastLE(s.ts, n, T - 60) + 1;
    const i30 = lastLE(s.ts, n, T - 1800) + 1;
    let buys5 = 0, flow5 = 0, buyQ5 = 0, maxBuy5 = 0, newB5 = 0;
    for (let k = i5; k < j; k++) {
      if (s.side[k] === 1) {
        buys5++;
        flow5 += s.quote[k];
        buyQ5 += s.quote[k];
        if (s.quote[k] > maxBuy5) maxBuy5 = s.quote[k];
        if ((firstBuy.get(s.recipient[k]) ?? 0) >= T - 300) newB5++;
      } else flow5 -= s.quote[k];
    }
    let flow30 = 0, buys30 = 0, snipe30 = 0;
    for (let k = i30; k < j; k++) {
      if (s.side[k] === 1) {
        flow30 += s.quote[k];
        buys30++;
        if (s.taxRate[k] > 0.0001) snipe30++;
      } else flow30 -= s.quote[k];
    }
    const priceAt = (dt: number) => {
      const k = lastLE(s.ts, n, T - dt);
      return k >= 0 ? s.price[k] : s.price[0];
    };
    const p = s.price[last];
    const lr = (a: number, b: number) => (a > 0 && b > 0 ? Math.log(a / b) : 0);
    // holders and concentration
    let holders = 0, top1 = 0, top5 = 0;
    const tops: number[] = [];
    let posSum = 0;
    for (const v of balance.values()) if (v > 1e-9) { holders++; tops.push(v); posSum += v; }
    tops.sort((a, b) => b - a);
    for (let k = 0; k < Math.min(5, tops.length); k++) { if (k === 0) top1 = tops[0]; top5 += tops[k]; }
    // shares are of what holders hold in total, so they can never pass 100% even when tokens moved outside the curve
    const denom = posSum > 0 ? posSum : 1;
    const x = new Float64Array(NF);
    const hour = new Date(T * 1000).getUTCHours() + new Date(T * 1000).getUTCMinutes() / 60;
    let c = 0;
    x[c++] = (T - s.launchedTs) / 60;
    x[c++] = j;
    x[c++] = j - i1;
    x[c++] = n5;
    x[c++] = j - i30;
    x[c++] = firstBuy.size;
    x[c++] = newB5;
    x[c++] = buys5 / n5;
    x[c++] = flow5;
    x[c++] = flow30;
    x[c++] = buys5 ? buyQ5 / buys5 : 0;
    x[c++] = maxBuy5;
    x[c++] = Math.max(0, Math.min(1.5, cumNet / s.threshold));
    x[c++] = lr(p, priceAt(300));
    x[c++] = lr(p, priceAt(1800));
    x[c++] = lr(p, priceAt(7200));
    x[c++] = peak > 0 ? lr(p, peak) : 0;
    x[c++] = top1 / denom;
    x[c++] = top5 / denom;
    x[c++] = holders;
    x[c++] = buys30 ? snipe30 / buys30 : 0;
    x[c++] = Math.max(0, (balance.get(s.deployer) ?? 0)) / denom;
    x[c++] = depSells;
    x[c++] = Math.sin((hour / 24) * 2 * Math.PI);
    x[c++] = Math.cos((hour / 24) * 2 * Math.PI);
    x[c++] = n5 / (j - i30 + 1); // act_ratio: is trading speeding up
    x[c++] = (j - i1) / (n5 + 1); // burst_1m
    x[c++] = newB5 / (firstBuy.size + 1); // newbuyer_ratio
    x[c++] = flow5 / n5; // flow_per_trade

    const sample: Sample = { t: T, x };
    if (opts.labelled) {
      // the label: buying now, could it be sold for at least +x within the horizon, after fees and tax paid both ways?
      const end = T + opts.horizonH * 3600;
      if (end > endTs + 1 && T + opts.horizonH * 3600 > Date.now() / 1000 - 600) continue; // the future is not known yet
      // the cost of a round trip: fee and tax rate, estimated from the last few trades
      let cost = 0, cn = 0;
      for (let k = Math.max(0, last - 4); k <= last; k++) { cost += s.feeRate[k] + s.taxRate[k]; cn++; }
      const cr = Math.min(0.12, cn ? cost / cn : 0.03);
      const entry = p * (1 + cr);
      // the best sustained exit: the highest 5-minute median price with at least two trades in it
      let best = 0;
      for (let b0 = T; b0 < end; b0 += 300) {
        const a = lastLE(s.ts, n, b0) + 1;
        const e = lastLE(s.ts, n, b0 + 300);
        if (e - a + 1 < 2) continue;
        const ps: number[] = [];
        for (let k = a; k <= e; k++) ps.push(s.price[k]);
        ps.sort((u, v) => u - v);
        const med = ps[ps.length >> 1];
        if (med > best) best = med;
      }
      const ret = best > 0 && entry > 0 ? (best * (1 - cr)) / entry - 1 : -1;
      sample.ret = ret;
      sample.y = ret >= opts.x ? 1 : 0;
    }
    out.push(sample);
  }
  return out;
}
