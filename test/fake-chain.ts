import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Address, type Hex, type Log } from "viem";
import { BondingCurveAbi, CreatorBondAbi, FeePolicyAbi, FloorReserveAbi, LPLockerAbi, MAINNET, PinarcFactoryAbi, PinarcTokenAbi, RewardsDistributorAbi, VestingVaultAbi } from "@pinarc-labs/sdk";
import type { ChainClient, CurveParams, Readers, TokenInfo } from "../src/index.js";

type AbiLike = readonly unknown[];
const ABIS: Record<string, AbiLike> = { factory: PinarcFactoryAbi, curve: BondingCurveAbi, bond: CreatorBondAbi, floor: FloorReserveAbi, locker: LPLockerAbi, vault: VestingVaultAbi, token: PinarcTokenAbi, policy: FeePolicyAbi, rewards: RewardsDistributorAbi };

/** An in-memory chain: append logs block by block, then serve getLogs / getBlock / getBlockNumber like a node. */
export class FakeChain implements ChainClient {
  logs: Log[] = [];
  hashes = new Map<bigint, Hex>();
  head = 0n;
  private nonce = 0;
  constructor(public startTs = 1_789_574_400) {}

  hashOf(n: bigint): Hex { return this.hashes.get(n) ?? keccak256(toHex(`block-${n}`)); }
  tsOf(n: bigint) { return this.startTs + Number(n) * 2; }

  /** Emit an event at `block` from `address`. Non-indexed args are ABI-encoded from the event definition. */
  emit(block: bigint, source: keyof typeof ABIS, address: Address, eventName: string, args: Record<string, unknown>): Log {
    const abi = ABIS[source] as never;
    const ev = (ABIS[source] as { type: string; name?: string; inputs: { name: string; type: string; indexed: boolean }[] }[]).find((i) => i.type === "event" && i.name === eventName)!;
    const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
    const data = encodeAbiParameters(ev.inputs.filter((i) => !i.indexed), ev.inputs.filter((i) => !i.indexed).map((i) => args[i.name]));
    const log = { address, blockNumber: block, blockHash: this.hashOf(block), transactionHash: keccak256(toHex(`tx-${block}`)) /* one tx per block, like a real createToken */, transactionIndex: 0, logIndex: this.nonce++, removed: false, data, topics } as unknown as Log;
    this.logs.push(log);
    if (block > this.head) this.head = block;
    return log;
  }
  /** Simulate a reorg: replace the hash of every block ≥ `from` and drop its logs. */
  reorg(from: bigint) {
    this.logs = this.logs.filter((l) => (l.blockNumber ?? 0n) < from);
    for (let n = from; n <= this.head + 5n; n++) this.hashes.set(n, keccak256(toHex(`reorg-${n}-${Date.now()}`)));
  }
  async getBlockNumber() { return this.head; }
  async getBlock({ blockNumber }: { blockNumber: bigint }) { return { number: blockNumber, hash: this.hashOf(blockNumber), timestamp: BigInt(this.tsOf(blockNumber)) }; }
  async getLogs(args: { fromBlock: bigint; toBlock: bigint; address?: Address | Address[] }) {
    const addrs = args.address ? (Array.isArray(args.address) ? args.address : [args.address]).map((a) => a.toLowerCase()) : null;
    return this.logs.filter((l) => (l.blockNumber ?? 0n) >= args.fromBlock && (l.blockNumber ?? 0n) <= args.toBlock && (!addrs || addrs.includes(l.address.toLowerCase())));
  }
}

export const WAD = 10n ** 18n;
export const USDG = (n: number) => BigInt(Math.round(n * 1e6));
export const TOKEN = "0x00000000000000000000000000000000000a0001" as Address;
export const CURVE = "0x00000000000000000000000000000000000c0001" as Address;
export const CREATOR = "0x00000000000000000000000000000000000e0001" as Address;
export const ALICE = "0x00000000000000000000000000000000000e0002" as Address;
export const BOB = "0x00000000000000000000000000000000000e0003" as Address;
export const PAIR = "0x00000000000000000000000000000000000d0001" as Address;
export const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export const PARAMS: CurveParams = {
  virtualUsdg: USDG(4231.5), virtualTokens: 1_073_000_000n * WAD, curveSupply: 800_000_000n * WAD, lpSupply: 200_000_000n * WAD, graduationUsdg: USDG(12_400),
  tradeFeeBps: 100, creatorShareBps: 4000, graduationFeeBps: 200, antiSniperSeconds: 120, cooldownSeconds: 10, maxWallet: 10_000_000n * WAD, maxTx: 5_000_000n * WAD, maxBatchCommit: USDG(620),
};
export const INFO: TokenInfo = { name: "Robin", symbol: "ROBIN", metadataURI: "https://dapp.pinarc.io/api/v1/metadata/abc.json", totalSupply: 1_000_000_000n * WAD };
export const readers: Readers = { readCurveParams: async () => PARAMS, readTokenInfo: async () => INFO };

