// The indexer. It reads Pons launches and curve trades into SQLite so that eligibility, training and alerts never hit the RPC.
//  - launches for the backfill window (BACKFILL_DAYS), then every new one;
//  - trades for those tokens, same window, then every new one (a scan by event topic, filtered to known curves);
//  - older tokens are resolved and filled on demand, the first time someone asks about them.
import { parseAbi } from "viem";
import { CFG } from "./config.ts";
import { blockTs, client, ensureAnchors, hex, loadAnchors, scanLogs, type RawLog } from "./chain.ts";
import { getMeta, setMeta, tx, type Db } from "./db.ts";
import { decodeLaunch, decodeTrade, SIG } from "./pons.ts";

export type TokenRow = {
  address: string; curve: string; deployer: string; launched_block: number; launched_ts: number; pair_token: string | null; threshold: string | null;
  name: string | null; symbol: string | null; graduated: number; graduated_checked: number; full_from: number | null;
};

const erc20 = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);
const curveAbi = parseAbi(["function graduated() view returns (bool)"]);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), "[indexer]", ...a);

export class Indexer {
  curves = new Map<string, string>(); // curve -> token
  private listeners: ((tokens: string[]) => void)[] = [];
  private filling = new Map<string, Promise<void>>();
  headSeen = 0;
  lastError = "";
  ready = false;
  private stopped = false;

  constructor(private db: Db) {}

  onTrades(fn: (tokens: string[]) => void) {
    this.listeners.push(fn);
  }

  async init() {
    loadAnchors(this.db);
    for (const r of this.db.prepare("SELECT address, curve FROM tokens").all() as { address: string; curve: string }[]) this.curves.set(r.curve, r.address);
    const head = await client.getBlockNumber();
    this.headSeen = Number(head);
    if (!getMeta(this.db, "trade_start")) {
      const start = head - BigInt(Math.floor(CFG.backfillDays * 86400 * CFG.blocksPerSecond));
      const s = start > CFG.firstBlock ? start : CFG.firstBlock;
      setMeta(this.db, "trade_start", s.toString());
      setMeta(this.db, "launch_cursor", (s - 1n).toString());
      setMeta(this.db, "trade_cursor", (s - 1n).toString());
      log(`first run: indexing from block ${s} (${CFG.backfillDays} days back), head ${head}`);
    }
  }

  private cursor(k: string) {
    return BigInt(getMeta(this.db, k) ?? "0");
  }

