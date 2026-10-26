// The indexer. pump.fun launches thousands of tokens a day and most of them die within minutes, so it does not keep everything.
//  - every pump.fun transaction arrives over a websocket as it happens;
//  - a token's first trades wait in memory. Only once it has PROMOTE_TRADES trades is it written to SQLite, with all of them;
//  - after that its trades are stored as they happen, so alerts and training never hit the RPC;
//  - trades of tokens nobody is training on are dropped after RETAIN_HOURS;
//  - a token we did not see launch (older, or from before this ran) is read from the chain on demand, the first time someone asks about it.
import { CFG } from "./config.ts";
import { setMeta, tx, type Db } from "./db.ts";
import { addressSignatures, curveOf, curveState, getTxs, isSolAddress, streamPump, eventsFromLogs, type CreateEvent, type LiveHandle, type PumpEvent, type SigInfo, type TradeEvent } from "./solana.ts";

export type TokenRow = {
  address: string; curve: string; deployer: string; launched_block: number; launched_ts: number; pair_token: string | null; threshold: string | null;
  name: string | null; symbol: string | null; graduated: number; graduated_checked: number; full_from: number | null;
};

type Row = [curve: string, slot: number, idx: number, ts: number, sig: string, side: number, wallet: string, recipient: string, quote: string, tokens: string, fee: string, tax: string];
type Pending = { create: CreateEvent; slot: number; rows: Row[]; seen: Set<string>; last: number };

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), "[indexer]", ...a);
const rowOf = (t: TradeEvent, curve: string, slot: number, sig: string, idx: number): Row => [curve, slot, idx, t.ts, sig, t.isBuy ? 1 : 0, t.user, t.user, t.sol, t.tokens, t.fee, "0"];
const MAX_PENDING = 60_000;

export class Indexer {
  private known = new Map<string, string>(); // curve -> token, for the tokens stored in the database
  private pending = new Map<string, Pending>(); // mint -> a young token that has not been stored yet
  private listeners: ((tokens: string[]) => void)[] = [];
  private filling = new Map<string, Promise<void>>();
  private touched = new Set<string>();
  private insTrade;
  private insToken;
  private live: LiveHandle | null = null;
  private timers: NodeJS.Timeout[] = [];
  private sigCache = new Map<string, { at: number; sigs: SigInfo[] }>();
  lastSlot = 0;
  lastError = "";
  ready = false;
  private downSince = 0;

