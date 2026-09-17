import { describe, expect, it } from "vitest";
import { MAINNET } from "@pinarc-labs/sdk";
import { Db, candlesFromTrades, queries, rebuild, sync, syncToHead } from "../src/index.js";
import { ALICE, BOB, CREATOR, CURVE, FakeChain, PAIR, TOKEN, USDG, WAD, graduate, launchStory, readers } from "./fake-chain.js";

const snapshot = (db: Db) => ({
  tokens: db.all("SELECT * FROM tokens ORDER BY address"),
  trades: db.all("SELECT * FROM trades ORDER BY block, log_index"),
  balances: db.all("SELECT * FROM balances ORDER BY wallet"),
  locks: db.all("SELECT * FROM locks ORDER BY id"),
  floors: db.all("SELECT * FROM floors"),
  bonds: db.all("SELECT * FROM bonds"),
  events: db.get("SELECT COUNT(*) n FROM events"),
});

describe("sync", () => {
  it("indexes a launch end to end", async () => {
    const { chain, b0, tokensOut } = launchStory();
    chain.head = b0 + 100n;
    const db = new Db();
    const res = await syncToHead({ client: chain, db, readers, chunkSize: 25n, maxBlocksPerRun: 40n });
    expect(res.done).toBe(true);
    expect(res.toBlock).toBe(chain.head);
    const q = queries(db);
    const t = q.token(TOKEN)!;
    expect(t.token).toMatchObject({ address: TOKEN, curve: CURVE, creator: CREATOR, name: "Robin", symbol: "ROBIN", status: "live", floor_bps: 1500, bond: USDG(500).toString(), dev_buy_usdg: USDG(300).toString(), bond_status: "active", batch_settled: 1, batch_usdg: USDG(950).toString(), batch_tokens_out: tokensOut.toString(), trades: 3 });
    // raised: 940.5 (batch) + 99 (buy) − 50 (sell gross = 49.5 + 0.5) = 989.5; sold: 195M + 20M − 10M = 205M
    expect(t.token.usdg_raised).toBe(USDG(989.5).toString());
    expect(t.token.tokens_sold).toBe((205_000_000n * WAD).toString());
    expect(t.token.price18).toBe("5900000000000"); // last Trade event price
    expect(t.token.volume_usdg).toBe((USDG(940.5) + USDG(99) + USDG(49.5)).toString());
    expect(t.params).toMatchObject({ graduation_usdg: USDG(12_400).toString(), trade_fee_bps: 100 });
    expect(t.bond).toMatchObject({ status: "active", amount: USDG(500).toString() });
    const trades = q.trades(TOKEN);
    expect(trades.map((r) => `${r.venue}:${r.side}`)).toEqual(["curve:sell", "curve:buy", "batch:buy"]);
    // balances: alice = claim + 20M − 10M − 1M; bob = 1M; curve = supply − alice − bob
    const claim = (tokensOut * 400n) / 950n;
    const holders = q.holders(TOKEN);
    expect(holders).toEqual([{ wallet: ALICE, amount: (claim + 9_000_000n * WAD).toString() }, { wallet: BOB, amount: (1_000_000n * WAD).toString() }]);
    const curveBal = db.get<{ amount: string }>("SELECT amount FROM balances WHERE token = ? AND wallet = ?", TOKEN, CURVE)!;
    expect(BigInt(curveBal.amount) + claim + 9_000_000n * WAD + 1_000_000n * WAD).toBe(1_000_000_000n * WAD);
    expect(db.all("SELECT * FROM batch_commits")).toHaveLength(3);
    expect(db.all("SELECT * FROM batch_claims")).toHaveLength(1);
    expect(q.stats()).toMatchObject({ tokens: 1, live: 1, events: 15, trades: 3 });
  });

  it("is idempotent: syncing the same range twice changes nothing, and rebuild reproduces the projection", async () => {
    const { chain, b0 } = launchStory();
    graduate(chain, b0 + 80n);
    chain.head = b0 + 90n;
    const db = new Db();
    await syncToHead({ client: chain, db, readers });
    const before = snapshot(db);
    expect(before.tokens[0]).toMatchObject({ status: "graduated", pair: PAIR, lp_lock_id: "1", lp_burned: 0, floor_usdg: USDG(1_860).toString(), liquidity_usdg: USDG(10_292).toString() });
    expect(before.locks[0]).toMatchObject({ id: "1", token: PAIR, for_token: TOKEN, owner: CREATOR, withdrawn: 0 });
    // re-run from scratch state pointer: pretend last_block was earlier
    db.setState("last_block", (b0 + 30n).toString());
    db.setState("last_hash", chain.hashOf(b0 + 30n));
    const again = await syncToHead({ client: chain, db, readers });
    expect(again.events).toBe(0);
    expect(snapshot(db)).toEqual(before);
    rebuild(db);
    expect(snapshot(db)).toEqual(before);
  });

  it("detects a reorg, rewinds to the last matching block and re-indexes the new branch", async () => {
    const { chain, b0 } = launchStory();
    chain.head = b0 + 70n;
    const db = new Db();
    await syncToHead({ client: chain, db, readers });
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM trades")!.n).toBe(3);
    // the chain reorgs from block b0+50: the sell at b0+60 and the transfer at b0+61 disappear; a different trade lands instead
    chain.reorg(b0 + 50n);
    chain.emit(b0 + 55n, "curve", CURVE, "Trade", { trader: BOB, isBuy: true, usdgAmount: USDG(9.9), tokenAmount: 1_500_000n * WAD, price: 6_100_000_000_000n, fee: USDG(0.1) });
    chain.emit(b0 + 55n, "token", TOKEN, "Transfer", { from: CURVE, to: BOB, value: 1_500_000n * WAD });
    chain.head = b0 + 75n;
    const res = await syncToHead({ client: chain, db, readers });
    expect(res.reorgedFrom).toBe(b0 + 70n);
    const trades = queries(db).trades(TOKEN);
    expect(trades.map((r) => `${r.venue}:${r.side}:${r.wallet}`)).toEqual([`curve:buy:${BOB}`, `curve:buy:${ALICE}`, `batch:buy:${CURVE}`]);
    const t = db.get<{ usdg_raised: string; tokens_sold: string }>("SELECT usdg_raised, tokens_sold FROM tokens WHERE address = ?", TOKEN)!;
    expect(t.usdg_raised).toBe((USDG(940.5) + USDG(99) + USDG(9.9)).toString());
    expect(t.tokens_sold).toBe((216_500_000n * WAD).toString());
    expect(db.get<{ amount: string }>("SELECT amount FROM balances WHERE token = ? AND wallet = ?", TOKEN, BOB)!.amount).toBe((1_500_000n * WAD).toString());
    expect(db.getState("last_hash")).toBe(chain.hashOf(b0 + 75n));
  });

  it("refuses a reorg deeper than the window", async () => {
    const { chain, b0 } = launchStory();
    chain.head = b0 + 70n;
    const db = new Db();
    await syncToHead({ client: chain, db, readers });
    chain.reorg(MAINNET.startBlock);
    chain.head = b0 + 71n;
    await expect(sync({ client: chain, db, readers, reorgDepth: 2 })).rejects.toThrow(/reorg deeper/);
  });

  it("does nothing when already at the head and reports done", async () => {
    const chain = new FakeChain();
    chain.head = MAINNET.startBlock + 5n;
    const db = new Db();
    const a = await sync({ client: chain, db });
    expect(a).toMatchObject({ done: true, events: 0, newTokens: 0 });
    const b = await sync({ client: chain, db });
    expect(b.done).toBe(true);
    expect(b.fromBlock).toBe(chain.head + 1n);
  });
});

