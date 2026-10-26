// Solana, and pump.fun on it: the RPC with a rate limit, the curve address of a token, and a decoder for the events pump.fun emits
// (a trade, a launch, a graduation). The layouts come from pump.fun's published IDL (pump-fun/pump-public-docs, idl/pump.json).
//
// Events appear in a transaction's logs as `Program data: <base64>` lines, written by the pump program. Anchor puts an 8 byte
// discriminator first and the fields after it in Borsh. New fields are only ever added at the end of an event, so older events are
// a prefix of the current layout: every optional field is read only if bytes remain.
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { CFG } from "./config.ts";

export const PUMP_ID = CFG.pumpProgram;
const PUMP_PK = new PublicKey(PUMP_ID);
export const WSOL = "So11111111111111111111111111111111111111112";
const ZERO_KEY = "11111111111111111111111111111111";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const isSolAddress = (s: unknown): s is string => {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  try {
    return bs58.decode(s).length === 32;
  } catch {
    return false;
  }
};
export const isSignature = (s: unknown): s is string => {
  if (typeof s !== "string" || s.length < 80 || s.length > 90) return false;
  try {
    return bs58.decode(s).length === 64;
  } catch {
    return false;
  }
};

/** The bonding curve account of a pump.fun token: a program derived address, so it can be worked out from the mint alone. */
export const curveOf = (mint: string): string => PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBytes()], PUMP_PK)[0].toBase58();

// ---------------------------------------------------------------- RPC
export class RpcError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
  }
}

/** Spaces requests so that at most `rps` are sent per second, however many callers there are. */
class Gate {
  private next = 0;
  constructor(private rps: number) {}
  async wait(n = 1) {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + (1000 / this.rps) * n;
    if (at > now) await sleep(at - now);
  }
}
const gate = new Gate(Math.max(1, CFG.rpcRps));

async function post(body: unknown, tries = 6): Promise<unknown> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    await gate.wait(Array.isArray(body) ? body.length : 1);
    try {
      const res = await fetch(CFG.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 || res.status >= 500) {
        last = new RpcError(`The RPC answered ${res.status}`, res.status);
        await sleep(Math.min(8000, 500 * 2 ** i) + Math.random() * 250);
        continue;
      }
      return await res.json();
    } catch (e) {
      last = e;
      await sleep(Math.min(8000, 500 * 2 ** i));
    }
  }
  throw last instanceof Error ? last : new RpcError("The RPC did not answer");
}

export async function rpc<T = any>(method: string, params: unknown[] = []): Promise<T> {
  const j = (await post({ jsonrpc: "2.0", id: 1, method, params })) as { result?: T; error?: { code: number; message: string } };
  if (j.error) throw new RpcError(j.error.message, j.error.code);
  return j.result as T;
}

const isBusy = (e?: { code?: number; message?: string }) => !!e && (e.code === -32429 || e.code === -32005 || /too many|rate|limit|busy|try again/i.test(e.message ?? ""));

/** Several calls in one request. A call the RPC refused for being busy is sent again (it is the RPC, not the call, that failed);
 *  a call that fails for any other reason comes back as null, so one bad transaction does not lose the batch. */
export async function rpcBatch<T = any>(calls: { method: string; params: unknown[] }[]): Promise<(T | null)[]> {
  const res: (T | null)[] = new Array(calls.length).fill(null);
  let todo = calls.map((_, i) => i);
  for (let round = 0; todo.length; round++) {
    const body = todo.map((i) => ({ jsonrpc: "2.0", id: i, method: calls[i].method, params: calls[i].params }));
    const out = (await post(body)) as { id: number; result?: T; error?: { code?: number; message?: string } }[] | { error?: { message: string } };
    if (!Array.isArray(out)) throw new RpcError(out?.error?.message ?? "The RPC refused the batch");
    const again: number[] = [];
    for (const r of out) {
      if (!r || typeof r.id !== "number") continue;
      if (r.error && isBusy(r.error)) again.push(r.id);
      else if (r.result !== undefined) res[r.id] = r.result;
    }
    // an id missing from the answer is treated like a busy one
    const got = new Set(out.map((r) => r?.id));
    for (const i of todo) if (!got.has(i) && !again.includes(i)) again.push(i);
    todo = again;
    if (todo.length) {
      if (round >= 8) throw new RpcError(`The RPC stayed too busy to answer ${todo.length} calls`, 429);
      await sleep(Math.min(6000, 400 * 2 ** round) + Math.random() * 200);
    }
  }
  return res;
}

// ---------------------------------------------------------------- transactions
export type Tx = { signature: string; slot: number; blockTime: number | null; index: number; logs: string[]; failed: boolean };

