# pinarc-indexer

The reference indexer for [Pinarc](https://pinarc.io) on Robinhood Chain. It replays every protocol event from the chain into a local SQLite database and serves the same read model the app shows — so anyone can verify Pinarc's numbers on their own machine, without trusting `dapp.pinarc.io`.

- **Audit log first.** Every decoded event lands in `events` exactly once (`PRIMARY KEY (tx_hash, log_index)`). Every other table is a projection of that log; `pinarc-indexer rebuild` replays it from scratch.
- **Exact integers.** USDG and token amounts are stored as decimal strings; nothing is rounded to floats until a candle is drawn.
- **Reorg-safe.** Block hashes are kept for the last 128 blocks; on a mismatch the indexer rewinds to the last matching block, drops what came after and re-projects.
- **Rate-limit-aware.** Uses the `eth_getLogs` chunker from [`robinhood-chain-kit`](https://github.com/pinarc-labs/robinhood-chain-kit) (halves the block window on 429 / range errors) and its ranked fallback transport.
- **Zero native deps.** `node:sqlite` (Node ≥ 24), viem, and the two Pinarc packages.

## Run it

```sh
git clone https://github.com/pinarc-labs/robinhood-chain-kit ../robinhood-chain-kit && (cd ../robinhood-chain-kit && pnpm install && pnpm build)
git clone https://github.com/pinarc-labs/pinarc-sdk ../pinarc-sdk && (cd ../pinarc-sdk && pnpm install && pnpm build)
pnpm install && pnpm build

# index mainnet from the deploy block (65,381,613) to the head, then keep following
node bin/pinarc-indexer.js sync --db pinarc.db --follow

# numbers
node bin/pinarc-indexer.js stats --db pinarc.db
# {"tokens":…,"live":…,"graduated":…,"events":…,"trades":…,"volume_usdg":"…","last_block":65480556,"synced_at":…}

# JSON API on :8787
node bin/pinarc-indexer.js serve --db pinarc.db
```

Options: `--rpc url,url` (default: the ranked public list), `--from N`, `--chunk 2000`, `--interval 15` (seconds between passes with `--follow`). Set `PINARC_FACTORY/CONFIG/BOND/FLOOR/LOCKER/VAULT/START_BLOCK` to index a fork or another deployment.

## What gets indexed

| Source | Events | Projection |
|---|---|---|
| `PinarcFactory` | `TokenCreated` | `tokens` (creator choices: floor share, LP lock, team allocation, bond, disclosed dev buy) + one-time chain reads into `curve_params` and `token_meta` |
| `BondingCurve` (per launch) | `Launched`, `BatchCommitted`, `BatchSettled`, `BatchClaimed`, `Trade`, `Graduated` | `batch_commits`, `batch_claims`, `trades` (venue `batch` or `curve`), live `usdg_raised` / `tokens_sold` / `price18` / status, pair + LP lock at graduation |
| `PinarcToken` (per launch) | `Transfer`, `MetadataUpdated` | `balances` (every holder incl. curve, pair, vault), metadata URI |
| `CreatorBond` | `Posted`, `Released`, `Slashed` | `bonds`, `tokens.bond_status` |
| `FloorReserve` | `Deposited`, `Redeemed` | `floors`, `tokens.floor_usdg` |
| `LPLocker` | `Locked`, `Extended`, `Withdrawn`, `LockTransferred` | `locks` (linked to the launch whose pair or token is locked) |
| `VestingVault` | `ScheduleCreated`, `Released` | `vesting`, `tokens.team_vesting_id` |

Price after a curve trade is the `price` the contract emits; after a batch settlement it is recomputed with the SDK's `price18()` from the stored virtual reserves — the same integer maths as the contract.

## API

| Route | Returns |
|---|---|
| `GET /health` | `{ ok, last_block, synced_at }` |
| `GET /stats` | counts + total volume |
| `GET /tokens?status=live&sort=volume&limit=100` | token rows (`sort`: `created` `volume` `trades` `last_trade`) |
| `GET /tokens/:address` | token + params + bond + floor + locks + vesting + latest 30 trades + top 50 holders |
| `GET /tokens/:address/trades?limit=50` | trades, newest first |
| `GET /tokens/:address/holders?limit=50` | balances excluding the curve, pair, zero and dead addresses |
| `GET /tokens/:address/candles?tf=5m&limit=300` | OHLCV (`1m 5m 15m 1h 4h 1d`), gaps filled flat |
| `GET /events?address=&name=&limit=` | the audit log, decoded |
| `GET /locks?owner=` · `GET /vesting?beneficiary=` | locker / vault rows |

## As a library

```ts
import { createPublicClient } from "viem";
import { createFallbackTransport, robinhoodChain } from "@pinarc-labs/robinhood-chain-kit";
import { MAINNET } from "@pinarc-labs/sdk";
import { Db, chainReaders, syncToHead, queries } from "@pinarc-labs/indexer";

const publicClient = createPublicClient({ chain: robinhoodChain, transport: createFallbackTransport() });
const db = new Db("pinarc.db");
await syncToHead({ client: publicClient, db, addresses: MAINNET, readers: chainReaders(publicClient), log: console.error });
console.log(queries(db).stats());
```

`sync()` takes any object with `getLogs`, `getBlock` and `getBlockNumber` — the tests drive it with an in-memory fake chain (`test/fake-chain.ts`) through a full launch, a graduation, a duplicate pass and a reorg.

## Development

```sh
pnpm test        # 7 end-to-end tests on a fake chain, no network
pnpm typecheck
pnpm build
```

## License

MIT © Pinarc Labs
