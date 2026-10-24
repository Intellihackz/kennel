// The RPC layer. Two quirks of this chain shape everything here (found by probing it):
//  - a query may return at most 10,000 logs, and without an address filter it may span at most 30,000 blocks, so every scan splits itself;
//  - logs carry no usable timestamp (blockTimestamp is 0), so block times come from sampled blocks and are interpolated.
import { createPublicClient, http } from "viem";
import { CFG } from "./config.ts";
import type { Db } from "./db.ts";

export const client = createPublicClient({ transport: http(CFG.rpc, { retryCount: 4, retryDelay: 500, batch: { batchSize: 10, wait: 8 } }) });
export const hex = (n: bigint | number) => "0x" + n.toString(16);

export type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string };
type Filter = { address?: string; topics: (string | string[] | null)[] };

/** Tries again a few times with growing pauses: this RPC sometimes answers a batch incompletely or drops a connection. */
export async function retry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (isLimit(e)) throw e; // a range problem is not transient, the caller splits instead
      await new Promise((r) => setTimeout(r, 400 * 2 ** i));
    }
  }
  throw last;
}

const isLimit = (e: unknown) => /limit|exceed|too many|more than|span/i.test(String((e as { details?: string; message?: string })?.details ?? (e as Error)?.message ?? ""));

/** Reads logs over [from, to] in windows of at most `maxSpan` blocks, halving any window the RPC refuses. `onChunk` gets each result. */
export async function scanLogs(filter: Filter, from: bigint, to: bigint, maxSpan: bigint, onChunk: (logs: RawLog[], from: bigint, to: bigint) => void) {
  const one = async (a: bigint, b: bigint): Promise<void> => {
    let logs: RawLog[];
    try {
      logs = (await retry(() => client.request({ method: "eth_getLogs", params: [{ ...filter, fromBlock: hex(a), toBlock: hex(b) }] } as never))) as RawLog[];
    } catch (e) {
      if (isLimit(e) && b > a) {
        const mid = (a + b) / 2n;
        await one(a, mid);
        await one(mid + 1n, b);
        return;
      }
      throw e;
    }
    onChunk(logs, a, b);
  };
  for (let a = from; a <= to; a += maxSpan) await one(a, a + maxSpan - 1n > to ? to : a + maxSpan - 1n);
}

// ---------- block times ----------
type Anchor = [number, number]; // block, ts
let anchors: Anchor[] = [];

export function loadAnchors(db: Db) {
  anchors = (db.prepare("SELECT block, ts FROM anchors ORDER BY block").all() as { block: number; ts: number }[]).map((r) => [r.block, r.ts]);
}

/** Makes sure there is a sampled block time every `anchorStep` blocks over [from, to], plus one at `to` itself. */
export async function ensureAnchors(db: Db, from: bigint, to: bigint) {
  const have = new Set(anchors.map((a) => a[0]));
  const want: bigint[] = [];
  const step = CFG.anchorStep;
  for (let b = (from / step) * step; b <= to + step; b += step) {
    const blk = b > to ? to : b;
    if (blk >= 0n && !have.has(Number(blk)) && !want.includes(blk)) want.push(blk);
  }
  if (!have.has(Number(to)) && !want.includes(to)) want.push(to);
  const ins = db.prepare("INSERT OR REPLACE INTO anchors (block, ts) VALUES (?, ?)");
  for (let i = 0; i < want.length; i += 20) {
    const part = want.slice(i, i + 20);
    const blocks = await Promise.all(part.map((n) => retry(() => client.getBlock({ blockNumber: n }))));
    db.exec("BEGIN");
    blocks.forEach((b, j) => ins.run(Number(part[j]), Number(b.timestamp)));
    db.exec("COMMIT");
  }
  if (want.length) loadAnchors(db);
}

/** Interpolated unix time of a block (about 10 seconds of error, fine for one-minute bins). */
export function blockTs(block: number): number {
  const n = anchors.length;
  if (n === 0) throw new Error("no block anchors loaded");
  if (n === 1) return anchors[0][1] + (block - anchors[0][0]) / CFG.blocksPerSecond;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (anchors[mid][0] <= block) lo = mid;
    else hi = mid - 1;
  }
  let a = anchors[lo];
  let b = anchors[Math.min(lo + 1, n - 1)];
  if (a === b) {
    a = anchors[n - 2];
    b = anchors[n - 1];
  }
  const rate = (b[1] - a[1]) / Math.max(1, b[0] - a[0]);
  return Math.round(a[1] + (block - a[0]) * rate);
}

export const latestAnchorBlock = () => (anchors.length ? anchors[anchors.length - 1][0] : 0);
