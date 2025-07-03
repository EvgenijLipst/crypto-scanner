-- Схема БД для сигнального бота с техническим анализом
-- Токены старше 2 недель + Helius WebSocket + TA индикаторы

CREATE TABLE pools (
  mint            TEXT PRIMARY KEY,
  first_seen_ts   BIGINT,    -- unix sec, когда впервые увидели InitializePool
  liq_usd         NUMERIC,   -- последняя ликвидность
  fdv_usd         NUMERIC
);

CREATE TABLE ohlcv (
  mint TEXT,
  ts   BIGINT,   -- начало свечи (unix sec, 1m)
  o NUMERIC, h NUMERIC, l NUMERIC, c NUMERIC, v NUMERIC,
  PRIMARY KEY (mint, ts)
);

CREATE TABLE signals (
  id  SERIAL PRIMARY KEY,
  mint TEXT,
  signal_ts BIGINT,
  ema_cross BOOLEAN,
  vol_spike NUMERIC,
  rsi       NUMERIC,
  notified  BOOLEAN DEFAULT FALSE
);

-- Индексы для оптимизации
CREATE INDEX IF NOT EXISTS idx_pools_first_seen ON pools (first_seen_ts);
CREATE INDEX IF NOT EXISTS idx_ohlcv_mint_ts ON ohlcv (mint, ts DESC);
CREATE INDEX IF NOT EXISTS idx_signals_notified ON signals (notified, signal_ts); 