// Training an agent (SPEC section 5): every token it was given becomes labelled samples, the model is fitted on the first 70% of each
// token's life, early stopping uses the next 15%, and the score is calibrated on that same slice. The result is one JSON object.
import { CFG } from "../config.ts";
import type { Db } from "../db.ts";
import { buildSamples, DEFAULT_SET, FEATURES, FEATURE_SETS, NF, type Sample } from "./features.ts";
import { fit, predict, type Gbdt } from "./gbdt.ts";
import { loadSeries } from "./series.ts";

/** The tokens given are fine, but together they cannot teach a model. The user is told why; nothing is refunded. */
export class TrainingDataError extends Error {}

export type Calibration = { a: number; b: number };
export type AgentModel = {
  v: 1;
  trainedAt: number;
  objective: { x: number; hours: number };
  tokens: string[];
  gbdt: Gbdt;
  platt: Calibration;
  thresholds: { low: number; normal: number; high: number }; // calibrated probabilities
  baseline: { trades5mQ80: number };
  stats: { samples: number; positives: number; positiveRate: number; trees: number; valLoss: number | null; valPrecisionNormal: number | null; valBase: number; tokenPositiveRates: number[]; tokensUsed: number };
  featureNames: readonly string[];
  featureIdx: number[]; // which columns of the full feature vector this model reads
};

const sig = (z: number) => 1 / (1 + Math.exp(-z));
const logit = (p: number) => Math.log(Math.min(1 - 1e-6, Math.max(1e-6, p)) / (1 - Math.min(1 - 1e-6, Math.max(1e-6, p))));

/** Platt scaling: two numbers that turn raw scores into probabilities that match what happened on the validation slice. */
export function platt(raw: number[], y: number[]): Calibration {
  let a = 1, b = 0;
  const n = raw.length;
  if (n < 20) return { a, b };
  for (let it = 0; it < 400; it++) {
    let ga = 0, gb = 0;
    for (let i = 0; i < n; i++) {
      const e = sig(a * raw[i] + b) - y[i];
      ga += e * raw[i];
      gb += e;
    }
    a -= (0.3 * ga) / n;
    b -= (0.3 * gb) / n;
  }
  return { a, b };
}
export const select = (m: Pick<AgentModel, "featureIdx">, x: ArrayLike<number>) => Float64Array.from(m.featureIdx, (i) => x[i]);
export const calibrated = (m: Pick<AgentModel, "gbdt" | "platt" | "featureIdx">, x: ArrayLike<number>) => sig(m.platt.a * logit(predict(m.gbdt, select(m, x))) + m.platt.b);

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

export function trainAgent(db: Db, tokens: string[], opts: { set?: string; params?: Parameters<typeof fit>[4] } = {}): AgentModel {
  const featureIdx = FEATURE_SETS[opts.set ?? DEFAULT_SET];
  const obj = CFG.objective;
  const per: { token: string; samples: Sample[] }[] = [];
  for (const token of tokens) {
    const s = loadSeries(db, token);
    if (!s || s.n === 0) continue;
    const smp = buildSamples(s, { horizonH: obj.hours, x: obj.x, labelled: true });
    if (smp.length) per.push({ token, samples: smp });
  }
  const total = per.reduce((a, p) => a + p.samples.length, 0);
  const positives = per.reduce((a, p) => a + p.samples.filter((s) => s.y === 1).length, 0);
  if (total < 300) throw new TrainingDataError(`These tokens had only ${total} active moments between them, which is too few to learn from.`);
  if (positives < 15) throw new TrainingDataError(`Only ${positives} of ${total} moments in these tokens ever reached the outcome, which is too few to learn from. Try tokens that moved more.`);
  if (total - positives < 15) throw new TrainingDataError("Almost every moment in these tokens reached the outcome, so there is nothing to tell apart. Add tokens with a mix of results.");

  const tr: { X: Float64Array[]; y: number[]; w: number[] } = { X: [], y: [], w: [] };
  const va: { X: Float64Array[]; y: number[]; w: number[] } = { X: [], y: [], w: [] };
  const q80src: number[] = [];
  for (const p of per) {
    const n = p.samples.length;
    const nTr = Math.max(1, Math.floor(n * 0.7));
    const nVa = Math.floor(n * 0.15);
    p.samples.forEach((s, i) => {
      q80src.push(s.x[FEATURES.indexOf("trades_5m")]);
      const target = i < nTr ? tr : i < nTr + nVa ? va : null; // the last 15% of each token is left unused
      if (!target) return;
      target.X.push(Float64Array.from(featureIdx, (k) => s.x[k]));
      target.y.push(s.y!);
      target.w.push(1 / (i < nTr ? nTr : Math.max(1, nVa))); // every token counts equally
    });
  }
  const normalise = (d: typeof tr) => {
    let wp = 0, wn = 0, ws = 0;
    d.y.forEach((y, i) => { (y ? (wp += d.w[i]) : (wn += d.w[i])); ws += d.w[i]; });
    const cw = Math.min(10, wn / Math.max(1e-9, wp)); // class balance
    return Float64Array.from(d.w, (w, i) => (w / ws) * d.y.length * (d.y[i] ? cw : 1));
  };
  const trY = Uint8Array.from(tr.y);
  const vaY = Uint8Array.from(va.y);
  const fitted = fit(tr.X, trY, normalise(tr), va.X.length >= 30 ? { X: va.X, y: vaY, w: normalise(va) } : null, opts.params);

  // calibration and thresholds on the validation slice (or the training data when a token set is tiny)
  const calX = va.X.length >= 30 ? va.X : tr.X;
  const calY = va.X.length >= 30 ? va.y : tr.y;
  const rawLogit = calX.map((x) => logit(predict(fitted.model, x)));
  const pl = platt(rawLogit, calY);
  const cal = calX.map((_, i) => sig(pl.a * rawLogit[i] + pl.b));
  const thresholds = { low: quantile(cal, 0.97), normal: quantile(cal, 0.93), high: quantile(cal, 0.85) };
  const hit = cal.map((p, i) => [p, calY[i]] as const).filter(([p]) => p >= thresholds.normal);
  const valBase = calY.reduce((a, b) => a + b, 0) / calY.length;
  return {
    v: 1,
    trainedAt: Math.floor(Date.now() / 1000),
    objective: obj,
    tokens: per.map((p) => p.token),
    gbdt: fitted.model,
    platt: pl,
    thresholds,
    baseline: { trades5mQ80: quantile(q80src, 0.8) },
    stats: {
      samples: total, positives, positiveRate: positives / total, trees: fitted.model.trees.length, valLoss: fitted.valLoss,
      valPrecisionNormal: hit.length ? hit.reduce((a, [, y]) => a + y, 0) / hit.length : null, valBase,
      tokenPositiveRates: per.map((p) => p.samples.filter((s) => s.y === 1).length / p.samples.length), tokensUsed: per.length,
    },
    featureNames: featureIdx.map((k) => FEATURES[k]),
    featureIdx,
  };
}
export { NF };
