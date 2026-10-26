// Paying for a token (SPEC section 7). The user burns 100,000 platform tokens from their own wallet (an SPL burn instruction, which
// destroys the tokens and which Kennel does not control), then hands us the transaction signature. We read that transaction from the
// chain and check it: a burn of the platform token, signed by the owner, big enough, and never used for another order. Until the
// platform token exists (no PLATFORM_TOKEN), development mode settles orders without a burn.
import { CFG } from "./config.ts";
import { getAccount, rpc } from "./solana.ts";

let decimals = 6;
let program = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

export async function initPayments() {
  if (!CFG.platformToken) return;
  try {
    const acc = await getAccount(CFG.platformToken);
    if (!acc || !TOKEN_PROGRAMS.has(acc.owner)) throw new Error("PLATFORM_TOKEN is not a token mint");
    program = acc.owner;
    decimals = Number((await rpc<{ value: { decimals: number } }>("getTokenSupply", [CFG.platformToken])).value.decimals);
  } catch (e) {
    console.warn("[payments] could not read the platform token:", (e as Error).message, `(assuming ${decimals} decimals)`);
  }
}

export const orderAmount = () => (BigInt(CFG.pricePerToken) * 10n ** BigInt(decimals)).toString();
export const tokenDecimals = () => decimals;
/** The token program that owns the platform token's mint: the wallet needs it to build the burn instruction. */
export const tokenProgram = () => program;

type Ix = { program?: string; programId?: string; parsed?: { type?: string; info?: Record<string, any> } };

export async function verifyBurn(owner: string, signature: string, amount: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!CFG.platformToken) return { ok: false, error: "Payments are not configured yet." };
  const tx = await rpc<any>("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]).catch(() => null);
  if (!tx) return { ok: false, error: "That transaction is not on the chain yet. Wait a few seconds and try again." };
  if (tx.meta?.err) return { ok: false, error: "That transaction failed on the chain." };
  const ixs: Ix[] = [...(tx.transaction?.message?.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((i: { instructions: Ix[] }) => i.instructions)];
  const need = BigInt(amount);
  const hit = ixs.some((ix) => {
    const info = ix.parsed?.info;
    if (!info || !TOKEN_PROGRAMS.has(ix.programId ?? "")) return false;
    if (ix.parsed?.type !== "burn" && ix.parsed?.type !== "burnChecked") return false;
    if (info.mint !== CFG.platformToken || info.authority !== owner) return false;
    const got = BigInt(ix.parsed.type === "burnChecked" ? info.tokenAmount?.amount ?? "0" : info.amount ?? "0");
    return got >= need;
  });
  return hit ? { ok: true } : { ok: false, error: `No burn of ${CFG.pricePerToken.toLocaleString("en-US")} platform tokens from your wallet was found in that transaction.` };
}
