import type { Address, Hex, Log, PublicClient } from "viem";
import { getLogsChunked, type LogsClient } from "@pinarc-labs/robinhood-chain-kit";
import { MAINNET, allFactories, createPinarcClient, decodePinarcLogs, type PinarcAddresses } from "@pinarc-labs/sdk";
import type { Db } from "./db.js";
import { applyEvent, rebuild, toStored, type StoredEvent } from "./project.js";

/** What the indexer needs from a node; a viem PublicClient satisfies it. */
export interface ChainClient extends LogsClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint; hash: Hex; timestamp: bigint }>;
}

export type CurveParams = {
  virtualUsdg: bigint; virtualTokens: bigint; curveSupply: bigint; lpSupply: bigint; graduationUsdg: bigint;
  tradeFeeBps: number; creatorShareBps: number; graduationFeeBps: number; antiSniperSeconds: number; cooldownSeconds: number;
  maxWallet: bigint; maxTx: bigint; maxBatchCommit: bigint;
};
export type TokenInfo = { name: string; symbol: string; metadataURI: string; totalSupply: bigint };

export type Readers = {
  /** Curve constants (virtual reserves, supplies, fees, guards). Read once per launch. */
  readCurveParams: (curve: Address) => Promise<CurveParams | null>;
  /** name / symbol / metadataURI / totalSupply of a launched token. */
  readTokenInfo: (token: Address) => Promise<TokenInfo | null>;
};

export type SyncOptions = {
  client: ChainClient;
  db: Db;
  addresses?: PinarcAddresses;
  readers?: Readers;
  /** Blocks per eth_getLogs request to start from (default 2000; shrinks automatically). */
  chunkSize?: bigint;
  /** Cap on blocks per `sync()` call (default 50,000) so a fresh index makes visible progress. */
  maxBlocksPerRun?: bigint;
  /** Stay this many blocks behind the head (default 0; Robinhood Chain finality is fast). */
  confirmations?: bigint;
  /** How far back a reorg can be repaired (default 128 blocks). */
  reorgDepth?: number;
  /** Parallel getBlock calls for timestamps (default 8). */
  blockConcurrency?: number;
  log?: (line: string) => void;
};

export type SyncResult = { fromBlock: bigint; toBlock: bigint; head: bigint; events: number; newTokens: number; reorgedFrom?: bigint; done: boolean };

/** Readers backed by the SDK client (one multicall per curve / token). */
export function chainReaders(publicClient: PublicClient, addresses: PinarcAddresses = MAINNET): Readers {
  const pinarc = createPinarcClient({ publicClient, addresses });
  return {
    async readCurveParams(curve) {
      try {
        const s = await pinarc.readCurve(curve);
        return { virtualUsdg: s.virtualUsdg, virtualTokens: s.virtualTokens, curveSupply: s.curveSupply, lpSupply: s.lpSupply, graduationUsdg: s.graduationUsdg, tradeFeeBps: Number(s.tradeFeeBps), creatorShareBps: s.creatorShareBps, graduationFeeBps: s.graduationFeeBps, antiSniperSeconds: s.antiSniperSeconds, cooldownSeconds: s.cooldownSeconds, maxWallet: s.maxWallet, maxTx: s.maxTx, maxBatchCommit: s.maxBatchCommit };
      } catch { return null; }
    },
    async readTokenInfo(token) {
      try {
        const t = await pinarc.getTokenInfo(token);
        return { name: t.name, symbol: t.symbol, metadataURI: t.metadataURI, totalSupply: t.totalSupply };
      } catch { return null; }
    },
  };
}

const lc = (a: string) => a.toLowerCase();

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]!); }
  }));
  return out;
}

/** Walk back through stored block hashes until one still matches the chain; returns the block to resume after. */
export async function findReorgBase(client: ChainClient, db: Db, lastBlock: bigint, depth: number): Promise<bigint | null> {
  const stored = db.all<{ number: number; hash: string }>("SELECT number, hash FROM blocks WHERE number <= ? ORDER BY number DESC LIMIT ?", Number(lastBlock), depth);
  for (const b of stored) {
    const chain = await client.getBlock({ blockNumber: BigInt(b.number) });
    if (chain.hash.toLowerCase() === b.hash.toLowerCase()) return BigInt(b.number);
  }
  return null;
}

