-- fix-coin-data-schema.sql - Исправление схемы таблицы coin_data

-- Проверим текущую структуру таблицы
\d coin_data;

-- Удалим таблицу и создадим заново с правильной схемой
DROP TABLE IF EXISTS coin_data CASCADE;

-- Создаем таблицу с правильной схемой
CREATE TABLE coin_data (
  id SERIAL PRIMARY KEY,
  coin_id TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'Solana',
  price NUMERIC NOT NULL,
  volume NUMERIC NOT NULL,
  market_cap NUMERIC,
  fdv NUMERIC,
  timestamp TIMESTAMP DEFAULT NOW()
);

-- Добавляем уникальное ограничение
ALTER TABLE coin_data ADD CONSTRAINT coin_data_coin_network_uidx UNIQUE (coin_id, network);

-- Добавляем индексы
CREATE INDEX IF NOT EXISTS idx_coin_data_mint ON coin_data (mint);
CREATE INDEX IF NOT EXISTS idx_coin_data_network_timestamp ON coin_data (network, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_coin_data_timestamp ON coin_data (timestamp DESC);

-- Проверим финальную структуру
\d coin_data;

-- Проверим количество записей
SELECT COUNT(*) FROM coin_data; 