describe("candles", () => {
  it("builds OHLCV buckets and fills gaps flat", () => {
    const c = candlesFromTrades([
      { ts: 1000, price18: 1n * 10n ** 18n, usdg: 5_000000n },
      { ts: 1010, price18: 2n * 10n ** 18n, usdg: 1_000000n },
      { ts: 1130, price18: 3n * 10n ** 17n, usdg: 2_000000n },
    ], 60);
    expect(c.map((x) => x.t)).toEqual([960, 1020, 1080]);
    expect(c[0]).toMatchObject({ o: 1, h: 2, l: 1, c: 2, v: 6, n: 2 });
    expect(c[1]).toMatchObject({ o: 2, h: 2, l: 2, c: 2, v: 0, n: 0 });
    expect(c[2]).toMatchObject({ o: 2, h: 2, l: 0.3, c: 0.3, v: 2, n: 1 });
    expect(candlesFromTrades([], 60)).toEqual([]);
  });
});

describe("api", () => {
  it("serves the read model over http", async () => {
    const { chain, b0 } = launchStory();
    chain.head = b0 + 100n;
    const db = new Db();
    await syncToHead({ client: chain, db, readers });
    const { createApiServer } = await import("../src/index.js");
    const server = createApiServer(db);
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const get = async (p: string) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: (await r.json()) as any }; };
    expect((await get("/health")).body).toMatchObject({ ok: true, last_block: Number(chain.head) });
    expect((await get("/tokens?sort=volume")).body.tokens[0].symbol).toBe("ROBIN");
    const t = await get(`/tokens/${TOKEN}`);
    expect(t.status).toBe(200);
    expect(t.body.token.symbol).toBe("ROBIN");
    expect(t.body.trades).toHaveLength(3);
    expect(t.body.holders[0].wallet).toBe(ALICE);
    expect((await get(`/tokens/${TOKEN}/candles?tf=1h`)).body.tf).toBe("1h");
    expect((await get("/events?name=Trade")).body.events).toHaveLength(2);
    expect((await get("/tokens/0x00")).status).toBe(400);
    expect((await get("/tokens/0x00000000000000000000000000000000000a0009")).status).toBe(404);
    server.close();
  });
});
