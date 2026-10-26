// Sign in with a wallet: the server hands out a one-time message, the wallet signs it, and the server answers with a stateless
// session token (address + expiry, HMAC signed). Nothing about sessions is stored.
import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import bs58 from "bs58";
import { CFG } from "./config.ts";
import { isSolAddress } from "./solana.ts";

const SECRET = CFG.sessionSecret || randomBytes(32).toString("hex"); // without SESSION_SECRET, sessions end when the server restarts
if (!CFG.sessionSecret) console.warn("[auth] SESSION_SECRET is not set: sessions will not survive a restart");
const NONCE_TTL = 5 * 60_000;
const SESSION_TTL = 7 * 24 * 3600_000;
const nonces = new Map<string, { message: string; exp: number }>();
// A Solana address is an ed25519 public key written in base58. It is case-sensitive, so addresses are never lower-cased.
export const isAddress = isSolAddress;
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex"); // the DER prefix that wraps a raw 32 byte ed25519 key

function sweep() {
  const now = Date.now();
  for (const [k, v] of nonces) if (v.exp < now) nonces.delete(k);
  if (nonces.size > 5000) nonces.clear();
}

export function createChallenge(address: string, host: string) {
  sweep();
  const a = address;
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

/** The wallet signs the message bytes (signMessage) and sends the 64 byte signature in base58. */
export function verifyChallenge(address: string, signature: string) {
  const a = address;
  const ch = nonces.get(a);
  if (!ch || ch.exp < Date.now()) return null;
  try {
    const sig = bs58.decode(signature);
    if (sig.length !== 64) return null;
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, bs58.decode(a)]), format: "der", type: "spki" });
    if (!verify(null, Buffer.from(ch.message, "utf8"), key, Buffer.from(sig))) return null;
  } catch {
    return null;
  }
  nonces.delete(a); // one use
  const exp = Date.now() + SESSION_TTL;
  const payload = `${a}.${exp}`;
  return { token: `${payload}.${mac(payload)}`, expiresAt: exp };
}

/** The signed-in address for an `Authorization: Bearer <token>` header, or null. */
export function sessionAddress(header: string | undefined | null): string | null {
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const [addr, exp, sig] = token.split(".");
  if (!addr || !exp || !sig || !isSolAddress(addr) || Number(exp) < Date.now()) return null;
  const want = Buffer.from(mac(`${addr}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return addr;
}
