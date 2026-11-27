-- Skema D1 yang dipakai mempool.my.id. Aman dijalankan ke database lama (IF NOT EXISTS).
--   npx wrangler d1 execute <NAMA_DB> --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS fees (
  id         INTEGER PRIMARY KEY,
  fastest    REAL, half_hour REAL, hour REAL, economy REAL, minimum REAL,
  btc_usd    REAL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fee_history (
  fastest REAL, half_hour REAL, hour REAL, economy REAL, minimum REAL,
  btc_usd REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fee_history_created ON fee_history (created_at);

CREATE TABLE IF NOT EXISTS rates_cache (
  id         INTEGER PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
