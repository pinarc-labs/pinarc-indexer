export type TradeLike = { ts: number; price18: string | bigint; usdg: string | bigint };
export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number; n: number };

export const TIMEFRAMES: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

const p = (v: string | bigint) => Number(BigInt(v)) / 1e18;
const u = (v: string | bigint) => Number(BigInt(v)) / 1e6;

/** OHLCV candles from trades sorted by time. Gaps are filled with flat candles at the previous close. */
export function candlesFromTrades(trades: TradeLike[], stepSeconds: number, limit = 500): Candle[] {
  if (!trades.length) return [];
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const t of trades) {
    const bucket = Math.floor(t.ts / stepSeconds) * stepSeconds;
    const price = p(t.price18), vol = u(t.usdg);
    if (cur && bucket === cur.t) {
      cur.h = Math.max(cur.h, price); cur.l = Math.min(cur.l, price); cur.c = price; cur.v += vol; cur.n++;
      continue;
    }
    if (cur) {
      out.push(cur);
      for (let g = cur.t + stepSeconds; g < bucket; g += stepSeconds) out.push({ t: g, o: cur.c, h: cur.c, l: cur.c, c: cur.c, v: 0, n: 0 });
    }
    const open: number = cur ? cur.c : price;
    cur = { t: bucket, o: open, h: Math.max(open, price), l: Math.min(open, price), c: price, v: vol, n: 1 };
  }
  if (cur) out.push(cur);
  return out.slice(-limit);
}
