// Everything tunable lives here, read from the environment once. Defaults match SPEC.md.
const env = process.env;
const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);

export const CFG = {
  port: num("PORT", 8788),
  rpc: env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
  chainId: 4663,
  factory: (env.PONS_FACTORY ?? "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e").toLowerCase(),
  dbPath: env.DB_PATH ?? "data/kennel.db",
  distDir: env.DIST_DIR ?? "dist",
  trustProxy: env.TRUST_PROXY === "1",
  // which header carries the visitor's address behind your host's proxy. Fly: fly-client-ip. Railway and most others: x-forwarded-for.
  clientIpHeader: (env.CLIENT_IP_HEADER ?? "x-forwarded-for").toLowerCase(),
  production: env.NODE_ENV === "production",

  // the indexer
  firstBlock: BigInt(num("FIRST_BLOCK", 26_000_000)), // before the first Pons v2 launch (August 2026)
  backfillDays: num("BACKFILL_DAYS", 3), // trades for every token are indexed this far back; older tokens are filled on demand
  blocksPerSecond: 9.5,
  anchorStep: 20_000n, // blocks between sampled block times (log timestamps are zero on this RPC)
  pollMs: num("POLL_MS", 3000),
  indexer: env.INDEXER !== "0",

  // product rules (decided with the owner)
  minTokens: 5,
  minTrades: 300,
  minAgeHours: 24,
  minActiveMinutes: 60, // a token must have traded steadily for this many minutes in its first day, or there is too little to learn from
  pricePerToken: num("PRICE_PER_TOKEN", 100_000), // whole platform tokens
  platformToken: (env.PLATFORM_TOKEN ?? "").toLowerCase(), // set once the token exists
  burnAddress: "0x000000000000000000000000000000000000dead", // payments are burned: sent here, collected by nobody
  mockPayments: env.MOCK_PAYMENTS === "1" || (!env.PLATFORM_TOKEN && env.NODE_ENV !== "production"), // no token yet: orders settle without a transfer, in development only

  // the single objective every agent learns (SPEC section 5.1): net return of at least X within H hours, after fees
  objective: { x: num("OBJ_X", 0.2), hours: num("OBJ_H", 3) },
  testPoolSize: num("TEST_POOL", 30),
  testMargin: num("TEST_MARGIN", 1.1), // with TEST_GATE=rule: the agent's hit rate must beat the simple rule by this factor
  testGate: (env.TEST_GATE === "rule" ? "rule" : "chance") as "chance" | "rule", // what 'passing' means: reliably better than random alerts (default), or also better than the simple rule
  alertCooldownMin: 30,
  sessionSecret: env.SESSION_SECRET ?? "",
};
export type Cfg = typeof CFG;