/** Delete everything above `base` and replay the audit log. */
export function rewindTo(db: Db, base: bigint) {
  db.transaction(() => {
    db.run("DELETE FROM events WHERE block > ?", Number(base));
    db.run("DELETE FROM blocks WHERE number > ?", Number(base));
    db.setState("last_block", base);
  });
  rebuild(db);
}

/**
 * One indexing pass: reorg check, discover launches from the factory, fetch every protocol log for the known
 * contracts, decode, store in `events` (exactly once) and project the new ones. Call repeatedly (`done` says
 * whether the head was reached).
 */
export async function sync(opts: SyncOptions): Promise<SyncResult> {
  const { client, db, addresses = MAINNET, chunkSize = 2000n, maxBlocksPerRun = 50_000n, confirmations = 0n, reorgDepth = 128, blockConcurrency = 8, log = () => {} } = opts;
  const readers = opts.readers ?? { readCurveParams: async () => null, readTokenInfo: async () => null };
  const headRaw = await client.getBlockNumber();
  const head = headRaw - confirmations;

  let fromBlock = addresses.startBlock;
  let reorgedFrom: bigint | undefined;
  const last = db.getState("last_block");
  if (last !== undefined) {
    const lastBlock = BigInt(last);
    const lastHash = db.getState("last_hash");
    if (lastHash) {
      const chainBlock = await client.getBlock({ blockNumber: lastBlock });
      if (chainBlock.hash.toLowerCase() !== lastHash.toLowerCase()) {
        const base = await findReorgBase(client, db, lastBlock, reorgDepth);
        if (base === null) throw new Error(`reorg deeper than ${reorgDepth} blocks; delete the database and re-index`);
        log(`reorg detected at ${lastBlock}, rewinding to ${base}`);
        rewindTo(db, base);
        reorgedFrom = lastBlock;
        fromBlock = base + 1n;
      } else fromBlock = lastBlock + 1n;
    } else fromBlock = lastBlock + 1n;
  }
  if (fromBlock > head) return { fromBlock, toBlock: head, head, events: 0, newTokens: 0, reorgedFrom, done: true };
  const toBlock = fromBlock + maxBlocksPerRun - 1n < head ? fromBlock + maxBlocksPerRun - 1n : head;

  // 1. launches in this range (every factory of the deployment: v2 and, on mainnet, the v1 one it replaced)
  const factories = allFactories(addresses);
  const factoryLogs = await getLogsChunked(client, { address: factories, fromBlock, toBlock, chunkSize });
  const created = decodePinarcLogs(factoryLogs, { factory: factories[0] }).filter((e) => e.name === "TokenCreated" && factories.some((f) => f.toLowerCase() === e.address.toLowerCase()));
  const knownTokens = db.all<{ address: string; curve: string }>("SELECT address, curve FROM tokens");
  const tokens = new Set(knownTokens.map((k) => k.address)), curves = new Set(knownTokens.map((k) => k.curve));
  for (const e of created) { tokens.add(lc(String(e.args.token))); curves.add(lc(String(e.args.curve))); }

  // 2. everything else: curves, tokens and the singleton contracts
  const singletons = [addresses.creatorBond, addresses.creatorBondV1, addresses.floorReserve, addresses.lpLocker, addresses.vestingVault, addresses.feePolicy, addresses.rewardsDistributor].filter((a): a is Address => !!a);
  const watch = [...curves, ...tokens, ...singletons].map((a) => a as Address);
  const otherLogs = watch.length ? await getLogsChunked(client, { address: watch, fromBlock, toBlock, chunkSize, onChunk: (c) => log(`logs ${c.fromBlock}-${c.toBlock}: ${c.logs}`) }) : [];
  const logs: Log[] = [...factoryLogs, ...otherLogs];
  const known = { factory: factories[0], bond: addresses.creatorBond, floor: addresses.floorReserve, locker: addresses.lpLocker, vault: addresses.vestingVault, policy: addresses.feePolicy, rewards: addresses.rewardsDistributor };
  const decoded = decodePinarcLogs(logs, known)
    // only Transfer/Metadata logs of *our* tokens count as `token` events (the watch list guarantees that, but keep it explicit)
    .filter((e) => e.source !== "token" || tokens.has(lc(e.address)));

  // 3. timestamps + hashes for every block that had events, and for the range end (reorg anchor)
  const blockNumbers = [...new Set(decoded.map((e) => e.blockNumber))];
  if (!blockNumbers.includes(toBlock)) blockNumbers.push(toBlock);
  const blocks = await mapLimit(blockNumbers, blockConcurrency, (n) => client.getBlock({ blockNumber: n }));
  const tsOf = new Map(blocks.map((b) => [b.number, Number(b.timestamp)]));
  const endBlock = blocks.find((b) => b.number === toBlock)!;

  // 4. chain reads for new launches (before applying, so TokenCreated can use them)
  const enrich = await mapLimit(created, blockConcurrency, async (e) => {
    const token = lc(String(e.args.token)) as Address, curve = lc(String(e.args.curve)) as Address;
    const [params, info] = await Promise.all([readers.readCurveParams(curve), readers.readTokenInfo(token)]);
    return { token, curve, params, info };
  });

  // 5. store + project, in one transaction
  let inserted = 0;
  db.transaction(() => {
    for (const r of enrich) {
      if (r.info) db.run("INSERT OR REPLACE INTO token_meta (token, name, symbol, metadata_uri, total_supply) VALUES (?, ?, ?, ?, ?)", r.token, r.info.name, r.info.symbol, r.info.metadataURI, r.info.totalSupply.toString());
      if (r.params) db.run(
        `INSERT OR REPLACE INTO curve_params (token, curve, virtual_usdg, virtual_tokens, curve_supply, lp_supply, graduation_usdg, trade_fee_bps, creator_share_bps, graduation_fee_bps, anti_sniper_seconds, cooldown_seconds, max_wallet, max_tx, max_batch_commit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        r.token, r.curve, r.params.virtualUsdg.toString(), r.params.virtualTokens.toString(), r.params.curveSupply.toString(), r.params.lpSupply.toString(), r.params.graduationUsdg.toString(), r.params.tradeFeeBps, r.params.creatorShareBps, r.params.graduationFeeBps, r.params.antiSniperSeconds, r.params.cooldownSeconds, r.params.maxWallet.toString(), r.params.maxTx.toString(), r.params.maxBatchCommit.toString(),
      );
    }
    for (const b of blocks) db.run("INSERT OR REPLACE INTO blocks (number, hash, ts) VALUES (?, ?, ?)", Number(b.number), b.hash, Number(b.timestamp));
    const fresh: StoredEvent[] = [];
    for (const e of decoded) {
      const row = toStored(e, tsOf.get(e.blockNumber) ?? 0);
      const res = db.run("INSERT OR IGNORE INTO events (tx_hash, log_index, block, ts, address, source, name, args) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", row.tx_hash, row.log_index, row.block, row.ts, row.address, row.source, row.name, row.args);
      if (Number(res.changes) > 0) fresh.push(row);
    }
    fresh.sort((a, b) => a.block - b.block || a.log_index - b.log_index);
    for (const row of fresh) applyEvent(db, row);
    inserted = fresh.length;
    db.setState("last_block", toBlock);
    db.setState("last_hash", endBlock.hash);
    db.setState("synced_at", Math.floor(Date.now() / 1000));
    // keep the reorg window small
    db.run("DELETE FROM blocks WHERE number < ? AND number NOT IN (SELECT DISTINCT block FROM events)", Number(toBlock) - reorgDepth * 4);
  });
  log(`synced ${fromBlock}-${toBlock} (head ${head}): ${inserted} new events, ${created.length} launches`);
  return { fromBlock, toBlock, head, events: inserted, newTokens: created.length, reorgedFrom, done: toBlock === head };
}

/** Run `sync()` until the head is reached. */
export async function syncToHead(opts: SyncOptions): Promise<SyncResult> {
  let res: SyncResult;
  do res = await sync(opts); while (!res.done);
  return res;
}
