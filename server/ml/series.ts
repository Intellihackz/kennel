// A token's trades as flat typed arrays, ready for feature building. Amounts are in whole units (SOL, and tokens at 6 decimals).
import { CFG } from "../config.ts";
import type { Db } from "../db.ts";

export type Series = {
  curve: string; deployer: string; launchedTs: number; threshold: number; // SOL in the curve at graduation
  n: number; ts: Float64Array; side: Uint8Array; quote: Float64Array; tokens: Float64Array; price: Float64Array;
  feeRate: Float64Array; taxRate: Float64Array; extraCost: number; wallet: string[]; recipient: string[];
};

const LAMPORTS = 1e9;
const TOKEN_UNIT = 1e6; // pump.fun tokens have 6 decimals

export function loadSeries(db: Db, token: string): Series | null {
  const t = db.prepare("SELECT curve, deployer, launched_ts, threshold FROM tokens WHERE address = ?").get(token) as { curve: string; deployer: string; launched_ts: number; threshold: string | null } | undefined;
  if (!t) return null;
  const rows = db.prepare("SELECT ts, side, wallet, recipient, quote, tokens, fee, tax FROM trades WHERE curve = ? ORDER BY block, ts, tx, log_index").all(t.curve) as { ts: number; side: number; wallet: string; recipient: string; quote: string; tokens: string; fee: string; tax: string }[];
  const n = rows.length;
  const s: Series = {
    curve: t.curve, deployer: t.deployer, launchedTs: t.launched_ts, threshold: CFG.graduationSol, extraCost: CFG.extraCost,
    n, ts: new Float64Array(n), side: new Uint8Array(n), quote: new Float64Array(n), tokens: new Float64Array(n), price: new Float64Array(n),
    feeRate: new Float64Array(n), taxRate: new Float64Array(n), wallet: new Array(n), recipient: new Array(n),
  };
  let prevTs = 0;
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    const q = Number(r.quote) / LAMPORTS;
    const k = Number(r.tokens) / TOKEN_UNIT;
    s.ts[i] = Math.max(r.ts, prevTs); // event times are whole seconds and can arrive slightly out of order; keep the series monotonic
    prevTs = s.ts[i];
    s.side[i] = r.side;
    s.quote[i] = q;
    s.tokens[i] = k;
    s.price[i] = k > 0 ? q / k : 0;
    const qr = Number(r.quote);
    s.feeRate[i] = qr > 0 ? Number(r.fee) / qr : 0;
    s.taxRate[i] = qr > 0 ? Number(r.tax) / qr : 0;
    s.wallet[i] = r.wallet;
    s.recipient[i] = r.recipient;
  }
  return s;
}