/** Reads transactions by signature, in batches. A transaction the RPC no longer has comes back as null. */
export async function getTxs(signatures: string[], batch = 10): Promise<(Tx | null)[]> {
  const out: (Tx | null)[] = [];
  for (let i = 0; i < signatures.length; i += batch) {
    const part = signatures.slice(i, i + batch);
    // maxSupportedTransactionVersion: Solana has more than one transaction format, and the RPC refuses a newer one unless told it may return it
    const res = await rpcBatch<any>(part.map((s) => ({ method: "getTransaction", params: [s, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] })));
    res.forEach((r, k) => out.push(r ? { signature: part[k], slot: r.slot, blockTime: r.blockTime ?? null, index: r.transactionIndex ?? 0, logs: r.meta?.logMessages ?? [], failed: !!r.meta?.err } : null));
  }
  return out;
}

export type SigInfo = { signature: string; slot: number; blockTime: number | null };

/** Every successful transaction that touched `address`, oldest first, up to `max`. Used with a token's curve account to read its whole history. */
export async function addressSignatures(address: string, max: number): Promise<SigInfo[]> {
  const out: SigInfo[] = [];
  let before: string | undefined;
  let read = 0;
  while (read < max) {
    const page = await rpc<{ signature: string; slot: number; blockTime: number | null; err: unknown }[]>("getSignaturesForAddress", [address, { limit: 1000, before, commitment: "confirmed" }]);
    if (!page.length) break;
    for (const x of page) if (!x.err) out.push({ signature: x.signature, slot: x.slot, blockTime: x.blockTime });
    read += page.length;
    before = page[page.length - 1].signature;
    if (page.length < 1000) break;
  }
  return out.reverse();
}

export type Account = { owner: string; data: Buffer; lamports: number };
export async function getAccount(address: string): Promise<Account | null> {
  const r = await rpc<{ value: { owner: string; lamports: number; data: [string, string] } | null }>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  return r.value ? { owner: r.value.owner, lamports: r.value.lamports, data: Buffer.from(r.value.data[0], "base64") } : null;
}

/** The state of a token's curve account: whether it exists and belongs to pump.fun, and whether the token has graduated. */
export async function curveState(curve: string): Promise<{ exists: boolean; complete: boolean }> {
  const a = await getAccount(curve);
  if (!a || a.owner !== PUMP_ID || a.data.length < 49) return { exists: false, complete: false };
  // 8 byte discriminator, then five u64 (virtual and real reserves, total supply), then `complete`
  return { exists: true, complete: a.data[8 + 5 * 8] === 1 };
}

// ---------------------------------------------------------------- events
class Reader {
  o = 0;
  constructor(private b: Buffer) {}
  left() {
    return this.b.length - this.o;
  }
  u8() {
    return this.b[this.o++];
  }
  bool() {
    return this.u8() !== 0;
  }
  u16() {
    const v = this.b.readUInt16LE(this.o);
    this.o += 2;
    return v;
  }
  u32() {
    const v = this.b.readUInt32LE(this.o);
    this.o += 4;
    return v;
  }
  u64() {
    const v = this.b.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  i64() {
    const v = this.b.readBigInt64LE(this.o);
    this.o += 8;
    return Number(v);
  }
  pk() {
    const s = bs58.encode(this.b.subarray(this.o, this.o + 32));
    this.o += 32;
    return s;
  }
  str() {
    const n = this.u32();
    const s = this.b.toString("utf8", this.o, this.o + n);
    this.o += n;
    return s;
  }
}

export type TradeEvent = {
  kind: "trade"; mint: string; user: string; isBuy: boolean; ts: number;
  sol: string; tokens: string; fee: string; // lamports, raw token units, and every fee the trader paid (lamports)
  virtualSol: string; virtualTokens: string; creator: string; quoteMint: string; solQuoted: boolean;
};
export type CreateEvent = { kind: "create"; name: string; symbol: string; uri: string; mint: string; curve: string; creator: string; ts: number; quoteMint: string; solQuoted: boolean };
export type CompleteEvent = { kind: "complete"; mint: string; ts: number };
export type PumpEvent = TradeEvent | CreateEvent | CompleteEvent;

const DISC = {
  trade: Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
  create: Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]),
  complete: Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]),
};
// pump.fun can also trade against a token other than SOL. Those tokens are not priced in SOL, so they are marked and left out.
const isSolQuote = (q: string) => q === ZERO_KEY || q === WSOL;

