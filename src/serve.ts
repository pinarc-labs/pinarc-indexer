import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TIMEFRAMES, candlesFromTrades } from "./candles.js";
import type { Db } from "./db.js";

const ZERO = "0x0000000000000000000000000000000000000000", DEAD = "0x000000000000000000000000000000000000dead";
const ADDR = /^0x[0-9a-f]{40}$/;

/** Read-model queries over the SQLite database; also used by the HTTP server. */
export function queries(db: Db) {
  return {
    health() {
      return { ok: true, last_block: Number(db.getState("last_block") ?? 0), synced_at: Number(db.getState("synced_at") ?? 0), ts: Math.floor(Date.now() / 1000) };
    },
    stats() {
      const t = db.get<{ n: number; graduated: number; live: number; batch: number }>("SELECT COUNT(*) n, SUM(status = 'graduated') graduated, SUM(status = 'live') live, SUM(status = 'batch') batch FROM tokens")!;
      const e = db.get<{ n: number }>("SELECT COUNT(*) n FROM events")!;
      const tr = db.get<{ n: number; vol: string }>("SELECT COUNT(*) n, COALESCE(SUM(CAST(usdg AS INTEGER)), 0) vol FROM trades")!;
      return { tokens: t.n, batch: t.batch ?? 0, live: t.live ?? 0, graduated: t.graduated ?? 0, events: e.n, trades: tr.n, volume_usdg: String(tr.vol), last_block: Number(db.getState("last_block") ?? 0), synced_at: Number(db.getState("synced_at") ?? 0) };
    },
    tokens(q: { status?: string; sort?: "created" | "volume" | "trades" | "last_trade"; limit?: number } = {}) {
      const order = { created: "created_block DESC", volume: "CAST(volume_usdg AS INTEGER) DESC", trades: "trades DESC", last_trade: "last_trade_at DESC" }[q.sort ?? "created"];
      const limit = Math.min(500, Math.max(1, q.limit ?? 100));
      return q.status ? db.all("SELECT * FROM tokens WHERE status = ? ORDER BY " + order + " LIMIT ?", q.status, limit) : db.all("SELECT * FROM tokens ORDER BY " + order + " LIMIT ?", limit);
    },
    token(address: string) {
      const a = address.toLowerCase();
      const token = db.get("SELECT * FROM tokens WHERE address = ?", a);
      if (!token) return null;
      const params = db.get("SELECT * FROM curve_params WHERE token = ?", a) ?? null;
      const bond = db.get("SELECT * FROM bonds WHERE token = ?", a) ?? null;
      const floor = db.get("SELECT * FROM floors WHERE token = ?", a) ?? null;
      const locks = db.all("SELECT * FROM locks WHERE for_token = ? OR token = ? ORDER BY id", a, a);
      const vesting = db.all("SELECT * FROM vesting WHERE token = ? ORDER BY id", a);
      return { token, params, bond, floor, locks, vesting };
    },
    trades(address: string, limit = 50) {
      return db.all("SELECT * FROM trades WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT ?", address.toLowerCase(), Math.min(1000, limit));
    },
    holders(address: string, limit = 50) {
      const a = address.toLowerCase();
      const t = db.get<{ curve: string; pair: string | null }>("SELECT curve, pair FROM tokens WHERE address = ?", a);
      const structural = [ZERO, DEAD, t?.curve ?? "", t?.pair ?? ""];
      return db.all("SELECT wallet, amount FROM balances WHERE token = ? AND wallet NOT IN (?, ?, ?, ?) ORDER BY CAST(amount AS REAL) DESC LIMIT ?", a, ...structural, Math.min(500, limit));
    },
    candles(address: string, tf = "5m", limit = 300) {
      const step = TIMEFRAMES[tf] ?? 300;
      const rows = db.all<{ ts: number; price18: string; usdg: string }>("SELECT ts, price18, usdg FROM trades WHERE token = ? AND ts >= ? ORDER BY block, log_index", address.toLowerCase(), Math.floor(Date.now() / 1000) - step * (limit + 5));
      return { tf, step, candles: candlesFromTrades(rows, step, limit) };
    },
    events(q: { address?: string; name?: string; limit?: number } = {}) {
      const where: string[] = [], params: (string | number)[] = [];
      if (q.address) { where.push("address = ?"); params.push(q.address.toLowerCase()); }
      if (q.name) { where.push("name = ?"); params.push(q.name); }
      const rows = db.all<{ args: string }>(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY block DESC, log_index DESC LIMIT ?`, ...params, Math.min(1000, q.limit ?? 100));
      return rows.map((r) => ({ ...r, args: JSON.parse(r.args) }));
    },
    locks(owner?: string) {
      return owner ? db.all("SELECT * FROM locks WHERE owner = ? ORDER BY id", owner.toLowerCase()) : db.all("SELECT * FROM locks ORDER BY id DESC LIMIT 200");
    },
    vesting(beneficiary?: string) {
      return beneficiary ? db.all("SELECT * FROM vesting WHERE beneficiary = ? ORDER BY id", beneficiary.toLowerCase()) : db.all("SELECT * FROM vesting ORDER BY id DESC LIMIT 200");
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "public, max-age=5" });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** Minimal JSON API over the database: /health /stats /tokens /tokens/:a /tokens/:a/trades /tokens/:a/holders /tokens/:a/candles /events /locks /vesting */
export function createApiServer(db: Db) {
  const q = queries(db);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      const num = (k: string, d: number) => Number(url.searchParams.get(k) ?? d) || d;
      if (parts.length === 0 || parts[0] === "health") return json(res, 200, q.health());
      if (parts[0] === "stats") return json(res, 200, q.stats());
      if (parts[0] === "events") return json(res, 200, { events: q.events({ address: url.searchParams.get("address") ?? undefined, name: url.searchParams.get("name") ?? undefined, limit: num("limit", 100) }) });
      if (parts[0] === "locks") return json(res, 200, { locks: q.locks(url.searchParams.get("owner") ?? undefined) });
      if (parts[0] === "vesting") return json(res, 200, { vesting: q.vesting(url.searchParams.get("beneficiary") ?? undefined) });
      if (parts[0] === "tokens") {
        if (parts.length === 1) return json(res, 200, { tokens: q.tokens({ status: url.searchParams.get("status") ?? undefined, sort: (url.searchParams.get("sort") as never) ?? undefined, limit: num("limit", 100) }) });
        const address = parts[1]!.toLowerCase();
        if (!ADDR.test(address)) return json(res, 400, { error: "bad address" });
        if (parts.length === 2) {
          const t = q.token(address);
          return t ? json(res, 200, { ...t, trades: q.trades(address, 30), holders: q.holders(address, 50) }) : json(res, 404, { error: "not found" });
        }
        if (parts[2] === "trades") return json(res, 200, { trades: q.trades(address, num("limit", 50)) });
        if (parts[2] === "holders") return json(res, 200, { holders: q.holders(address, num("limit", 50)) });
        if (parts[2] === "candles") return json(res, 200, q.candles(address, url.searchParams.get("tf") ?? "5m", num("limit", 300)));
      }
      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}
