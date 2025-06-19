// ta_scanner.js

const { Pool } = require('pg');
const axios = require('axios');
const rateLimit = require('axios-rate-limit');
const { Telegraf } = require('telegraf');

// — Конфигурация из окружения —
const DATABASE_URL       = process.env.DATABASE_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const COINGECKO_API_KEY  = process.env.COINGECKO_API_KEY;

if (!DATABASE_URL || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !COINGECKO_API_KEY) {
  console.error("Ошибка: не заданы все переменные окружения!");
  process.exit(1);
}

// Ограничение по запросам к CoinGecko
const http = rateLimit(
  axios.create({ headers: { 'x-cg-demo-api-key': COINGECKO_API_KEY } }),
  { maxRequests: 15, perMilliseconds: 60_000 }
);

const CATEGORY        = 'solana-ecosystem'; // только Solana
const NETWORK_NAME    = 'Solana';
const PLATFORM_ID     = 'solana';
const PRICE_THRESHOLD = 3.0;                // % порог роста

// Инициализация PostgreSQL и Telegram
const dbPool = new Pool({ connectionString: DATABASE_URL });
const bot    = new Telegraf(TELEGRAM_BOT_TOKEN);

// Создание необходимых таблиц
async function setupDatabase() {
  const client = await dbPool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS coin_data (
        id SERIAL PRIMARY KEY,
        coin_id VARCHAR(100) NOT NULL,
        network VARCHAR(50) NOT NULL,
        price DOUBLE PRECISION NOT NULL,
        volume DOUBLE PRECISION NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_coin_network_time
      ON coin_data (coin_id, network, timestamp DESC);
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS signals (
        id SERIAL PRIMARY KEY,
        token_mint VARCHAR(100) NOT NULL,
        processed BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } finally {
    client.release();
  }
}

// Получение предыдущей записи по монете
async function getPreviousData(coinId) {
  const res = await dbPool.query(
    `SELECT price, volume
       FROM coin_data
      WHERE coin_id = $1 AND network = $2
      ORDER BY timestamp DESC
      LIMIT 1`,
    [coinId, NETWORK_NAME]
  );
  return res.rows[0] || null;
}

// Вставка текущих данных
async function insertData(coinId, price, volume) {
  await dbPool.query(
    `INSERT INTO coin_data(coin_id, network, price, volume)
     VALUES($1, $2, $3, $4)`,
    [coinId, NETWORK_NAME, price, volume]
  );
}

// Удаление старых данных старше 24 часов
async function cleanupOldData() {
  await dbPool.query(
    `DELETE FROM coin_data
      WHERE timestamp < NOW() - INTERVAL '24 hours'`
  );
}

// Получение топ-250 монет Solana по капитализации
async function getTopCoins() {
  const url = 'https://api.coingecko.com/api/v3/coins/markets';
  const params = {
    vs_currency: 'usd',
    category: CATEGORY,
    order: 'market_cap_desc',
    per_page: 250,
    page: 1,
    sparkline: 'false'
  };
  const res = await http.get(url, { params });
  return res.data;
}

// Получение адреса контракта в Solana
async function getContractAddress(coinId) {
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}`;
  const params = {
    localization: 'false',
    tickers: 'false',
    market_data: 'false',
    community_data: 'false',
    developer_data: 'false',
    sparkline: 'false'
  };
  const res = await http.get(url, { params });
  return res.data.platforms[PLATFORM_ID] || null;
}

// Экранирование Markdown-символов
function escapeMarkdown(txt) {
  return String(txt).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// Отправка сообщения в Telegram
async function sendTelegram(text) {
  await bot.telegram.sendMessage(
    TELEGRAM_CHAT_ID,
    text,
    { parse_mode: 'MarkdownV2' }
  );
}

async function main() {
  console.log(`[${new Date().toISOString()}] Scanner start`);
  await setupDatabase();

  const coins = await getTopCoins();
  const signaled = new Set();

  for (const coin of coins) {
    const { id, symbol, current_price: price, total_volume: volume } = coin;
    if (!id || !price || !volume) continue;

    const prev = await getPreviousData(id);
    if (prev) {
      const change = ((price - prev.price) / prev.price) * 100;
      if (change >= PRICE_THRESHOLD && !signaled.has(id)) {
        const contract = await getContractAddress(id);
        let message =
          `🚀 *${escapeMarkdown(symbol.toUpperCase())}* on *${NETWORK_NAME}*\n\n` +
          `📈 Price up: *${escapeMarkdown(change.toFixed(2))}%*\n` +
          `💰 Current: $${escapeMarkdown(price.toFixed(6))}\n` +
          `🔄 Prev: $${escapeMarkdown(prev.price.toFixed(6))}\n` +
          `📊 Volume: $${escapeMarkdown(Math.round(volume).toLocaleString())}`;
        if (contract) {
          message += `\n\n📝 Contract:\n\`${contract}\``;
        }

        await sendTelegram(message);

        if (contract) {
          await dbPool.query(
            `INSERT INTO signals(token_mint) VALUES($1);`,
            [contract]
          );
          console.log(`Signal queued: ${contract}`);
        }

        signaled.add(id);
      }
    }

    await insertData(id, price, volume);
  }

  await cleanupOldData();
  console.log(`[${new Date().toISOString()}] Scanner done`);
  process.exit(0);
}

main().catch(err => {
  console.error("Scanner error:", err);
  process.exit(1);
});