export function decodeEvent(data: Buffer): PumpEvent | null {
  if (data.length < 16) return null;
  const d = data.subarray(0, 8);
  const r = new Reader(data.subarray(8));
  try {
    if (d.equals(DISC.trade)) {
      if (r.left() < 217) return null;
      const mint = r.pk();
      const sol = r.u64();
      const tokens = r.u64();
      const isBuy = r.bool();
      const user = r.pk();
      const ts = r.i64();
      const vSol = r.u64();
      const vTok = r.u64();
      r.u64(); // real SOL reserves
      r.u64(); // real token reserves
      r.pk(); // fee recipient
      r.u64(); // fee basis points
      let fee = r.u64();
      const creator = r.pk();
      r.u64(); // creator fee basis points
      fee += r.u64(); // creator fee
      let quote = ZERO_KEY;
      // the optional tail, in the order of the IDL; each part only if the event is long enough to hold it
      if (r.left() >= 1 + 8 * 3 + 8) {
        r.u8(); // track volume
        r.u64(); r.u64(); r.u64(); // unclaimed, claimed, current volume
        r.i64(); // last update timestamp
        if (r.left() >= 4) {
          r.str(); // instruction name
          if (r.left() >= 1 + 8 * 4) {
            r.u8(); // mayhem mode
            r.u64(); r.u64(); // cashback fee bps and amount (a rebate to the trader: not a cost)
            r.u64(); // buyback fee bps
            fee += r.u64(); // buyback fee
            if (r.left() >= 4) {
              const n = r.u32();
              if (r.left() >= n * 34 + 32) {
                for (let i = 0; i < n; i++) { r.pk(); r.u16(); }
                quote = r.pk();
                r.u64(); r.u64(); r.u64(); // quote amount and the two quote reserves
                if (r.left() >= 16) { r.u64(); fee += r.u64(); } // holder rewards bps and amount
              }
            }
          }
        }
      }
      return { kind: "trade", mint, user, isBuy, ts, sol: sol.toString(), tokens: tokens.toString(), fee: fee.toString(), virtualSol: vSol.toString(), virtualTokens: vTok.toString(), creator, quoteMint: quote, solQuoted: isSolQuote(quote) };
    }
    if (d.equals(DISC.create)) {
      const name = r.str();
      const symbol = r.str();
      const uri = r.str();
      const mint = r.pk();
      const curve = r.pk();
      r.pk(); // user
      const creator = r.pk();
      const ts = r.i64();
      let quote = ZERO_KEY;
      // virtual token, virtual SOL, real token, total supply, token program, mayhem, cashback, then the quote mint
      if (r.left() >= 8 * 4 + 32 + 2 + 32) {
        r.u64(); r.u64(); r.u64(); r.u64(); r.pk(); r.u8(); r.u8();
        quote = r.pk();
      }
      return { kind: "create", name: name.slice(0, 64), symbol: symbol.slice(0, 24), uri, mint, curve, creator, ts, quoteMint: quote, solQuoted: isSolQuote(quote) };
    }
    if (d.equals(DISC.complete)) {
      r.pk(); // user
      const mint = r.pk();
      r.pk(); // bonding curve
      return { kind: "complete", mint, ts: r.i64() };
    }
  } catch {
    return null;
  }
  return null;
}

/** The pump.fun events in a transaction's logs, in order. Only lines written while the pump program is running count, so another
 *  program (or a copy of pump.fun's event bytes in someone else's log line) cannot fake a trade. */
export function eventsFromLogs(logs: string[]): PumpEvent[] {
  const out: PumpEvent[] = [];
  const stack: string[] = [];
  for (const line of logs) {
    if (line.startsWith("Program data: ")) {
      if (stack[stack.length - 1] !== PUMP_ID) continue;
      const ev = decodeEvent(Buffer.from(line.slice(14), "base64"));
      if (ev) out.push(ev);
      continue;
    }
    const inv = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (inv) {
      stack.push(inv[1]);
      continue;
    }
    if (/^Program \w+ (success|failed.*)$/.test(line)) stack.pop();
  }
  return out;
}

// ---------------------------------------------------------------- live feed
export type LiveHandle = { stop: () => void; lastMessageAt: () => number; connected: () => boolean };

/** Follows every pump.fun transaction as it happens, over a websocket, and hands over the events decoded from its logs.
 *  It reconnects by itself, and restarts a connection that has gone quiet. */
export function streamPump(onTx: (t: { signature: string; slot: number; events: PumpEvent[] }) => void, onError: (e: string) => void = () => {}): LiveHandle {
  let ws: WebSocket | null = null;
  let stopped = false;
  let last = 0;
  let up = false;
  let attempt = 0;
  const open = () => {
    if (stopped) return;
    ws = new WebSocket(CFG.ws);
    ws.onopen = () => {
      up = true;
      attempt = 0;
      last = Date.now();
      ws!.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "logsSubscribe", params: [{ mentions: [PUMP_ID] }, { commitment: "confirmed" }] }));
    };
    ws.onmessage = (m) => {
      last = Date.now();
      try {
        const j = JSON.parse(String(m.data));
        if (j.error) return onError(String(j.error.message ?? "subscription refused"));
        const v = j.params?.result?.value;
        if (j.method !== "logsNotification" || !v || v.err) return;
        const events = eventsFromLogs(v.logs ?? []);
        if (events.length) onTx({ signature: v.signature, slot: j.params.result.context?.slot ?? 0, events });
      } catch {
        /* a malformed message is skipped */
      }
    };
    ws.onclose = () => {
      up = false;
      if (!stopped) setTimeout(open, Math.min(15_000, 1000 * 2 ** attempt++));
    };
    ws.onerror = () => onError("websocket error");
  };
  open();
  const watchdog = setInterval(() => {
    if (!stopped && ws && Date.now() - last > 45_000) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }, 15_000);
  watchdog.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(watchdog);
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    },
    lastMessageAt: () => last,
    connected: () => up,
  };
}
