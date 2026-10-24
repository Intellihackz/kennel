// Gradient-boosted decision trees for a yes/no outcome (logistic loss), written for small data: shallow trees, histogram splits,
// per-sample weights, early stopping on a validation slice. The result is a plain JSON object, so scoring needs no native library.
export type Tree = { f: number[]; t: number[]; l: number[]; r: number[]; v: number[] }; // arrays by node. f < 0 marks a leaf. v is the node's own value
export type Gbdt = { base: number; lr: number; trees: Tree[]; nf: number };
export type Params = { depth: number; trees: number; lr: number; lambda: number; minHess: number; bins: number; patience: number };
export const DEFAULTS: Params = { depth: 4, trees: 200, lr: 0.08, lambda: 2, minHess: 3, bins: 48, patience: 25 };

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function predictRaw(m: Gbdt, x: ArrayLike<number>): number {
  let z = m.base;
  for (const t of m.trees) {
    let i = 0;
    while (t.f[i] >= 0) i = x[t.f[i]] <= t.t[i] ? t.l[i] : t.r[i];
    z += m.lr * t.v[i];
  }
  return z;
}
export const predict = (m: Gbdt, x: ArrayLike<number>) => sigmoid(predictRaw(m, x));

/** The features that pushed one prediction up the most (each split moves the node value; that move is credited to its feature). */
export function contributions(m: Gbdt, x: ArrayLike<number>): number[] {
  const c = new Array(m.nf).fill(0);
  for (const t of m.trees) {
    let i = 0;
    while (t.f[i] >= 0) {
      const next = x[t.f[i]] <= t.t[i] ? t.l[i] : t.r[i];
      c[t.f[i]] += m.lr * (t.v[next] - t.v[i]);
      i = next;
    }
  }
  return c;
}

export function fit(X: Float64Array[], y: Uint8Array, w: Float64Array, val: { X: Float64Array[]; y: Uint8Array; w: Float64Array } | null, params: Partial<Params> = {}): { model: Gbdt; bestIter: number; valLoss: number | null } {
  const P = { ...DEFAULTS, ...params };
  const n = X.length;
  const nf = X[0].length;
  // bin edges per feature, from quantiles of the training data
  const edges: number[][] = [];
  for (let f = 0; f < nf; f++) {
    const vals = X.map((r) => r[f]).sort((a, b) => a - b);
    const e: number[] = [];
    for (let b = 1; b < P.bins; b++) {
      const v = vals[Math.min(n - 1, Math.floor((b * n) / P.bins))];
      if (e.length === 0 || v > e[e.length - 1]) e.push(v);
    }
    edges.push(e);
  }
  const bin = (f: number, v: number) => {
    const e = edges[f];
    let lo = 0;
    let hi = e.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v <= e[mid]) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const B: Uint8Array[] = X.map((r) => Uint8Array.from({ length: nf }, (_, f) => bin(f, r[f])));

  let wsum = 0, wpos = 0;
  for (let i = 0; i < n; i++) { wsum += w[i]; wpos += w[i] * y[i]; }
  const prior = Math.min(0.999, Math.max(0.001, wpos / wsum));
  const model: Gbdt = { base: Math.log(prior / (1 - prior)), lr: P.lr, trees: [], nf };
  const z = new Float64Array(n).fill(model.base);
  const zv = val ? new Float64Array(val.X.length).fill(model.base) : null;
  const g = new Float64Array(n);
  const h = new Float64Array(n);
  let bestLoss = Infinity, bestIter = 0, bad = 0;

  for (let it = 0; it < P.trees; it++) {
    for (let i = 0; i < n; i++) {
      const p = sigmoid(z[i]);
      g[i] = w[i] * (p - y[i]);
      h[i] = w[i] * Math.max(p * (1 - p), 1e-6);
    }
    const tree: Tree = { f: [], t: [], l: [], r: [], v: [] };
    const grow = (idx: number[], depth: number): number => {
      const id = tree.f.length;
      let G = 0, H = 0;
      for (const i of idx) { G += g[i]; H += h[i]; }
      tree.f.push(-1); tree.t.push(0); tree.l.push(-1); tree.r.push(-1); tree.v.push(-G / (H + P.lambda));
      if (depth >= P.depth || H < 2 * P.minHess) return id;
      let bestGain = 1e-7, bf = -1, bb = -1;
      for (let f = 0; f < nf; f++) {
        const nb = edges[f].length + 1;
        if (nb < 2) continue;
        const hg = new Float64Array(nb), hh = new Float64Array(nb);
        for (const i of idx) { const b = B[i][f]; hg[b] += g[i]; hh[b] += h[i]; }
        let gl = 0, hl = 0;
        for (let b = 0; b < nb - 1; b++) {
          gl += hg[b]; hl += hh[b];
          const gr = G - gl, hr = H - hl;
          if (hl < P.minHess || hr < P.minHess) continue;
          const gain = (gl * gl) / (hl + P.lambda) + (gr * gr) / (hr + P.lambda) - (G * G) / (H + P.lambda);
          if (gain > bestGain) { bestGain = gain; bf = f; bb = b; }
        }
      }
      if (bf < 0) return id;
      const li: number[] = [], ri: number[] = [];
      for (const i of idx) (B[i][bf] <= bb ? li : ri).push(i);
      tree.f[id] = bf;
      tree.t[id] = edges[bf][bb];
      tree.l[id] = grow(li, depth + 1);
      tree.r[id] = grow(ri, depth + 1);
      return id;
    };
    grow(Array.from({ length: n }, (_, i) => i), 0);
    model.trees.push(tree);
    for (let i = 0; i < n; i++) { let k = 0; while (tree.f[k] >= 0) k = X[i][tree.f[k]] <= tree.t[k] ? tree.l[k] : tree.r[k]; z[i] += P.lr * tree.v[k]; }
    if (val && zv) {
      let loss = 0, ws = 0;
      for (let i = 0; i < val.X.length; i++) {
        let k = 0;
        while (tree.f[k] >= 0) k = val.X[i][tree.f[k]] <= tree.t[k] ? tree.l[k] : tree.r[k];
        zv[i] += P.lr * tree.v[k];
        const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(zv[i])));
        loss += -val.w[i] * (val.y[i] ? Math.log(p) : Math.log(1 - p));
        ws += val.w[i];
      }
      loss /= ws;
      if (loss < bestLoss - 1e-5) { bestLoss = loss; bestIter = it + 1; bad = 0; } else if (++bad >= P.patience) break;
    }
  }
  if (val) model.trees.length = Math.max(1, bestIter);
  return { model, bestIter: val ? bestIter : model.trees.length, valLoss: val ? bestLoss : null };
}