/** A full launch story on the fake chain, starting at MAINNET.startBlock. Returns the chain. */
export function launchStory(chain = new FakeChain()) {
  const b0 = MAINNET.startBlock + 10n;
  // real `createToken` log order: mint → Launched → bond Posted → dev-buy BatchCommitted → TokenCreated (last)
  chain.emit(b0, "token", TOKEN, "Transfer", { from: ZERO, to: CURVE, value: INFO.totalSupply });
  chain.emit(b0, "curve", CURVE, "Launched", { token: TOKEN, creator: CREATOR, batchEndsAt: BigInt(chain.tsOf(b0) + 30) });
  chain.emit(b0, "bond", MAINNET.creatorBond, "Posted", { token: TOKEN, creator: CREATOR, amount: USDG(500), lockSeconds: 2_592_000 });
  chain.emit(b0, "curve", CURVE, "BatchCommitted", { buyer: CREATOR, usdgIn: USDG(300), total: USDG(300) });
  chain.emit(b0, "factory", MAINNET.factory, "TokenCreated", { token: TOKEN, curve: CURVE, creator: CREATOR, floorBps: 1500, lpLockSeconds: 31_536_000, teamAllocation: 0n, bond: USDG(500), devBuyUsdg: USDG(300) });
  chain.emit(b0 + 2n, "curve", CURVE, "BatchCommitted", { buyer: ALICE, usdgIn: USDG(400), total: USDG(700) });
  chain.emit(b0 + 3n, "curve", CURVE, "BatchCommitted", { buyer: BOB, usdgIn: USDG(250), total: USDG(950) });
  // settle: 950 USDG, 1% fee = 9.5, used 940.5, tokens out (approx) 195M
  const tokensOut = 195_000_000n * WAD;
  chain.emit(b0 + 20n, "curve", CURVE, "BatchSettled", { usdgUsed: USDG(940.5), tokensOut, clearingPrice: (USDG(940.5) * 10n ** 30n) / tokensOut, refund: 0n });
  chain.emit(b0 + 21n, "curve", CURVE, "BatchClaimed", { buyer: ALICE, tokensOut: (tokensOut * 400n) / 950n, refund: 0n });
  chain.emit(b0 + 21n, "token", TOKEN, "Transfer", { from: CURVE, to: ALICE, value: (tokensOut * 400n) / 950n });
  // alice buys 100 USDG on the curve, bob sells half of nothing (he never claimed) — so alice sells some
  chain.emit(b0 + 40n, "policy", MAINNET.feePolicy!, "ReferrerBound", { trader: ALICE, referrer: BOB });
  chain.emit(b0 + 40n, "curve", CURVE, "Trade", { trader: ALICE, isBuy: true, usdgAmount: USDG(99), tokenAmount: 20_000_000n * WAD, price: 6_000_000_000_000n, fee: USDG(1) });
  chain.emit(b0 + 40n, "curve", CURVE, "ReferralPaid", { referrer: BOB, trader: ALICE, amount: USDG(0.2) });
  chain.emit(b0 + 40n, "token", TOKEN, "Transfer", { from: CURVE, to: ALICE, value: 20_000_000n * WAD });
  chain.emit(b0 + 60n, "curve", CURVE, "Trade", { trader: ALICE, isBuy: false, usdgAmount: USDG(49.5), tokenAmount: 10_000_000n * WAD, price: 5_900_000_000_000n, fee: USDG(0.5) });
  chain.emit(b0 + 60n, "token", TOKEN, "Transfer", { from: ALICE, to: CURVE, value: 10_000_000n * WAD });
  chain.emit(b0 + 61n, "token", TOKEN, "Transfer", { from: ALICE, to: BOB, value: 1_000_000n * WAD });
  return { chain, b0, tokensOut };
}

/** Graduation on top of the story. */
export function graduate(chain: FakeChain, at: bigint) {
  chain.emit(at, "curve", CURVE, "Graduated", { token: TOKEN, pair: PAIR, usdgLiquidity: USDG(10_292), tokenLiquidity: 200_000_000n * WAD, lpLockId: 1n, floorUsdg: USDG(1_860) });
  chain.emit(at, "floor", MAINNET.floorReserve, "Deposited", { token: TOKEN, from: CURVE, amount: USDG(1_860) });
  chain.emit(at, "locker", MAINNET.lpLocker, "Locked", { id: 1n, token: PAIR, owner: CREATOR, amount: 12345n, unlockAt: BigInt(chain.tsOf(at) + 31_536_000) });
  chain.emit(at, "token", TOKEN, "Transfer", { from: CURVE, to: PAIR, value: 200_000_000n * WAD });
}
