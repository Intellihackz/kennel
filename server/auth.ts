// Sign in with a wallet: the server hands out a one-time message, the wallet signs it, and the server answers with a stateless
// session token (address + expiry, HMAC signed). Nothing about sessions is stored.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { CFG } from "./config.ts";

const SECRET = CFG.sessionSecret || randomBytes(32).toString("hex"); // without SESSION_SECRET, sessions end when the server restarts
if (!CFG.sessionSecret) console.warn("[auth] SESSION_SECRET is not set: sessions will not survive a restart");
const NONCE_TTL = 5 * 60_000;
const SESSION_TTL = 7 * 24 * 3600_000;
const nonces = new Map<string, { message: string; exp: number }>();
const lower = (a: string) => a.toLowerCase();
export const isAddress = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

function sweep() {
  const now = Date.now();
  for (const [k, v] of nonces) if (v.exp < now) nonces.delete(k);
  if (nonces.size > 5000) nonces.clear();
}

export function createChallenge(address: string, host: string) {
  sweep();
  const a = lower(address);
  const message = [
    "Kennel wants you to sign in with your wallet.",
    "",
    "This proves the wallet is yours. It costs no gas and gives no permission to move funds.",
    "",
    `Address: ${a}`,
    `Domain: ${host}`,
    `Nonce: ${randomBytes(16).toString("hex")}`,
    `Issued at: ${new Date().toISOString()}`,
  ].join("\n");
  nonces.set(a, { message, exp: Date.now() + NONCE_TTL });
  return message;
}

const mac = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("hex");

export async function verifyChallenge(address: string, signature: string) {
  const a = lower(address);
  const ch = nonces.get(a);
  if (!ch || ch.exp < Date.now()) return null;
  let signer = "";
  try {
    signer = lower(await recoverMessageAddress({ message: ch.message, signature: signature as `0x${string}` }));
  } catch {
    return null;
  }
  if (signer !== a) return null;
  nonces.delete(a); // one use
  const exp = Date.now() + SESSION_TTL;
  const payload = `${a}.${exp}`;
  return { token: `${payload}.${mac(payload)}`, expiresAt: exp };
}

/** The signed-in address for an `Authorization: Bearer <token>` header, or null. */
export function sessionAddress(header: string | undefined | null): string | null {
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const [addr, exp, sig] = token.split(".");
  if (!addr || !exp || !sig || !/^0x[0-9a-f]{40}$/.test(addr) || Number(exp) < Date.now()) return null;
  const want = Buffer.from(mac(`${addr}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return addr;
}
