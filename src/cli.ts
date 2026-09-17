#!/usr/bin/env node
import { createPublicClient } from "viem";
import { createFallbackTransport, parseRpcList, robinhoodChain } from "@pinarc-labs/robinhood-chain-kit";
import { MAINNET, addressesFrom } from "@pinarc-labs/sdk";
import { Db } from "./db.js";
import { rebuild } from "./project.js";
import { createApiServer, queries } from "./serve.js";
import { chainReaders, sync } from "./sync.js";

const HELP = `pinarc-indexer — reference indexer for Pinarc on Robinhood Chain

  pinarc-indexer sync    [--db pinarc.db] [--rpc url,url] [--from N] [--chunk 2000] [--follow [--interval 15]]
  pinarc-indexer stats   [--db pinarc.db]
  pinarc-indexer rebuild [--db pinarc.db]          replay the audit log into the projection tables
  pinarc-indexer serve   [--db pinarc.db] [--port 8787]

Env: PINARC_RPC (comma list), PINARC_DB, PINARC_FACTORY/CONFIG/BOND/FLOOR/LOCKER/VAULT/START_BLOCK to index a fork.`;

function args(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { out[a.slice(2)] = next; i++; } else out[a.slice(2)] = true;
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
const opt = args(rest);
const dbPath = String(opt.db ?? process.env.PINARC_DB ?? "pinarc.db");
const addresses = addressesFrom({
  factory: process.env.PINARC_FACTORY, config: process.env.PINARC_CONFIG, creatorBond: process.env.PINARC_BOND, floorReserve: process.env.PINARC_FLOOR,
  lpLocker: process.env.PINARC_LOCKER, vestingVault: process.env.PINARC_VAULT, startBlock: opt.from ? String(opt.from) : process.env.PINARC_START_BLOCK,
}, MAINNET);

async function main() {
  switch (cmd) {
    case "sync": {
      const db = new Db(dbPath);
      const urls = parseRpcList(typeof opt.rpc === "string" ? opt.rpc : process.env.PINARC_RPC);
      const publicClient = createPublicClient({ chain: robinhoodChain, transport: createFallbackTransport(urls) });
      const readers = chainReaders(publicClient, addresses);
      const chunkSize = BigInt(String(opt.chunk ?? 2000));
      const interval = Number(opt.interval ?? 15) * 1000;
      for (;;) {
        let res;
        do {
          res = await sync({ client: publicClient, db, addresses, readers, chunkSize, log: (l) => console.error(l) });
        } while (!res.done);
        if (!opt.follow) break;
        await new Promise((r) => setTimeout(r, interval));
      }
      console.log(JSON.stringify(queries(db).stats()));
      db.close();
      return;
    }
    case "stats": {
      const db = new Db(dbPath);
      console.log(JSON.stringify(queries(db).stats(), null, 2));
      db.close();
      return;
    }
    case "rebuild": {
      const db = new Db(dbPath);
      rebuild(db);
      console.log(JSON.stringify(queries(db).stats(), null, 2));
      db.close();
      return;
    }
    case "serve": {
      const db = new Db(dbPath);
      const port = Number(opt.port ?? 8787);
      createApiServer(db).listen(port, () => console.error(`pinarc-indexer api on http://localhost:${port} (${dbPath})`));
      return;
    }
    default:
      console.log(HELP);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
