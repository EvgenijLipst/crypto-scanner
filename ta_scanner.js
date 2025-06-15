const { Pool } = require('pg');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const { SMA, EMA, RSI } = require('technicalindicators');

// --- КОНФИГУРАЦИЯ ---
// Значения берутся из переменных окружения на Railway
const DATABASE_URL = process.env.DATABASE_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Например: '@your_public_channel_name'

// Проверка наличия всех переменных окружения
if (!DATABASE_URL || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Ошибка: Не заданы все необходимые переменные окружения (DATABASE_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)");
    process.exit(1);
}

// Сети для парсинга (согласно категориям CoinGecko)
const NETWORKS = {
    'Ethereum': 'ethereum-ecosystem',
    'BSC': 'binance-smart-chain',
    'Solana': 'solana-ecosystem'
};

// Параметры для анализа
const PRICE_INCREASE_THRESHOLD = 3.0;  // в процентах
const VOLUME_INCREASE_THRESHOLD = 15.0; // в процентах
const RSI_MIN = 40;
const RSI_MAX = 70;
const HISTORICAL_DAYS = 90; // Дней для расчета тех. индикаторов

// --- ИНИЦИАЛИЗАЦИЯ ---
const dbPool = new Pool({ connectionString: DATABASE_URL });
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// --- БАЗА ДАННЫХ ---

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
        console.log("Проверка таблицы в БД выполнена.");
    } catch (err) {
        console.error("Ошибка при настройке БД:", err);
    } finally {
        client.release();
    }
}

async function getPreviousData(coinId, network) {
    try {
        const res = await dbPool.query(`
            SELECT price, volume FROM coin_data
            WHERE coin_id = $1 AND network = $2
            ORDER BY timestamp DESC
            LIMIT 1;
        `, [coinId, network]);
        return res.rows[0];
    } catch (err) {
        console.error(`Ошибка получения предыдущих данных для ${coinId}:`, err);
        return null;
    }
}

async function insertData(coinId, network, price, volume) {
    try {
        await dbPool.query(`
            INSERT INTO coin_data (coin_id, network, price, volume)
            VALUES ($1, $2, $3, $4);
        `, [coinId, network, price, volume]);
    } catch (err) {
        console.error(`Ошибка вставки данных для ${coinId}:`, err);
    }
}

async function cleanupOldData() {
    try {
        const res = await dbPool.query("DELETE FROM coin_data WHERE timestamp < NOW() - INTERVAL '24 hours';");
        console.log(`Очищено ${res.rowCount} старых записей.`);
    } catch (err) {
        console.error("Ошибка очистки старых данных:", err);
    }
}

// --- API COINGECKO И ТЕХНИЧЕСКИЙ АНАЛИЗ ---

async function getTopCoinsData(category) {
    const url = "https://api.coingecko.com/api/v3/coins/markets";
    const params = {
        vs_currency: 'usd',
        category: category,
        order: 'market_cap_desc',
        per_page: 250,
        page: 1,
        sparkline: 'false'
    };
    try {
        const response = await axios.get(url, { params });
        return response.data;
    } catch (err) {
        console.error(`Ошибка API CoinGecko при получении списка монет для ${category}:`, err.message);
        return [];
    }
}

async function getTechnicalIndicators(coinId) {
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`;
    const params = { vs_currency: 'usd', days: HISTORICAL_DAYS, interval: 'daily' };
    try {
        const response = await axios.get(url, { params });
        const prices = response.data.prices.map(p => p[1]); // Получаем только цены

        if (prices.length < 50) return null; // Недостаточно данных для SMA(50)

        const sma50 = SMA.calculate({ period: 50, values: prices }).pop();
        const ema20 = EMA.calculate({ period: 20, values: prices }).pop();
        const rsi14 = RSI.calculate({ period: 14, values: prices }).pop();

        return { sma50, ema20, rsi: rsi14 };
    } catch (err) {
        console.error(`Ошибка API CoinGecko при получении исторических данных для ${coinId}:`, err.message);
        return null;
    }
}

// --- УВЕДОМЛЕНИЕ В TELEGRAM ---

function escapeMarkdown(text) {
    const chars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
    return text.replace(new RegExp(`[${chars.join('\\')}]`, 'g'), '\\$&');
}

async function sendTelegramMessage(message) {
    try {
        await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'MarkdownV2' });
        console.log("Сообщение успешно отправлено в Telegram.");
    } catch (err) {
        console.error("Ошибка отправки сообщения в Telegram:", err);
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- ОСНОВНАЯ ЛОГИКА ---

async function main() {
    console.log(`[${new Date().toISOString()}] Запуск скрипта...`);
    
    await setupDatabase();

    for (const [networkName, category] of Object.entries(NETWORKS)) {
        console.log(`\n--- Обработка сети: ${networkName} ---`);
        const coinsData = await getTopCoinsData(category);
        if (!coinsData || coinsData.length === 0) continue;

        for (const coin of coinsData) {
            const { id: coinId, symbol, current_price: currentPrice, total_volume: currentVolume } = coin;

            if (!coinId || !currentPrice || !currentVolume) continue;
            
            const coinSymbol = symbol.toUpperCase();
            const previousData = await getPreviousData(coinId, networkName);

            if (previousData) {
                const { price: prevPrice, volume: prevVolume } = previousData;

                if (prevPrice > 0 && prevVolume > 0) {
                    const priceChange = ((currentPrice - prevPrice) / prevPrice) * 100;
                    const volumeChange = ((currentVolume - prevVolume) / prevVolume) * 100;

                    if (priceChange >= PRICE_INCREASE_THRESHOLD && volumeChange >= VOLUME_INCREASE_THRESHOLD) {
                        console.log(`Найдено совпадение для ${coinSymbol}: Рост цены ${priceChange.toFixed(2)}%, Рост объема ${volumeChange.toFixed(2)}%`);
                        
                        const indicators = await getTechnicalIndicators(coinId);
                        if (indicators) {
                            const { sma50, ema20, rsi } = indicators;
                            const priceAboveEma20 = currentPrice > ema20;
                            const priceAboveSma50 = currentPrice > sma50;
                            const rsiInRange = rsi >= RSI_MIN && rsi <= RSI_MAX;

                            if ((priceAboveEma20 || priceAboveSma50) && rsiInRange) {
                                const message = escapeMarkdown(
                                    `🚀 *Сигнал по монете: ${coinSymbol} (${networkName})*\n\n` +
                                    `📈 *Рост цены:* ${priceChange.toFixed(2)}%\n` +
                                    `📊 *Рост объема:* ${volumeChange.toFixed(2)}%\n\n` +
                                    `🔹 *Текущая цена:* $${currentPrice.toLocaleString('en-US')}\n` +
                                    `🔹 *Объем (24ч):* $${currentVolume.toLocaleString('en-US', { maximumFractionDigits: 0 })}\n` +
                                    `🔹 *RSI(14):* ${rsi.toFixed(2)}\n\n` +
                                    `✅ Цена пробила EMA(20) или SMA(50) вверх.`
                                );
                                await sendTelegramMessage(message);
                            }
                        }
                    }
                }
            }
            await insertData(coinId, networkName, currentPrice, currentVolume);
        }
        await sleep(10000); // Пауза 10 секунд между сетями
    }

    await cleanupOldData();
    console.log(`[${new Date().toISOString()}] Скрипт завершил работу.`);
}

// Запуск главной функции
main().catch(err => {
    console.error("Произошла критическая ошибка в главной функции:", err);
    process.exit(1);
});