  constructor(private db: Db) {
    this.insTrade = db.prepare("INSERT OR IGNORE INTO trades (curve, block, log_index, ts, tx, side, wallet, recipient, quote, tokens, fee, tax) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    this.insToken = db.prepare("INSERT OR IGNORE INTO tokens (address, curve, deployer, launched_block, launched_ts, pair_token, threshold, name, symbol, full_from) VALUES (?,?,?,?,?,NULL,NULL,?,?,?)");
  }

  onTrades(fn: (tokens: string[]) => void) {
    this.listeners.push(fn);
  }

  async init() {
    for (const r of this.db.prepare("SELECT address, curve FROM tokens").all() as { address: string; curve: string }[]) this.known.set(r.curve, r.address);
  }

  status() {
    const trades = (this.db.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n;
    const tokens = (this.db.prepare("SELECT COUNT(*) AS n FROM tokens").get() as { n: number }).n;
    return { slot: this.lastSlot, connected: this.live?.connected() ?? false, young: this.pending.size, tokens, trades, ready: this.ready, lastError: this.lastError };
  }

  // ---------- live ----------
  private put(rows: Row[]) {
    for (const r of rows) this.insTrade.run(...r);
  }

  private handle(slot: number, sig: string, events: PumpEvent[]) {
    this.lastSlot = Math.max(this.lastSlot, slot);
    events.forEach((ev, idx) => {
      if (ev.kind === "create") {
        if (!ev.solQuoted) return;
        // a launch can carry its creator's own first buy in the same transaction, so the trades that follow are matched to it
        if (this.pending.size < MAX_PENDING) this.pending.set(ev.mint, { create: ev, slot, rows: [], seen: new Set(), last: Date.now() });
        return;
      }
      if (ev.kind === "complete") {
        this.db.prepare("UPDATE tokens SET graduated = 1 WHERE address = ?").run(ev.mint);
        return;
      }
      if (!ev.solQuoted) return;
      const curve = this.curveCache(ev.mint);
      const token = this.known.get(curve);
      if (token) {
        this.insTrade.run(...rowOf(ev, curve, slot, sig, idx));
        this.touched.add(token);
        return;
      }
      const p = this.pending.get(ev.mint);
      if (!p) return; // a token we did not see launch: read on demand if anyone asks
      const key = `${sig}:${idx}`;
      if (p.seen.has(key)) return;
      p.seen.add(key);
      p.rows.push(rowOf(ev, p.create.curve, slot, sig, idx));
      p.last = Date.now();
      if (p.rows.length >= CFG.promoteAfterTrades) this.promote(p);
    });
  }

  private curves = new Map<string, string>();
  private curveCache(mint: string) {
    let c = this.curves.get(mint);
    if (!c) {
      c = curveOf(mint);
      if (this.curves.size > 200_000) this.curves.clear();
      this.curves.set(mint, c);
    }
    return c;
  }

  private promote(p: Pending) {
    const c = p.create;
    tx(this.db, () => {
      this.insToken.run(c.mint, c.curve, c.creator, p.slot, c.ts, c.name, c.symbol, p.slot);
      this.put(p.rows);
    });
    this.known.set(c.curve, c.mint);
    this.pending.delete(c.mint);
    this.touched.add(c.mint);
  }

  private flush() {
    if (!this.touched.size) return;
    const t = [...this.touched];
    this.touched.clear();
    for (const fn of this.listeners) fn(t);
  }

  start() {
    this.live = streamPump(
      (t) => {
        try {
          this.handle(t.slot, t.signature, t.events);
        } catch (e) {
          this.lastError = String((e as Error)?.message ?? e).slice(0, 200);
        }
      },
      (e) => (this.lastError = e),
    );
    this.timers.push(
      setInterval(() => {
        try {
          this.flush();
        } catch (e) {
          log("listener error:", (e as Error).message);
        }
      }, 1000),
      setInterval(() => this.tick(), 5000),
      setInterval(() => this.housekeeping(), 10 * 60_000),
    );
    for (const t of this.timers) t.unref();
  }
  stop() {
    this.live?.stop();
    this.timers.forEach(clearInterval);
  }

  /** Whether the feed is up, and what to do about a stretch when it was not. */
  private tick() {
    const up = !!this.live?.connected() && Date.now() - this.live.lastMessageAt() < 30_000;
    if (up) {
      if (this.downSince) {
        this.markGap(this.downSince);
        this.downSince = 0;
      }
      this.ready = true;
    } else if (!this.downSince && this.ready) this.downSince = Date.now();
  }

  /** Trades that happened while the feed was down were not stored. The tokens that were active are marked incomplete, so the next
   *  time someone asks about one, its whole history is read from the chain again (rows already stored are skipped). */
  private markGap(since: number) {
    if (Date.now() - since < 20_000) return;
    const n = this.db.prepare("UPDATE tokens SET full_from = NULL WHERE launched_ts > ?").run(Math.floor(Date.now() / 1000) - CFG.retainHours * 3600).changes;
    for (const p of this.pending.values()) p.rows = []; // young tokens: what we have is no longer the full story
    this.pending.clear();
    log(`the feed was down for ${Math.round((Date.now() - since) / 1000)}s: ${n} tokens will be re-read when asked about`);
    setMeta(this.db, "last_gap", String(Date.now()));
  }

  private housekeeping() {
    const now = Date.now();
    for (const [m, p] of this.pending) if (now - p.last > 30 * 60_000) this.pending.delete(m);
    for (const [k, v] of this.sigCache) if (now - v.at > 120_000) this.sigCache.delete(k);
    try {
      // old trades go, except for tokens an agent was trained on (the model's evidence)
      const cutoff = Math.floor(now / 1000) - CFG.retainHours * 3600;
      const old = this.db
        .prepare("SELECT t.address, t.curve FROM tokens t WHERE t.launched_ts < ? AND t.full_from IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_tokens a WHERE a.token = t.address)")
        .all(cutoff) as { address: string; curve: string }[];
      for (const o of old) {
        tx(this.db, () => {
          this.db.prepare("DELETE FROM trades WHERE curve = ?").run(o.curve);
          this.db.prepare("UPDATE tokens SET full_from = NULL WHERE address = ?").run(o.address);
        });
      }
      if (old.length) log(`dropped the trades of ${old.length} old tokens`);
    } catch (e) {
      log("housekeeping error:", (e as Error).message);
    }
  }

  // ---------- on demand ----------
  token(address: string): TokenRow | undefined {
    return this.db.prepare("SELECT * FROM tokens WHERE address = ?").get(address) as TokenRow | undefined;
  }

  private async signatures(curve: string): Promise<SigInfo[]> {
    const hit = this.sigCache.get(curve);
    if (hit && Date.now() - hit.at < 60_000) return hit.sigs;
    const sigs = await addressSignatures(curve, CFG.maxBackfillSignatures);
    this.sigCache.set(curve, { at: Date.now(), sigs });
    return sigs;
  }

  /** Finds a token that is not in the table (older than this server, or too young to have been stored) and adds it. */
  async resolveToken(address: string): Promise<TokenRow | undefined> {
    const known = this.token(address);
    if (known) return known;
    if (!isSolAddress(address)) return undefined;
    const curve = curveOf(address);
    const state = await curveState(curve);
    if (!state.exists) return undefined;
    const young = this.pending.get(address);
    if (young) {
      this.promote(young);
      return this.token(address);
    }
    const sigs = await this.signatures(curve);
    if (!sigs.length) return undefined;
    if (sigs.length >= CFG.maxBackfillSignatures) throw new Error("That token has too many trades for Kennel to read.");
    const [first] = await getTxs([sigs[0].signature]);
    const create = first && eventsFromLogs(first.logs).find((e): e is CreateEvent => e.kind === "create" && e.mint === address);
    if (!create) return undefined;
    if (!create.solQuoted) throw new Error("That token trades against something other than SOL, which Kennel does not read.");
    this.insToken.run(address, curve, create.creator, first!.slot, create.ts, create.name, create.symbol, null);
    if (state.complete) this.db.prepare("UPDATE tokens SET graduated = 1 WHERE address = ?").run(address);
    this.known.set(curve, address);
    return this.token(address);
  }

  /** Makes sure every trade of this token is in the table. A token that is already complete costs nothing. */
  backfillToken(address: string): Promise<void> {
    const t = this.token(address);
    if (!t) return Promise.resolve();
    if (t.full_from !== null) return Promise.resolve();
    let p = this.filling.get(t.address);
    if (!p) {
      p = (async () => {
        const sigs = await this.signatures(t.curve);
        if (sigs.length >= CFG.maxBackfillSignatures) throw new Error("That token has too many trades for Kennel to read.");
        let unread = 0;
        const have = new Set((this.db.prepare("SELECT tx FROM trades WHERE curve = ?").all(t.curve) as { tx: string }[]).map((r) => r.tx));
        const need = sigs.filter((s) => !have.has(s.signature));
        for (let i = 0; i < need.length; i += 100) {
          const part = need.slice(i, i + 100);
          const txs = await getTxs(part.map((s) => s.signature));
          tx(this.db, () => {
            for (const x of txs) {
              if (!x) {
                unread++;
                continue;
              }
              if (x.failed) continue;
              let idx = 0;
              for (const ev of eventsFromLogs(x.logs)) {
                if (ev.kind === "trade" && ev.mint === t.address && ev.solQuoted) this.insTrade.run(...rowOf(ev, t.curve, x.slot, x.signature, idx));
                idx++;
              }
            }
          });
        }
        // a token is only marked complete if the chain gave back (nearly) every transaction; otherwise the next ask tries again
        if (unread > Math.max(1, need.length * 0.01)) throw new Error("Kennel could not read all of that token's trades from the chain. Try again in a minute.");
        this.db.prepare("UPDATE tokens SET full_from = ? WHERE address = ?").run(t.launched_block, t.address);
      })().finally(() => this.filling.delete(t.address));
      this.filling.set(t.address, p);
    }
    return p;
  }

  /** Name and symbol: they were read from the launch event, so no RPC call is needed. */
  async meta(address: string): Promise<{ name: string; symbol: string }> {
    const t = this.token(address);
    return { name: t?.name ?? "", symbol: t?.symbol ?? "" };
  }

  /** Whether the token has graduated to a DEX, cached for ten minutes unless it is already known. */
  async graduated(address: string): Promise<boolean> {
    const t = this.token(address);
    if (!t) return false;
    if (t.graduated) return true;
    if (Date.now() / 1000 - t.graduated_checked < 600) return false;
    try {
      const s = await curveState(t.curve);
      this.db.prepare("UPDATE tokens SET graduated = ?, graduated_checked = ? WHERE address = ?").run(s.complete ? 1 : 0, Math.floor(Date.now() / 1000), t.address);
      return s.complete;
    } catch {
      return false;
    }
  }
}