  /** Lag in blocks of the trade cursor behind the chain head. */
  status() {
    const trades = (this.db.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n;
    const tokens = (this.db.prepare("SELECT COUNT(*) AS n FROM tokens").get() as { n: number }).n;
    return { head: this.headSeen, launchCursor: Number(this.cursor("launch_cursor")), tradeCursor: Number(this.cursor("trade_cursor")), tokens, trades, ready: this.ready, lastError: this.lastError };
  }

  async syncLaunches(head: bigint) {
    const from = this.cursor("launch_cursor") + 1n;
    if (from > head) return;
    await ensureAnchors(this.db, from, head);
    const tradeStart = this.cursor("trade_start");
    const ins = this.db.prepare("INSERT OR IGNORE INTO tokens (address, curve, deployer, launched_block, launched_ts, pair_token, threshold, full_from) VALUES (?,?,?,?,?,?,?,?)");
    await scanLogs({ address: CFG.factory, topics: [SIG.launched] }, from, head, 2_000_000n, (logs, _a, b) => {
      tx(this.db, () => {
        for (const l of logs) {
          const d = decodeLaunch(l.topics, l.data);
          const block = Number(BigInt(l.blockNumber));
          // a token launched inside the trade window has all of its trades indexed from its first block
          ins.run(d.token, d.curve, d.deployer, block, blockTs(block), d.pairToken, d.threshold, BigInt(block) >= tradeStart ? block : null);
          this.curves.set(d.curve, d.token);
        }
        setMeta(this.db, "launch_cursor", b.toString());
      });
    });
  }

  private insertTrades(logs: RawLog[], stmt: ReturnType<Db["prepare"]>, onlyKnown: boolean): string[] {
    const touched = new Set<string>();
    for (const l of logs) {
      const token = this.curves.get(l.address.toLowerCase());
      if (onlyKnown && !token) continue;
      const t = decodeTrade(l.topics, l.data);
      if (!t) continue;
      const block = Number(BigInt(l.blockNumber));
      stmt.run(l.address.toLowerCase(), block, Number(BigInt(l.logIndex)), blockTs(block), l.transactionHash, t.side, t.wallet, t.recipient, t.quote, t.tokens, t.fee, t.tax);
      if (token) touched.add(token);
    }
    return [...touched];
  }

  async syncTrades(head: bigint) {
    const upTo = head < this.cursor("launch_cursor") ? head : this.cursor("launch_cursor"); // never read trades of curves we have not seen launch yet
    const from = this.cursor("trade_cursor") + 1n;
    if (from > upTo) return;
    await ensureAnchors(this.db, from, upTo);
    const stmt = this.db.prepare("INSERT OR IGNORE INTO trades (curve, block, log_index, ts, tx, side, wallet, recipient, quote, tokens, fee, tax) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    const behind = Number(upTo - from);
    let windows = 0;
    const touchedAll = new Set<string>();
    await scanLogs({ topics: [[SIG.buy, SIG.sell]] }, from, upTo, 30_000n, (logs, _a, b) => {
      const touched = tx(this.db, () => {
        const t = this.insertTrades(logs, stmt, true);
        setMeta(this.db, "trade_cursor", b.toString());
        return t;
      });
      touched.forEach((x) => touchedAll.add(x));
      if (behind > 200_000 && ++windows % 25 === 0) log(`trades up to block ${b} (${Math.round((100 * Number(b - from)) / behind)}% of this catch-up)`);
    });
    if (touchedAll.size && behind < 100_000) this.listeners.forEach((fn) => fn([...touchedAll]));
  }

  async step() {
    const head = await client.getBlockNumber();
    this.headSeen = Number(head);
    await this.syncLaunches(head);
    await this.syncTrades(head);
    this.ready = Number(head) - Number(this.cursor("trade_cursor")) < 2000;
  }

  start() {
    const loop = async () => {
      while (!this.stopped) {
        try {
          await this.step();
          this.lastError = "";
        } catch (e) {
          this.lastError = String((e as Error)?.message ?? e).slice(0, 200);
          log("error:", this.lastError);
        }
        await new Promise((r) => setTimeout(r, CFG.pollMs));
      }
    };
    void loop();
  }
  stop() {
    this.stopped = true;
  }

  // ---------- on demand ----------
  token(address: string): TokenRow | undefined {
    return this.db.prepare("SELECT * FROM tokens WHERE address = ?").get(address.toLowerCase()) as TokenRow | undefined;
  }

  /** Finds a token that launched before the backfill window (or just now) and adds it to the table. */
  async resolveToken(address: string): Promise<TokenRow | undefined> {
    const known = this.token(address);
    if (known) return known;
    const head = await client.getBlockNumber();
    const padded = "0x" + address.toLowerCase().slice(2).padStart(64, "0");
    let found: RawLog | undefined;
    for (let to = head; to >= CFG.firstBlock && !found; to -= 5_000_000n) {
      const from = to - 4_999_999n > CFG.firstBlock ? to - 4_999_999n : CFG.firstBlock;
      await scanLogs({ address: CFG.factory, topics: [SIG.launched, padded] }, from, to, 5_000_000n, (logs) => void (found ??= logs[0]));
    }
    if (!found) return undefined;
    const d = decodeLaunch(found.topics, found.data);
    const block = BigInt(found.blockNumber);
    await ensureAnchors(this.db, block, block);
    this.db
      .prepare("INSERT OR IGNORE INTO tokens (address, curve, deployer, launched_block, launched_ts, pair_token, threshold, full_from) VALUES (?,?,?,?,?,?,?,NULL)")
      .run(d.token, d.curve, d.deployer, Number(block), blockTs(Number(block)), d.pairToken, d.threshold);
    this.curves.set(d.curve, d.token);
    return this.token(address);
  }

  /** Makes sure every trade of this token is in the table (once). */
  backfillToken(address: string): Promise<void> {
    const t = this.token(address);
    if (!t || t.full_from !== null) return Promise.resolve();
    let p = this.filling.get(t.address);
    if (!p) {
      p = (async () => {
        const head = await client.getBlockNumber();
        await ensureAnchors(this.db, BigInt(t.launched_block), head);
        const stmt = this.db.prepare("INSERT OR IGNORE INTO trades (curve, block, log_index, ts, tx, side, wallet, recipient, quote, tokens, fee, tax) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
        // one event type per query: with both in one query this RPC allows only 100,000 blocks, with one it allows millions
        for (const sig of [SIG.buy, SIG.sell]) {
          await scanLogs({ address: t.curve, topics: [sig] }, BigInt(t.launched_block), head, 2_000_000n, (logs) => tx(this.db, () => void this.insertTrades(logs, stmt, false)));
        }
        this.db.prepare("UPDATE tokens SET full_from = ? WHERE address = ?").run(t.launched_block, t.address);
      })().finally(() => this.filling.delete(t.address));
      this.filling.set(t.address, p);
    }
    return p;
  }

  /** Name and symbol, read once from the token and cached. */
  async meta(address: string): Promise<{ name: string; symbol: string }> {
    const t = this.token(address);
    if (t?.name) return { name: t.name, symbol: t.symbol ?? "" };
    try {
      const [name, symbol] = await Promise.all([
        client.readContract({ address: address as `0x${string}`, abi: erc20, functionName: "name" }),
        client.readContract({ address: address as `0x${string}`, abi: erc20, functionName: "symbol" }),
      ]);
      this.db.prepare("UPDATE tokens SET name = ?, symbol = ? WHERE address = ?").run(name.slice(0, 64), symbol.slice(0, 24), address.toLowerCase());
      return { name, symbol };
    } catch {
      return { name: "", symbol: "" };
    }
  }

  /** Whether the curve has graduated, cached for ten minutes unless it is already known. */
  async graduated(address: string): Promise<boolean> {
    const t = this.token(address);
    if (!t) return false;
    if (t.graduated) return true;
    if (Date.now() / 1000 - t.graduated_checked < 600) return false;
    try {
      const g = await client.readContract({ address: t.curve as `0x${string}`, abi: curveAbi, functionName: "graduated" });
      this.db.prepare("UPDATE tokens SET graduated = ?, graduated_checked = ? WHERE address = ?").run(g ? 1 : 0, Math.floor(Date.now() / 1000), t.address);
      return g;
    } catch {
      return false;
    }
  }
}
