// Everything tunable lives here, read from the environment once. Defaults match SPEC.md.
const env = process.env;
const num = (k: string, d: number) => (env[k] ? Number(env[k]) : d);

export const CFG = {
  port: num("PORT", 8788),
  // Solana. A keyed RPC (Helius or similar) is needed in production: the public endpoint is rate limited and refuses most history reads.
  rpc: env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  ws: env.SOLANA_WS_URL ?? (env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com").replace(/^http/, "ws"),
  rpcRps: num("RPC_RPS", 8), // requests per second Kennel allows itself against the RPC; set it to your plan's limit
  pumpProgram: env.PUMP_PROGRAM ?? "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun's bonding curve program
  dbPath: env.DB_PATH ?? "data/kennel.db",
  distDir: env.DIST_DIR ?? "dist",
  trustProxy: env.TRUST_PROXY === "1",
  // which header carries the visitor's address behind your host's proxy. Fly: fly-client-ip. Railway and most others: x-forwarded-for.
  clientIpHeader: (env.CLIENT_IP_HEADER ?? "x-forwarded-for").toLowerCase(),
  production: env.NODE_ENV === "production",

  // the indexer
  maxBackfillSignatures: num("MAX_BACKFILL_SIGS", 20_000), // the most transactions read for one token's history
  promoteAfterTrades: num("PROMOTE_TRADES", 25), // a launch is kept in the database once it has this many trades: most tokens die in minutes and are never stored
  retainHours: num("RETAIN_HOURS", 72), // live trades are kept this long, unless an agent was trained on the token
  graduationSol: num("GRADUATION_SOL", 85), // SOL on the curve when pump.fun graduates a token (used for the progress feature)
  extraCost: num("EXTRA_COST", 0.01), // round-trip cost beyond pump.fun's fees: priority fees, tips and slippage, as a fraction of the trade
  indexer: env.INDEXER !== "0",

  // product rules (decided with the owner)
  minTokens: 5,
  minTrades: 300,
  minAgeHours: 24,
  minActiveMinutes: 60, // a token must have traded steadily for this many minutes in its first day, or there is too little to learn from
  pricePerToken: num("PRICE_PER_TOKEN", 100_000), // whole platform tokens
  platformToken: env.PLATFORM_TOKEN ?? "", // the platform token's mint address, set once the token exists. Payments are burned with Solana's burn instruction: destroyed, collected by nobody
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
