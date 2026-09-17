import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Every bigint is stored as a decimal TEXT so nothing is rounded; timestamps are unix seconds. */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL, ts INTEGER NOT NULL);

-- Audit log: every decoded protocol event, exactly once. All other tables are projections of this one.
CREATE TABLE IF NOT EXISTS events (
  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block INTEGER NOT NULL, ts INTEGER NOT NULL,
  address TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL, args TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS events_block ON events(block, log_index);
CREATE INDEX IF NOT EXISTS events_address ON events(address);

CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY, curve TEXT NOT NULL UNIQUE, creator TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', symbol TEXT NOT NULL DEFAULT '', metadata_uri TEXT NOT NULL DEFAULT '',
  created_block INTEGER NOT NULL, created_at INTEGER NOT NULL, create_tx TEXT NOT NULL,
  floor_bps INTEGER NOT NULL, lp_lock_seconds INTEGER NOT NULL, team_allocation TEXT NOT NULL, bond TEXT NOT NULL, dev_buy_usdg TEXT NOT NULL,
  batch_ends_at INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'batch',
  batch_usdg TEXT NOT NULL DEFAULT '0', batch_settled INTEGER NOT NULL DEFAULT 0, batch_tokens_out TEXT, batch_refund TEXT, clearing_price18 TEXT,
  usdg_raised TEXT NOT NULL DEFAULT '0', tokens_sold TEXT NOT NULL DEFAULT '0', price18 TEXT NOT NULL DEFAULT '0',
  trades INTEGER NOT NULL DEFAULT 0, volume_usdg TEXT NOT NULL DEFAULT '0', last_trade_at INTEGER,
  graduated_at INTEGER, pair TEXT, lp_lock_id TEXT, lp_burned INTEGER NOT NULL DEFAULT 0, liquidity_usdg TEXT, liquidity_tokens TEXT, floor_usdg TEXT NOT NULL DEFAULT '0',
  bond_status TEXT NOT NULL DEFAULT 'none', team_vesting_id TEXT
);
CREATE INDEX IF NOT EXISTS tokens_created ON tokens(created_block);

CREATE TABLE IF NOT EXISTS trades (
  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, token TEXT NOT NULL, block INTEGER NOT NULL, ts INTEGER NOT NULL,
  wallet TEXT NOT NULL, side TEXT NOT NULL, venue TEXT NOT NULL, usdg TEXT NOT NULL, amount TEXT NOT NULL, price18 TEXT NOT NULL, fee TEXT NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS trades_token_ts ON trades(token, ts);

CREATE TABLE IF NOT EXISTS batch_commits (
  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, token TEXT NOT NULL, wallet TEXT NOT NULL, usdg TEXT NOT NULL, block INTEGER NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS batch_claims (
  tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, token TEXT NOT NULL, wallet TEXT NOT NULL, tokens_out TEXT NOT NULL, refund TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);

-- ERC-20 balances of every launched token, from Transfer events (the curve, pair, vault and locker included).
CREATE TABLE IF NOT EXISTS balances (token TEXT NOT NULL, wallet TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY (token, wallet));

CREATE TABLE IF NOT EXISTS locks (
  id TEXT PRIMARY KEY, token TEXT NOT NULL, owner TEXT NOT NULL, amount TEXT NOT NULL, unlock_at INTEGER NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0,
  for_token TEXT, tx_hash TEXT NOT NULL, block INTEGER NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS vesting (
  id TEXT PRIMARY KEY, token TEXT NOT NULL, beneficiary TEXT NOT NULL, total TEXT NOT NULL, released TEXT NOT NULL DEFAULT '0',
  start INTEGER NOT NULL, cliff INTEGER NOT NULL, duration INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bonds (token TEXT PRIMARY KEY, creator TEXT NOT NULL, amount TEXT NOT NULL, lock_seconds INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT);
CREATE TABLE IF NOT EXISTS floors (token TEXT PRIMARY KEY, reserve TEXT NOT NULL DEFAULT '0', redeemed_tokens TEXT NOT NULL DEFAULT '0', redeemed_usdg TEXT NOT NULL DEFAULT '0');

-- Read from the chain once per launch (not derivable from events); survive a rebuild.
CREATE TABLE IF NOT EXISTS curve_params (
  token TEXT PRIMARY KEY, curve TEXT NOT NULL, virtual_usdg TEXT NOT NULL, virtual_tokens TEXT NOT NULL, curve_supply TEXT NOT NULL, lp_supply TEXT NOT NULL,
  graduation_usdg TEXT NOT NULL, trade_fee_bps INTEGER NOT NULL, creator_share_bps INTEGER NOT NULL, graduation_fee_bps INTEGER NOT NULL,
  anti_sniper_seconds INTEGER NOT NULL, cooldown_seconds INTEGER NOT NULL, max_wallet TEXT NOT NULL, max_tx TEXT NOT NULL, max_batch_commit TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS token_meta (token TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL, metadata_uri TEXT NOT NULL, total_supply TEXT NOT NULL);
`;

export type Row = Record<string, SQLInputValue>;

/** Thin wrapper over node:sqlite with the schema applied and a few helpers. */
export class Db {
  readonly sqlite: DatabaseSync;
  constructor(path = ":memory:") {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
    this.sqlite.exec(SCHEMA);
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.sqlite.prepare(sql).run(...params);
  }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.sqlite.prepare(sql).get(...params) as T | undefined;
  }
  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }
  transaction<T>(fn: () => T): T {
    this.sqlite.exec("BEGIN");
    try {
      const out = fn();
      this.sqlite.exec("COMMIT");
      return out;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }
  getState(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM sync_state WHERE key = ?", key)?.value;
  }
  setState(key: string, value: string | number | bigint) {
    this.run("INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value));
  }
  close() {
    this.sqlite.close();
  }
}

/** Tables rebuilt from `events` by `rebuild()`; `events`, `blocks` and `sync_state` are the durable inputs. */
export const PROJECTION_TABLES = ["tokens", "trades", "batch_commits", "batch_claims", "balances", "locks", "vesting", "bonds", "floors"] as const;
