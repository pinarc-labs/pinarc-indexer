import type { DecodedPinarcEvent } from "@pinarc-labs/sdk";
import { price18 as curvePrice18 } from "@pinarc-labs/sdk";
import { PROJECTION_TABLES, type Db } from "./db.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_UINT = (2n ** 256n - 1n).toString();
const lc = (a: unknown) => String(a).toLowerCase();
const big = (v: unknown) => BigInt(String(v));
const num = (v: unknown) => Number(v);

/** A stored event row (what `events` holds); `args` is JSON with bigints as decimal strings. */
export type StoredEvent = { tx_hash: string; log_index: number; block: number; ts: number; address: string; source: string; name: string; args: string };

export function serializeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function toStored(e: DecodedPinarcEvent, ts: number): StoredEvent {
  return { tx_hash: e.transactionHash, log_index: e.logIndex, block: Number(e.blockNumber), ts, address: lc(e.address), source: e.source, name: e.name, args: serializeArgs(e.args) };
}

function addBalance(db: Db, token: string, wallet: string, delta: bigint) {
  if (wallet === ZERO) return;
  const cur = db.get<{ amount: string }>("SELECT amount FROM balances WHERE token = ? AND wallet = ?", token, wallet);
  const next = (cur ? BigInt(cur.amount) : 0n) + delta;
  if (next === 0n) db.run("DELETE FROM balances WHERE token = ? AND wallet = ?", token, wallet);
  else db.run("INSERT INTO balances (token, wallet, amount) VALUES (?, ?, ?) ON CONFLICT(token, wallet) DO UPDATE SET amount = excluded.amount", token, wallet, next.toString());
}

/** Recompute the spot price from the curve params (when known) and the token's raised/sold counters. */
export function refreshPrice(db: Db, token: string) {
  const p = db.get<{ virtual_usdg: string; virtual_tokens: string; curve_supply: string; trade_fee_bps: number }>("SELECT virtual_usdg, virtual_tokens, curve_supply, trade_fee_bps FROM curve_params WHERE token = ?", token);
  const t = db.get<{ usdg_raised: string; tokens_sold: string; graduated_at: number | null }>("SELECT usdg_raised, tokens_sold, graduated_at FROM tokens WHERE address = ?", token);
  if (!p || !t || t.graduated_at) return;
  const price = curvePrice18({ virtualUsdg: BigInt(p.virtual_usdg), virtualTokens: BigInt(p.virtual_tokens), curveSupply: BigInt(p.curve_supply), usdgRaised: BigInt(t.usdg_raised), tokensSold: BigInt(t.tokens_sold), tradeFeeBps: p.trade_fee_bps });
  db.run("UPDATE tokens SET price18 = ? WHERE address = ?", price.toString(), token);
}

/**
 * Apply one event to the projection tables. Deterministic and order-dependent: events must be applied in
 * (block, log_index) order. Idempotency comes from the caller only inserting each event once.
 */
