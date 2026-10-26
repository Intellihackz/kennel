// Browser wallet connection. The page finds the Solana wallets installed in the browser, the user picks one, and signs a one-time message.
// The server hands out a one-time message, the wallet signs it, and the server checks the signature and answers with a session token.
// Signing costs no gas and moves no funds.
import { useSyncExternalStore } from "react";

// Solana wallets inject a provider into the page. Phantom, Solflare and Backpack share the same small surface.
export type SolProvider = {
  connect: (o?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey?: { toString(): string } } | void>;
  disconnect?: () => Promise<void>;
  signMessage: (m: Uint8Array, display?: string) => Promise<{ signature: Uint8Array } | Uint8Array>;
  signAndSendTransaction?: (tx: unknown) => Promise<{ signature: string } | string>;
  publicKey?: { toString(): string } | null;
  on?: (e: string, f: (...a: any[]) => void) => void;
};
export type Detected = { id: string; name: string; icon: string; provider: SolProvider };

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
function watch(id: string, provider: SolProvider) {
  if (watched.has(provider)) return;
  watched.add(provider);
  const out = () => {
    if (state.providerId !== id) return;
    write(null);
    emit({ account: "", providerId: "" });
  };
  provider.on?.("disconnect", out);
  // a different account has not signed in, so treat the wallet as signed out
  provider.on?.("accountChanged", (k: { toString(): string } | null) => {
    if (state.providerId === id && k?.toString() !== state.account) out();
  });
}

function add(d: Detected) {
  if (detected.has(d.id)) return;
  detected.set(d.id, d);
  // restore a remembered session quietly if the wallet still trusts this site
  const s = read();
  if (s && s.providerId === d.id && !state.account) {
    d.provider
      .connect({ onlyIfTrusted: true })
      .then((r) => {
        const k = (r && "publicKey" in r ? r.publicKey : d.provider.publicKey)?.toString();
        if (k === s.address && !state.account) {
          watch(d.id, d.provider);
          emit({ account: s.address, providerId: d.id });
        }
      })
      .catch(() => {});
  }
  emit();
}

type Injected = { phantom?: { solana?: SolProvider & { isPhantom?: boolean } }; solflare?: SolProvider & { isSolflare?: boolean }; backpack?: SolProvider; solana?: SolProvider };
function scan() {
  const w = window as unknown as Injected;
  if (w.phantom?.solana) add({ id: "phantom", name: "Phantom", icon: "", provider: w.phantom.solana });
  if (w.solflare?.isSolflare) add({ id: "solflare", name: "Solflare", icon: "", provider: w.solflare });
  if (w.backpack) add({ id: "backpack", name: "Backpack", icon: "", provider: w.backpack });
  if (w.solana && detected.size === 0) add({ id: "injected", name: "Browser wallet", icon: "", provider: w.solana });
}

let started = false;
export function initWallets() {
  if (started || typeof window === "undefined") return;
  started = true;
  scan();
  // wallets inject themselves a little after the page loads
  setTimeout(scan, 300);
  setTimeout(scan, 1500);
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
    const r = await d.provider.connect();
    const account = ((r && "publicKey" in r ? r.publicKey : null) ?? d.provider.publicKey)?.toString();
    if (!account) throw new Error("No account was selected.");
    const ch = await fetch(`/api/auth/challenge?address=${account}`);
    const chBody = await ch.json().catch(() => ({}));
    if (!ch.ok) throw new Error(chBody.error ?? "Could not start sign in.");
    const signed = await d.provider.signMessage(new TextEncoder().encode(chBody.message), "utf8");
    const bytes = signed instanceof Uint8Array ? signed : signed.signature;
    const { default: bs58 } = await import("bs58");
    const v = await fetch("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account, signature: bs58.encode(bytes) }) });
    const vBody = await v.json().catch(() => ({}));
    if (!v.ok) throw new Error(vBody.error ?? "Sign in failed.");
    write({ address: account, providerId: id, expiresAt: vBody.expiresAt ?? Date.now() + 7 * DAY, token: vBody.token });
    watch(id, d.provider);
    emit({ account, providerId: id, busy: "", error: "" });
  } catch (e) {
    const err = e as { code?: number; message?: string };
    const text = err?.code === 4001 || /reject|denied|cancel/i.test(err?.message ?? "") ? "You cancelled it in your wallet." : (err?.message ?? "Could not connect.").split("\n")[0].slice(0, 200);
    emit({ busy: "", error: text });
  }
}

/** The session token for API calls, or empty when signed out. */
export const getToken = () => (state.account ? (read()?.token ?? "") : "");

export const activeProvider = (): SolProvider => {
  const p = detected.get(state.providerId)?.provider;
  if (!p) throw new Error("Connect a wallet first.");
  return p;
};

export function disconnect() {
  try {
    void activeProvider().disconnect?.();
  } catch {
    /* no wallet to disconnect */
  }
  write(null);
  emit({ account: "", providerId: "", error: "" });
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
