// Pons v2 on Robinhood Chain: the events we read and how to decode them without a heavy ABI decoder.
import { toEventSelector } from "viem";

export const SIG = {
  launched: toEventSelector("TokenLaunched(address,address,address,address,uint256,uint256)"),
  buy: toEventSelector("CurveBuy(address,address,uint256,uint256,uint256,uint256)"),
  sell: toEventSelector("CurveSell(address,address,uint256,uint256,uint256,uint256)"),
  transfer: toEventSelector("Transfer(address,address,uint256)"),
};

const addr = (topic: string) => "0x" + topic.slice(26).toLowerCase();
const word = (data: string, i: number) => data.slice(2 + i * 64, 2 + (i + 1) * 64);
const big = (data: string, i: number) => BigInt("0x" + word(data, i)).toString();

export type Launch = { token: string; curve: string; deployer: string; pairToken: string; configId: string; threshold: string };
export const decodeLaunch = (topics: string[], data: string): Launch => ({
  token: addr(topics[1]),
  curve: addr(topics[2]),
  deployer: addr(topics[3]),
  pairToken: "0x" + word(data, 0).slice(24).toLowerCase(),
  configId: big(data, 1),
  threshold: big(data, 2),
});

export type Trade = { side: 1 | 0; wallet: string; recipient: string; quote: string; tokens: string; fee: string; tax: string };
export function decodeTrade(topics: string[], data: string): Trade | null {
  const buy = topics[0] === SIG.buy;
  if (!buy && topics[0] !== SIG.sell) return null;
  return buy
    ? { side: 1, wallet: addr(topics[1]), recipient: addr(topics[2]), quote: big(data, 0), tokens: big(data, 1), fee: big(data, 2), tax: big(data, 3) }
    : { side: 0, wallet: addr(topics[1]), recipient: addr(topics[2]), quote: big(data, 1), tokens: big(data, 0), fee: big(data, 2), tax: big(data, 3) };
}

export const lowerAddr = (s: string) => s.toLowerCase();