export function applyEvent(db: Db, e: StoredEvent) {
  const a = JSON.parse(e.args) as Record<string, string | boolean | number>;
  const curveToken = () => db.get<{ address: string }>("SELECT address FROM tokens WHERE curve = ?", e.address)?.address;
  switch (`${e.source}.${e.name}`) {
    case "factory.TokenCreated": {
      const token = lc(a.token), curve = lc(a.curve);
      const bond = big(a.bond);
      db.run(
        `INSERT OR IGNORE INTO tokens (address, curve, creator, created_block, created_at, create_tx, floor_bps, lp_lock_seconds, team_allocation, bond, dev_buy_usdg, bond_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        token, curve, lc(a.creator), e.block, e.ts, e.tx_hash, num(a.floorBps), num(a.lpLockSeconds), String(a.teamAllocation), bond.toString(), String(a.devBuyUsdg), bond > 0n ? "active" : "none",
      );
      const meta = db.get<{ name: string; symbol: string; metadata_uri: string }>("SELECT name, symbol, metadata_uri FROM token_meta WHERE token = ?", token);
      if (meta) db.run("UPDATE tokens SET name = ?, symbol = ?, metadata_uri = ? WHERE address = ?", meta.name, meta.symbol, meta.metadata_uri, token);
      // `createToken` emits the curve's Launched (and the dev-buy BatchCommitted) *before* TokenCreated in the same
      // transaction, so those were no-ops when first applied: replay the curve's earlier logs of this tx now.
      const earlier = db.all<StoredEvent>("SELECT * FROM events WHERE tx_hash = ? AND address = ? AND source = 'curve' AND log_index < ? ORDER BY log_index", e.tx_hash, curve, e.log_index);
      for (const prev of earlier) applyEvent(db, prev);
      refreshPrice(db, token);
      return;
    }
    case "curve.Launched":
      db.run("UPDATE tokens SET batch_ends_at = ? WHERE curve = ?", num(a.batchEndsAt), e.address);
      return;
    case "curve.BatchCommitted": {
      const token = curveToken();
      if (!token) return;
      db.run("INSERT OR IGNORE INTO batch_commits (tx_hash, log_index, token, wallet, usdg, block, ts) VALUES (?, ?, ?, ?, ?, ?, ?)", e.tx_hash, e.log_index, token, lc(a.buyer), String(a.usdgIn), e.block, e.ts);
      db.run("UPDATE tokens SET batch_usdg = ? WHERE address = ?", String(a.total), token);
      return;
    }
    case "curve.BatchSettled": {
      const token = curveToken();
      if (!token) return;
      const used = big(a.usdgUsed), out = big(a.tokensOut);
      db.run(
        `UPDATE tokens SET batch_settled = 1, batch_tokens_out = ?, batch_refund = ?, clearing_price18 = ?, usdg_raised = CAST(CAST(usdg_raised AS INTEGER) + ? AS TEXT), tokens_sold = ?, status = CASE WHEN status = 'batch' THEN 'live' ELSE status END WHERE address = ?`,
        out.toString(), String(a.refund), String(a.clearingPrice), used.toString(), (BigInt(db.get<{ tokens_sold: string }>("SELECT tokens_sold FROM tokens WHERE address = ?", token)!.tokens_sold) + out).toString(), token,
      );
      if (used > 0n) {
        db.run("INSERT OR IGNORE INTO trades (tx_hash, log_index, token, block, ts, wallet, side, venue, usdg, amount, price18, fee) VALUES (?, ?, ?, ?, ?, ?, 'buy', 'batch', ?, ?, ?, '0')", e.tx_hash, e.log_index, token, e.block, e.ts, e.address, used.toString(), out.toString(), String(a.clearingPrice));
        db.run("UPDATE tokens SET trades = trades + 1, volume_usdg = CAST(CAST(volume_usdg AS INTEGER) + ? AS TEXT), last_trade_at = ? WHERE address = ?", used.toString(), e.ts, token);
      }
      refreshPrice(db, token);
      return;
    }
    case "curve.BatchClaimed": {
      const token = curveToken();
      if (!token) return;
      db.run("INSERT OR IGNORE INTO batch_claims (tx_hash, log_index, token, wallet, tokens_out, refund, ts) VALUES (?, ?, ?, ?, ?, ?, ?)", e.tx_hash, e.log_index, token, lc(a.buyer), String(a.tokensOut), String(a.refund), e.ts);
      return;
    }
    case "curve.Trade": {
      const token = curveToken();
      if (!token) return;
      const isBuy = a.isBuy === true, usdg = big(a.usdgAmount), amount = big(a.tokenAmount), fee = big(a.fee);
      db.run("INSERT OR IGNORE INTO trades (tx_hash, log_index, token, block, ts, wallet, side, venue, usdg, amount, price18, fee) VALUES (?, ?, ?, ?, ?, ?, ?, 'curve', ?, ?, ?, ?)", e.tx_hash, e.log_index, token, e.block, e.ts, lc(a.trader), isBuy ? "buy" : "sell", usdg.toString(), amount.toString(), String(a.price), fee.toString());
      const t = db.get<{ usdg_raised: string; tokens_sold: string }>("SELECT usdg_raised, tokens_sold FROM tokens WHERE address = ?", token)!;
      // the contract adds usdgUsed on a buy and removes the gross (usdgOut + fee) on a sell
      const raised = isBuy ? BigInt(t.usdg_raised) + usdg : BigInt(t.usdg_raised) - usdg - fee;
      const sold = isBuy ? BigInt(t.tokens_sold) + amount : BigInt(t.tokens_sold) - amount;
      db.run("UPDATE tokens SET usdg_raised = ?, tokens_sold = ?, price18 = ?, trades = trades + 1, volume_usdg = CAST(CAST(volume_usdg AS INTEGER) + ? AS TEXT), last_trade_at = ?, status = CASE WHEN status = 'batch' THEN 'live' ELSE status END WHERE address = ?", raised.toString(), sold.toString(), String(a.price), usdg.toString(), e.ts, token);
      return;
    }
    case "curve.Graduated": {
      const token = lc(a.token);
      const lockId = String(a.lpLockId);
      db.run("UPDATE tokens SET status = 'graduated', graduated_at = ?, pair = ?, lp_lock_id = ?, lp_burned = ?, liquidity_usdg = ?, liquidity_tokens = ?, floor_usdg = ? WHERE address = ?", e.ts, lc(a.pair), lockId === MAX_UINT ? null : lockId, lockId === MAX_UINT ? 1 : 0, String(a.usdgLiquidity), String(a.tokenLiquidity), String(a.floorUsdg), token);
      db.run("UPDATE locks SET for_token = ? WHERE token = ?", token, lc(a.pair));
      return;
    }
    case "bond.Posted":
      db.run("INSERT INTO bonds (token, creator, amount, lock_seconds, status) VALUES (?, ?, ?, ?, 'active') ON CONFLICT(token) DO UPDATE SET creator = excluded.creator, amount = excluded.amount, lock_seconds = excluded.lock_seconds, status = 'active'", lc(a.token), lc(a.creator), String(a.amount), num(a.lockSeconds));
      db.run("UPDATE tokens SET bond_status = 'active', bond = ? WHERE address = ?", String(a.amount), lc(a.token));
      return;
    case "bond.Released":
      db.run("UPDATE bonds SET status = 'released' WHERE token = ?", lc(a.token));
      db.run("UPDATE tokens SET bond_status = 'released' WHERE address = ?", lc(a.token));
      return;
    case "bond.Slashed":
      db.run("UPDATE bonds SET status = 'slashed', reason = ? WHERE token = ?", String(a.reason ?? ""), lc(a.token));
      db.run("UPDATE tokens SET bond_status = 'slashed' WHERE address = ?", lc(a.token));
      return;
    case "floor.Deposited": {
      const token = lc(a.token);
      db.run("INSERT INTO floors (token, reserve) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET reserve = CAST(CAST(reserve AS INTEGER) + ? AS TEXT)", token, String(a.amount), String(a.amount));
      db.run("UPDATE tokens SET floor_usdg = (SELECT reserve FROM floors WHERE token = ?) WHERE address = ?", token, token);
      return;
    }
    case "floor.Redeemed": {
      const token = lc(a.token);
      db.run("UPDATE floors SET reserve = CAST(CAST(reserve AS INTEGER) - ? AS TEXT), redeemed_tokens = CAST(CAST(redeemed_tokens AS INTEGER) + ? AS TEXT), redeemed_usdg = CAST(CAST(redeemed_usdg AS INTEGER) + ? AS TEXT) WHERE token = ?", String(a.usdgOut), String(a.tokensBurned), String(a.usdgOut), token);
      db.run("UPDATE tokens SET floor_usdg = (SELECT reserve FROM floors WHERE token = ?) WHERE address = ?", token, token);
      return;
    }
    case "locker.Locked": {
      const lockedToken = lc(a.token);
      const forToken = db.get<{ address: string }>("SELECT address FROM tokens WHERE address = ? OR pair = ?", lockedToken, lockedToken)?.address ?? null;
      db.run("INSERT OR IGNORE INTO locks (id, token, owner, amount, unlock_at, withdrawn, for_token, tx_hash, block, ts) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)", String(a.id), lockedToken, lc(a.owner), String(a.amount), num(a.unlockAt), forToken, e.tx_hash, e.block, e.ts);
      return;
    }
    case "locker.Extended":
      db.run("UPDATE locks SET unlock_at = ? WHERE id = ?", num(a.unlockAt), String(a.id));
      return;
    case "locker.Withdrawn":
      db.run("UPDATE locks SET withdrawn = 1 WHERE id = ?", String(a.id));
      return;
    case "locker.LockTransferred":
      db.run("UPDATE locks SET owner = ? WHERE id = ?", lc(a.to), String(a.id));
      return;
    case "vault.ScheduleCreated":
      db.run("INSERT OR IGNORE INTO vesting (id, token, beneficiary, total, released, start, cliff, duration) VALUES (?, ?, ?, ?, '0', ?, ?, ?)", String(a.id), lc(a.token), lc(a.beneficiary), String(a.total), num(a.start), num(a.cliff), num(a.duration));
      db.run("UPDATE tokens SET team_vesting_id = ? WHERE address = ? AND team_vesting_id IS NULL", String(a.id), lc(a.token));
      return;
    case "vault.Released":
      db.run("UPDATE vesting SET released = CAST(CAST(released AS INTEGER) + ? AS TEXT) WHERE id = ?", String(a.amount), String(a.id));
      return;
    case "token.Transfer": {
      const value = big(a.value);
      if (value === 0n) return;
      addBalance(db, e.address, lc(a.from), -value);
      addBalance(db, e.address, lc(a.to), value);
      return;
    }
    case "curve.ReferralPaid": {
      const token = curveToken();
      db.run("INSERT OR IGNORE INTO referral_payouts (tx_hash, log_index, token, referrer, trader, usdg, block, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", e.tx_hash, e.log_index, token ?? null, lc(a.referrer), lc(a.trader), String(a.amount), e.block, e.ts);
      return;
    }
    case "policy.ReferrerBound":
      db.run("INSERT OR IGNORE INTO referrers (trader, referrer, block, ts, tx_hash) VALUES (?, ?, ?, ?, ?)", lc(a.trader), lc(a.referrer), e.block, e.ts, e.tx_hash);
      return;
    case "rewards.RoundCreated":
      db.run("INSERT OR IGNORE INTO reward_rounds (id, token, root, total, expires_at, label, block, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", String(a.roundId), lc(a.token), String(a.root), String(a.total), num(a.expiresAt), String(a.label ?? ""), e.block, e.ts);
      return;
    case "rewards.Claimed":
      db.run("INSERT OR IGNORE INTO reward_claims (round_id, idx, account, amount, tx_hash, ts) VALUES (?, ?, ?, ?, ?, ?)", String(a.roundId), String(a.index), lc(a.account), String(a.amount), e.tx_hash, e.ts);
      db.run("UPDATE reward_rounds SET claimed = CAST(CAST(claimed AS INTEGER) + ? AS TEXT) WHERE id = ?", String(a.amount), String(a.roundId));
      return;
    case "rewards.Swept":
      db.run("UPDATE reward_rounds SET swept = ? WHERE id = ?", String(a.amount), String(a.roundId));
      return;
    case "token.MetadataUpdated":
      db.run("UPDATE tokens SET metadata_uri = ? WHERE address = ?", String(a.uri), e.address);
      db.run("UPDATE token_meta SET metadata_uri = ? WHERE token = ?", String(a.uri), e.address);
      return;
    default:
      return; // config / authority events carry no projected state
  }
}

/** Drop every projection table and replay the audit log in order. Curve params and token meta are kept. */
export function rebuild(db: Db) {
  db.transaction(() => {
    for (const t of PROJECTION_TABLES) db.run(`DELETE FROM ${t}`);
    const rows = db.all<StoredEvent>("SELECT * FROM events ORDER BY block, log_index");
    for (const r of rows) applyEvent(db, r);
  });
}
