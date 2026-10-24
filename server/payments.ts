// Paying for a token (SPEC section 7). The user burns 100,000 platform tokens from their own wallet (a transfer to the dead address,
// which Kennel does not control), then hands us the transaction hash. We read that transaction from the chain and check it: a Transfer
// from the owner to the burn address, big enough, and never used for another order. Until the platform token exists (no PLATFORM_TOKEN), development mode settles orders without a transfer.
import { parseAbi } from "viem";
import { CFG } from "./config.ts";
import { client } from "./chain.ts";
import { SIG } from "./pons.ts";

const erc20 = parseAbi(["function decimals() view returns (uint8)"]);
let decimals = 18;

export async function initPayments() {
  if (!CFG.platformToken) return;
  try {
    decimals = Number(await client.readContract({ address: CFG.platformToken as `0x${string}`, abi: erc20, functionName: "decimals" }));
  } catch {
    console.warn("[payments] could not read the platform token's decimals, assuming 18");
  }
}

export const orderAmount = () => (BigInt(CFG.pricePerToken) * 10n ** BigInt(decimals)).toString();
export const tokenDecimals = () => decimals;

const pad = (a: string) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");

export async function verifyTransfer(owner: string, txHash: string, amount: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!CFG.platformToken) return { ok: false, error: "Payments are not configured yet." };
  const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => null);
  if (!receipt) return { ok: false, error: "That transaction is not on the chain yet. Wait a few seconds and try again." };
  if (receipt.status !== "success") return { ok: false, error: "That transaction failed on the chain." };
  const hit = receipt.logs.find(
    (l) => l.address.toLowerCase() === CFG.platformToken && l.topics[0] === SIG.transfer && l.topics[1]?.toLowerCase() === pad(owner) && l.topics[2]?.toLowerCase() === pad(CFG.burnAddress) && BigInt(l.data) >= BigInt(amount),
  );
  return hit ? { ok: true } : { ok: false, error: `No burn of ${CFG.pricePerToken.toLocaleString("en-US")} platform tokens from your wallet was found in that transaction.` };
}
