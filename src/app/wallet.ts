// Browser wallet connection. Wallets announce themselves (EIP-6963), the user picks one, and signs a one-time message.
// The server hands out a one-time message, the wallet signs it, and the server checks the signature and answers with a session token.
// Signing costs no gas and moves no funds.
import { useSyncExternalStore } from "react";

type Eth = {
  request: (a: { method: string; params?: unknown[] }) => Promise<any>;
  on?: (e: string, f: (...a: any[]) => void) => void;
};
export type Detected = { id: string; name: string; icon: string; provider: Eth };

const SESSION = "kennel:session";
const DAY = 24 * 3600_000;
const detected = new Map<string, Detected>();
let state = { account: "", providerId: "", busy: "", error: "", tick: 0 };
const SERVER = { account: "", providerId: "", busy: "", error: "", tick: 0 };
const subs = new Set<() => void>();
const emit = (patch: Partial<typeof state> = {}) => {
  state = { ...state, ...patch, tick: state.tick + 1 };
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

type Session = { address: string; providerId: string; expiresAt: number; token: string };
const read = (): Session | null => {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION) ?? "null");
    return s && typeof s.address === "string" && s.expiresAt > Date.now() ? s : null;
  } catch {
    return null;
  }
};
const write = (s: Session | null) => {
  try {
    s ? localStorage.setItem(SESSION, JSON.stringify(s)) : localStorage.removeItem(SESSION);
  } catch {
    /* storage can be blocked */
  }
};

const watched = new WeakSet<object>();
function watch(id: string, provider: Eth) {
  if (watched.has(provider)) return;
  watched.add(provider);
  provider.on?.("accountsChanged", (a: string[]) => {
    if (state.providerId !== id) return;
    if ((a[0]?.toLowerCase() ?? "") === state.account) return;
    // a different account has not signed in, so treat the wallet as signed out
    write(null);
    emit({ account: "", providerId: "" });
  });
}

function add(d: Detected) {
  if (detected.has(d.id)) return;
  detected.set(d.id, d);
  // restore a remembered session quietly if the wallet still has this account connected
  const s = read();
  if (s && s.providerId === d.id && !state.account) {
    d.provider
      .request({ method: "eth_accounts" })
      .then((a: string[]) => {
        if (a[0]?.toLowerCase() === s.address && !state.account) {
          watch(d.id, d.provider);
          emit({ account: s.address, providerId: d.id });
        }
      })
      .catch(() => {});
  }
  emit();
}

let started = false;
export function initWallets() {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("eip6963:announceProvider", ((e: CustomEvent) => {
    const { info, provider } = e.detail ?? {};
    if (info?.rdns && provider) add({ id: info.rdns, name: info.name, icon: info.icon, provider });
  }) as EventListener);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  // wallets that do not announce themselves
  setTimeout(() => {
    const legacy = (window as unknown as { ethereum?: Eth }).ethereum;
    if (legacy && detected.size === 0) add({ id: "injected", name: "Browser wallet", icon: "", provider: legacy });
  }, 400);
}

export function useWallet() {
  // the third argument is what the server (and the first hydration pass) sees: always signed out
  const s = useSyncExternalStore(subscribe, () => state, () => SERVER);
  return { account: s.account, busy: s.busy, error: s.error, wallets: Array.from(detected.values()), ready: s.tick >= 0 };
}

export async function connect(id: string) {
  const d = detected.get(id);
  if (!d) return emit({ error: "That wallet is no longer available." });
  emit({ busy: id, error: "" });
  try {
    const accounts: string[] = await d.provider.request({ method: "eth_requestAccounts" });
    if (!accounts[0]) throw new Error("No account was selected.");
    const account = accounts[0].toLowerCase();
    const ch = await fetch(`/api/auth/challenge?address=${account}`);
    const chBody = await ch.json().catch(() => ({}));
    if (!ch.ok) throw new Error(chBody.error ?? "Could not start sign in.");
    const signature: string = await d.provider.request({ method: "personal_sign", params: [chBody.message, account] });
    const v = await fetch("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account, signature }) });
    const vBody = await v.json().catch(() => ({}));
    if (!v.ok) throw new Error(vBody.error ?? "Sign in failed.");
    write({ address: account, providerId: id, expiresAt: vBody.expiresAt ?? Date.now() + 7 * DAY, token: vBody.token });
    watch(id, d.provider);
    emit({ account, providerId: id, busy: "", error: "" });
  } catch (e) {
    const err = e as { code?: number; message?: string; shortMessage?: string };
    const text = err?.code === 4001 || /reject|denied/i.test(err?.message ?? "") ? "You cancelled it in your wallet." : (err?.shortMessage ?? err?.message ?? "Could not connect.").split("\n")[0].slice(0, 200);
    emit({ busy: "", error: text });
  }
}

/** The session token for API calls, or empty when signed out. */
export const getToken = () => (state.account ? (read()?.token ?? "") : "");

export const activeProvider = (): Eth => {
  const p = detected.get(state.providerId)?.provider;
  if (!p) throw new Error("Connect a wallet first.");
  return p;
};

const CHAIN = { id: 4663, hex: "0x1237", name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robin.etherscan.io" };
/** Asks the wallet to switch to Robinhood Chain (and add it if it does not know it). Needed before paying. */
export async function ensureChain() {
  const e = activeProvider();
  const current = Number.parseInt(await e.request({ method: "eth_chainId" }), 16);
  if (current === CHAIN.id) return;
  try {
    await e.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.hex }] });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902 && code !== -32603) throw err;
    await e.request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: CHAIN.hex, chainName: CHAIN.name, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [CHAIN.rpc], blockExplorerUrls: [CHAIN.explorer] }],
    });
  }
}

export function disconnect() {
  write(null);
  emit({ account: "", providerId: "", error: "" });
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
