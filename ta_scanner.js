// ta_scanner.js
const axios = require("axios");
const { Pool } = require("pg");
const { SMA, EMA, RSI } = require("technicalindicators");

// --- НАСТРОЙКИ ---
const CONFIG = {
  // Сети для сканирования (ID от CoinGecko)
  categories: ["ethereum-ecosystem", "binance-smart-chain", "solana-ecosystem"],
  // Основные триггеры
  priceChangeThreshold: 3, // Рост цены на 3%
  volumeChangeThreshold: 15, // Рост объема на 15%
  // Параметры для технического анализа
  smaPeriod: 50,
  emaPeriod: 20,
  rsiPeriod: 14,
  // Настройки базы данных и API
  dbCleanupHours: 24,
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- ОСНОВНАЯ ЛОГИКА ---
const runScanner = async () => {
  console.log("Запуск сканера...");
  await setupDatabase();

  // 1. Получаем ID всех топ-250 токенов из заданных категорий
  console.log("1. Получение списка топ-250 токенов...");
  let allTokenIds = new Set();
  for (const category of CONFIG.categories) {
    try {
      const { data } = await axios.get(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${category}&order=market_cap_desc&per_page=250&page=1`
      );
      data.forEach((token) => allTokenIds.add(token.id));
    } catch (error) {
      console.error(
        `Ошибка при получении токенов для категории ${category}:`,
        error.message
      );
    }
  }
  const uniqueTokenIds = Array.from(allTokenIds);
  console.log(
    `Найдено ${uniqueTokenIds.length} уникальных токенов для анализа.`
  );

  // 2. Получаем свежие данные (цена, объем) для всех найденных токенов
  console.log("2. Получение свежих рыночных данных...");
  const marketData = await getMarketData(uniqueTokenIds);

  // 3. Сохраняем свежие данные в базу
  console.log("3. Сохранение данных в базу...");
  await saveMarketData(marketData);

  // 4. Анализируем каждый токен
  console.log("4. Запуск анализа для каждого токена...");
  for (const tokenData of marketData) {
    await analyzeToken(tokenData);
  }

  // 5. Очистка старых данных
  console.log("5. Очистка старых данных...");
  await cleanupOldData();
};

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

async function setupDatabase() {
  await pool.query(`
        CREATE TABLE IF NOT EXISTS token_market_data (
            id SERIAL PRIMARY KEY,
            coingecko_id TEXT NOT NULL,
            symbol TEXT NOT NULL,
            price_usd NUMERIC(20, 8),
            volume_24h_usd NUMERIC(25, 4),
            timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            UNIQUE(coingecko_id, timestamp)
        )
    `);
}

async function getMarketData(tokenIds) {
  const marketData = [];
  const batchSize = 250; // CoinGecko позволяет запрашивать до 250 ID за раз
  for (let i = 0; i < tokenIds.length; i += batchSize) {
    const batch = tokenIds.slice(i, i + batchSize);
    try {
      const { data } = await axios.get(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${batch.join(
          ","
        )}`
      );
      marketData.push(...data);
    } catch (error) {
      console.error(
        `Ошибка при получении рыночных данных для батча:`,
        error.message
      );
    }
    await new Promise((res) => setTimeout(res, 1000)); // Небольшая пауза между батчами
  }
  return marketData;
}

async function saveMarketData(marketData) {
  for (const token of marketData) {
    if (token.id && token.current_price && token.total_volume) {
      await pool.query(
        `INSERT INTO token_market_data(coingecko_id, symbol, price_usd, volume_24h_usd) VALUES($1, $2, $3, $4)`,
        [
          token.id,
          token.symbol.toUpperCase(),
          token.current_price,
          token.total_volume,
        ]
      );
    }
  }
  console.log(`Сохранено ${marketData.length} новых записей.`);
}

async function analyzeToken(currentTokenData) {
  try {
    // Получаем исторические данные для расчета
    const { rows: history } = await pool.query(
      `SELECT price_usd, volume_24h_usd FROM token_market_data WHERE coingecko_id = $1 ORDER BY timestamp DESC LIMIT 100`, // Берем 100 последних точек для расчета TA
      [currentTokenData.id]
    );

    if (history.length < 2) {
      console.log(
        `Для ${currentTokenData.symbol} недостаточно исторических данных.`
      );
      return;
    }

    const currentPrice = parseFloat(history[0].price_usd);
    const previousPrice = parseFloat(history[1].price_usd);
    const currentVolume = parseFloat(history[0].volume_24h_usd);
    const previousVolume = parseFloat(history[1].volume_24h_usd);

    const priceChange = ((currentPrice - previousPrice) / previousPrice) * 100;
    const volumeChange =
      ((currentVolume - previousVolume) / previousVolume) * 100;

    // --- Первичный триггер ---
    if (
      priceChange >= CONFIG.priceChangeThreshold &&
      volumeChange >= CONFIG.volumeChangeThreshold
    ) {
      console.log(
        `[ПЕРВИЧНЫЙ СИГНАЛ] для ${
          currentTokenData.symbol
        }: Рост цены ${priceChange.toFixed(
          2
        )}%, Рост объема ${volumeChange.toFixed(2)}%`
      );

      // --- Технический анализ ---
      const prices = history.map((row) => parseFloat(row.price_usd)).reverse(); // Нужен массив от старых к новым

      const sma50 = SMA.calculate({ period: CONFIG.smaPeriod, values: prices });
      const ema20 = EMA.calculate({ period: CONFIG.emaPeriod, values: prices });
      const rsi = RSI.calculate({ period: CONFIG.rsiPeriod, values: prices });

      const lastSma50 = sma50[sma50.length - 1];
      const lastEma20 = ema20[ema20.length - 1];
      const lastRsi = rsi[rsi.length - 1];

      console.log(
        `[TA-ДАННЫЕ] для ${
          currentTokenData.symbol
        }: Цена=${currentPrice.toFixed(4)}, SMA50=${lastSma50.toFixed(
          4
        )}, EMA20=${lastEma20.toFixed(4)}, RSI=${lastRsi.toFixed(2)}`
      );

      // --- ВАША ЛОГИКА ПРИНЯТИЯ РЕШЕНИЙ ---
      // На данном этапе у вас есть все необходимые данные для принятия решения.
      // Ниже приведен пример, как может выглядеть ваша финальная проверка.
      // ВАЖНО: Этот код является примером и не является финансовой рекомендацией.
      // Вам нужно раскомментировать и адаптировать его под себя.
      
            const smaCrossover = currentPrice > lastSma50;
            const emaCrossover = currentPrice > lastEma20;
            const rsiInRange = lastRsi > 40 && lastRsi < 70;

            if ((smaCrossover || emaCrossover) && rsiInRange) {
                console.log(`[!!!] ПОЛНЫЙ СИГНАЛ для ${currentTokenData.symbol}. Отправка в Telegram...`);
                const message = `
                📈 **Сигнал по токену: ${currentTokenData.symbol.toUpperCase()}**
                -----------------------------------
                **Цена:** $${currentPrice.toFixed(4)}
                **Рост цены (15 мин):** ${priceChange.toFixed(2)}%
                **Рост объема (15 мин):** ${volumeChange.toFixed(2)}%
                -----------------------------------
                **SMA50:** ${lastSma50.toFixed(4)} (пробит: ${smaCrossover})
                **EMA20:** ${lastEma20.toFixed(4)} (пробит: ${emaCrossover})
                **RSI:** ${lastRsi.toFixed(2)}
                `;
                await sendTelegramMessage(message);
            } else {
                console.log(`[INFO] Первичный триггер для ${currentTokenData.symbol} сработал, но ТА не подтвержден.`);
            }
            
    }
  } catch (error) {
    console.error(
      `Ошибка при анализе токена ${currentTokenData.symbol}:`,
      error.message
    );
  }
}

async function cleanupOldData() {
  await pool.query(
    `DELETE FROM token_market_data WHERE timestamp < NOW() - INTERVAL '${CONFIG.dbCleanupHours} hours'`
  );
  console.log("Очистка старых рыночных данных завершена.");
}

async function sendTelegramMessage(text) {
  const { botToken, chatId } = CONFIG.telegram;
  if (!botToken || !chatId) {
    console.warn("Переменные для Telegram не настроены.");
    return;
  }
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    await axios.post(url, { chat_id: chatId, text, parse_mode: "Markdown" });
  } catch (error) {
    console.error("Ошибка отправки сообщения в Telegram:", error.message);
  }
}

// --- Запуск и завершение ---
runScanner()
  .then(() => console.log("Сканирование завершено."))
  .catch((e) => console.error("Критическая ошибка сканера:", e))
  .finally(() => {
    pool.end();
    console.log("Соединение с базой данных закрыто.");
  });
