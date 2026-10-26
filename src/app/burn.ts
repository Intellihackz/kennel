// Burning platform tokens to pay for a token. The browser builds one SPL "burn checked" instruction, the wallet signs and sends it,
// and the signature goes back to the server, which reads the transaction from the chain and checks it.
import { getToken, activeProvider } from "./wallet";

const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export async function burnPlatformTokens(o: { owner: string; mint: string; tokenProgram: string; amount: string; decimals: number }): Promise<string> {
  const { PublicKey, Transaction, TransactionInstruction } = await import("@solana/web3.js");
  const owner = new PublicKey(o.owner);
  const mint = new PublicKey(o.mint);
  const program = new PublicKey(o.tokenProgram);
  // the owner's own token account for this mint (its associated token account)
  const [account] = PublicKey.findProgramAddressSync([owner.toBytes(), program.toBytes(), mint.toBytes()], new PublicKey(ATA_PROGRAM));
  const data = new Uint8Array(10);
  data[0] = 15; // BurnChecked
  new DataView(data.buffer).setBigUint64(1, BigInt(o.amount), true);
  data[9] = o.decimals;
  const ix = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: data as unknown as Buffer,
  });
  const bh = await fetch("/api/solana/blockhash", { headers: { authorization: `Bearer ${getToken()}` } });
  const b = await bh.json().catch(() => ({}));
  if (!bh.ok) throw new Error(b.error ?? "Could not prepare the transaction.");
  const tx = new Transaction({ feePayer: owner, recentBlockhash: b.blockhash }).add(ix);
  const send = activeProvider().signAndSendTransaction;
  if (!send) throw new Error("This wallet cannot send transactions from a web page.");
  const r = await send.call(activeProvider(), tx);
  return typeof r === "string" ? r : r.signature;
}
