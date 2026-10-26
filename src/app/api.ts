// The client for the Kennel API. Every call carries the wallet's session token.
import { getToken } from "./wallet";

export type TokenView = { token: string; name: string; symbol: string; trades: number; ageHours: number; graduated: boolean; addedAt: number; state: "trained" | "training" };
export type Reason = { feature: string; label: string; value: string };
export type TestReport = {
  passed: boolean; reasons: string[]; poolSize: number; poolOutOfTime: number; moments: number; alerts: number; tokensWithAlerts: number;
  precision: number | null; ciLow: number | null; baseRate: number; rulePrecision: number | null; beatsRule: boolean; gate: "chance" | "rule";
  meanReturn: number | null; worstReturn: number | null; overfit: boolean; notes: string[]; objective: { x: number; hours: number }; sensitivity: string; testedAt: number;
};
export type Settings = { sensitivity: "low" | "normal" | "high"; webhookUrl: string; perTrade: string; daily: string };
export type AgentStatus = "empty" | "collecting" | "training" | "ready_to_test" | "testing" | "locked" | "ready";
export type AgentView = {
  id: string; name: string; createdAt: number; status: AgentStatus; minTokens: number; trainedCount: number; tokens: TokenView[];
  orders: { id: string; token: string; status: string; error: string | null; createdAt: number }[];
  test: TestReport | null; model: { trainedAt: number; tokensUsed: number; samples: number; trees: number; positiveRate: number; objective: { x: number; hours: number } } | null;
  settings: Settings; alertCount: number; lastError: string | null;
};
export type Config = {
  platformToken: string | null; tokenProgram: string; decimals: number; pricePerToken: number; minTokens: number; minTrades: number;
  minAgeHours: number; minActiveMinutes: number; mockPayments: boolean; objective: { x: number; hours: number }; testGate: "chance" | "rule"; indexerReady: boolean;
};
export type Eligibility = { ok: boolean; reason?: string; token?: string; name: string; symbol: string; trades: number; ageHours: number; graduated: boolean; activeMinutes: number };
export type Order = { id: string; agentId: string; token: string; amount: string; decimals: number; status: string; expiresAt: number; error: string | null; platformToken: string | null; tokenProgram: string; mock: boolean; price: number; credit: boolean };
export type AlertView = { id: number; token: string; curve: string; name: string; symbol: string; at: number; probability: number; reasons: Reason[]; price: string | null; webhook: string | null };

export type Burns = { totalBurned: number; last24h: number; tokensTrained: number; perToken: number; days: { day: string; burned: number }[]; platformToken: string | null; tokenProgram: string; creditsIssued: number; live: boolean };
export type MyBurns = { burns: { id: string; token: string; symbol: string; name: string; amount: number; txHash: string | null; at: number; status: string }[]; credits: number; total: number };

export type AskReason = { feature: string; label: string; value: string };
export type AskResult =
  | { ok: false; reason: string; name?: string; symbol?: string }
  | { ok: true; token: string; curve: string; name: string; symbol: string; ageMinutes: number; probability: number; threshold: number; sensitivity: string; verdict: "above" | "below"; scope: "inside" | "outside"; notes: string[]; up: AskReason[]; down: AskReason[]; price: number; trades: number; lastTradeSecondsAgo: number };

export type LiveToken = { address: string; name: string; symbol: string; recentTrades: number; ageMinutes: number };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const t = getToken();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  config: () => call<Config>("GET", "/api/config"),
  agents: () => call<{ agents: AgentView[] }>("GET", "/api/agents").then((r) => r.agents),
  create: (name: string) => call<AgentView>("POST", "/api/agents", { name }),
  remove: (id: string) => call<{ ok: true }>("DELETE", `/api/agents/${id}`),
  settings: (id: string, s: Partial<Settings>) => call<AgentView>("PUT", `/api/agents/${id}/settings`, s),
  check: (address: string) => call<Eligibility>("GET", `/api/tokens/check?address=${address}`),
  order: (id: string, token: string) => call<Order>("POST", `/api/agents/${id}/train`, { token }),
  claim: (orderId: string, txHash?: string) => call<Order>("POST", `/api/orders/${orderId}/claim`, { txHash }),
  test: (id: string) => call<{ queued: boolean; reason?: string }>("POST", `/api/agents/${id}/test`),
  burns: () => call<Burns>("GET", "/api/burns"),
  myBurns: () => call<MyBurns>("GET", "/api/me/burns"),
  credits: () => call<{ credits: number }>("GET", "/api/me/credits").then((r) => r.credits),
  liveTokens: () => call<{ tokens: LiveToken[] }>("GET", "/api/tokens/live").then((r) => r.tokens),
  ask: (id: string, token: string) => call<AskResult>("POST", `/api/agents/${id}/ask`, { token }),
  alerts: (id: string) => call<{ alerts: AlertView[] }>("GET", `/api/agents/${id}/alerts`).then((r) => r.alerts),
};
