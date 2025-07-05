-- Схема БД для сигнального бота с техническим анализом
-- Токены старше 2 недель + Helius WebSocket + TA индикаторы

CREATE TABLE IF NOT EXISTS pools (
  mint            TEXT PRIMARY KEY,
  first_seen_ts   BIGINT,    -- unix sec, когда впервые увидели InitializePool
  liq_usd         NUMERIC,   -- последняя ликвидность
  fdv_usd         NUMERIC
);

CREATE TABLE IF NOT EXISTS ohlcv (
  mint TEXT,
  ts   BIGINT,   -- начало свечи (unix sec, 1m)
  o NUMERIC, h NUMERIC, l NUMERIC, c NUMERIC, v NUMERIC,
  PRIMARY KEY (mint, ts)
);

CREATE TABLE IF NOT EXISTS signals (
  id  SERIAL PRIMARY KEY,
  mint TEXT,
  signal_ts BIGINT,
  ema_cross BOOLEAN,
  vol_spike NUMERIC,
  rsi       NUMERIC,
  notified  BOOLEAN DEFAULT FALSE
);

-- Таблица для трейдбота - хранение торговых позиций
CREATE TABLE IF NOT EXISTS trades (
  id            SERIAL PRIMARY KEY,
  mint          TEXT NOT NULL,
  buy_tx        TEXT,           -- transaction ID покупки
  sell_tx       TEXT,           -- transaction ID продажи
  bought_amount NUMERIC,        -- количество купленных токенов (human readable)
  spent_usdc    NUMERIC,        -- потрачено USDC
  received_usdc NUMERIC,        -- получено USDC при продаже
  created_at    TIMESTAMP DEFAULT NOW(),
  closed_at     TIMESTAMP       -- NULL = позиция открыта
);

-- Таблица для кеширования данных CoinGecko
CREATE TABLE IF NOT EXISTS coin_data (
  coin_id TEXT PRIMARY KEY,
  mint TEXT UNIQUE,
  symbol TEXT,
  name TEXT,
  price_usd NUMERIC,
  market_cap NUMERIC,
  volume_24h NUMERIC,
  fdv NUMERIC,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Индексы для оптимизации
CREATE INDEX IF NOT EXISTS idx_pools_first_seen ON pools (first_seen_ts);
CREATE INDEX IF NOT EXISTS idx_ohlcv_mint_ts ON ohlcv (mint, ts DESC);
CREATE INDEX IF NOT EXISTS idx_signals_notified ON signals (notified, signal_ts);
CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades (mint);
CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades (closed_at);
CREATE INDEX IF NOT EXISTS idx_coin_data_mint ON coin_data (mint);
CREATE INDEX IF NOT EXISTS idx_coin_data_updated_at ON coin_data (updated_at); 