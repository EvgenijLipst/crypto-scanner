const { Pool } = require('pg');
const axios = require('axios');
const rateLimit = require('axios-rate-limit');
const { Telegraf } = require('telegraf');

// --- КОНФИГУРАЦИЯ ---
const DATABASE_URL = process.env.DATABASE_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

if (!DATABASE_URL || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !COINGECKO_API_KEY) {
    console.error("Критическая ошибка: Не заданы все необходимые переменные окружения, включая COINGECKO_API_KEY!");
    process.exit(1);
}

// --- НОВАЯ ГИБРИДНАЯ СИСТЕМА ЗАПРОСОВ ---
// 1. Анонимный клиент с очень низким лимитом
const anonymousHttp = rateLimit(axios.create(), { maxRequests: 3, perMilliseconds: 60000 });

// 2. Клиент с API-ключом для запасного варианта
const keyedHttp = rateLimit(axios.create({
    headers: { 'x-cg-demo-api-key': COINGECKO_API_KEY }
}), { maxRequests: 15, perMilliseconds: 60000 });
// ---------------------------------------------

const NETWORKS = {
    'BSC': 'binance-smart-chain',
    'Solana': 'solana-ecosystem',
    'Avalanche': 'avalanche-ecosystem',
    'Optimism': 'optimism-ecosystem',
    'Arbitrum One': 'arbitrum-ecosystem'
};

const PLATFORM_ID_MAP = {
    'BSC': 'binance-smart-chain',
    'Solana': 'solana',
    'Avalanche': 'avalanche',
    'Optimism': 'optimistic-ethereum',
    'Arbitrum One': 'arbitrum-one'
};

const PRICE_INCREASE_THRESHOLD = 3.0;

const dbPool = new Pool({ connectionString: DATABASE_URL });
const bot = new Telegraf(TELEGRAM_BOT_TOKEN);


// --- НОВАЯ УНИВЕРСАЛЬНАЯ ФУНКЦИЯ ДЛЯ API ЗАПРОСОВ ---
async function makeSmartApiCall(url, params, defaultValue = null) {
    try {
        // Сначала пробуем анонимный запрос
        const response = await anonymousHttp.get(url, { params });
        return response.data;
    } catch (err) {
        // Если поймали ошибку лимита (429)
        if (err.response && err.response.status === 429) {
            console.warn(`  -> Анонимный лимит исчерпан. Переключаемся на API-ключ для запроса: ${url}`);
            try {
                // Повторяем запрос, но уже с ключом
                const responseWithKey = await keyedHttp.get(url, { params });
                return responseWithKey.data;
            } catch (retryErr) {
                console.error(`  -> Повторный запрос с ключом также не удался для ${url}:`, retryErr.message);
                return defaultValue;
            }
        }
        // Если ошибка другая, просто логируем ее
        console.error(`  -> Ошибка API CoinGecko для ${url}:`, err.message);
        return defaultValue;
    }
}
// ---------------------------------------------------


async function setupDatabase() { /* код без изменений */ }
async function getPreviousData(coinId, network) { /* код без изменений */ }
async function insertData(coinId, network, price, volume) { /* код без изменений */ }
async function cleanupOldData() { /* код без изменений */ }

// --- ОБНОВЛЕННЫЕ ФУНКЦИИ, ИСПОЛЬЗУЮЩИЕ НОВЫЙ МЕХАНИЗМ ---
async function getTopCoinsData(category) {
    const url = "https://api.coingecko.com/api/v3/coins/markets";
    const params = { vs_currency: 'usd', category: category, order: 'market_cap_desc', per_page: 250, page: 1, sparkline: 'false' };
    return await makeSmartApiCall(url, params, []); // Возвращаем пустой массив в случае ошибки
}

async function getContractAddress(coinId, networkName) {
    const platformId = PLATFORM_ID_MAP[networkName];
    if (!platformId) return null;
    
    const url = `https://api.coingecko.com/api/v3/coins/${coinId}`;
    const params = { localization: 'false', tickers: 'false', market_data: 'false', community_data: 'false', developer_data: 'false', sparkline: 'false' };
    const data = await makeSmartApiCall(url, params);
    return data?.platforms?.[platformId] || null;
}
// -----------------------------------------------------------

function escapeMarkdown(text) { /* код без изменений */ }
async function sendTelegramMessage(message) { /* код без изменений */ }

async function main() {
    console.log(`[${new Date().toISOString()}] Запуск скрипта...`);
    const sentSymbolsInThisRun = new Set();
    await setupDatabase();

    for (const [networkName, category] of Object.entries(NETWORKS)) {
        console.log(`\n--- Обработка сети: ${networkName} ---`);
        const coinsData = await getTopCoinsData(category);
        console.log(`Получено ${coinsData.length} монет для сети ${networkName}.`);
        
        if (!coinsData || coinsData.length === 0) {
            console.log(`Пропускаем сеть ${networkName}, так как не получено данных.`);
            continue;
        }

        for (const coin of coinsData) {
            const { id: coinId, symbol, current_price: currentPrice, total_volume: currentVolume } = coin;
            if (!coinId || !currentPrice || !currentVolume) continue;
            
            const coinSymbol = symbol.toUpperCase();
            console.log(`  [${coinSymbol}] Сканирую... Цена: $${currentPrice}, Объем: $${Math.round(currentVolume).toLocaleString('en-US')}`);
            
            const previousData = await getPreviousData(coinId, networkName);

            if (previousData) {
                const { price: prevPrice, volume: prevVolume } = previousData;
                if (prevPrice > 0) {
                    const priceChange = ((currentPrice - prevPrice) / prevPrice) * 100;
                    
                    if (priceChange >= PRICE_INCREASE_THRESHOLD) {
                        if (!sentSymbolsInThisRun.has(coinSymbol)) {
                            const volumeChange = prevVolume > 0 ? ((currentVolume - prevVolume) / prevVolume) * 100 : 0;
                            
                            console.log(`Найдено совпадение для ${coinSymbol}: Рост цены ${priceChange.toFixed(2)}%`);
                            
                            const contractAddress = await getContractAddress(coinId, networkName);
                            
                            let messageText = `🚀 *Сигнал по монете: ${escapeMarkdown(coinSymbol)} \\(${escapeMarkdown(networkName)}\\)*\n\n` +
                                            `📈 *Рост цены:* ${escapeMarkdown(priceChange.toFixed(2))}%\n` +
                                            `📊 *Рост объема:* ${escapeMarkdown(volumeChange.toFixed(2))}%\n\n` +
                                            `🔹 *Текущая цена:* $${escapeMarkdown(currentPrice.toLocaleString('en-US', {minimumFractionDigits: 3, maximumFractionDigits: 6}))}\n` +
                                            `🔹 *Предыдущая цена:* $${escapeMarkdown(prevPrice.toLocaleString('en-US', {minimumFractionDigits: 3, maximumFractionDigits: 6}))}\n` +
                                            `🔹 *Объем \\(24ч\\):* $${escapeMarkdown(Math.round(currentVolume).toLocaleString('en-US'))}`;

                            if (contractAddress) {
                                messageText += `\n\n📝 *Контракт:*\n\`${contractAddress}\``;
                            } else {
                                console.log(`  -> Адрес контракта для ${coinSymbol} не найден (возможно, из-за ошибки API). Сигнал все равно отправляется.`);
                            }
                            
                            await sendTelegramMessage(messageText);

                            sentSymbolsInThisRun.add(coinSymbol);
                        } else {
                            console.log(`  -> Сигнал для ${coinSymbol} уже был отправлен в этой итерации. Пропускаем.`);
                        }
                    }
                }
            }
            await insertData(coinId, networkName, currentPrice, currentVolume);
        }
    }

    await cleanupOldData();
    console.log(`[${new Date().toISOString()}] Скрипт завершил работу.`);
}

main().catch(err => {
    console.error("Произошла критическая ошибка в главной функции:", err);
    process.exit(1);
});

// Полные тексты неизмененных функций для удобства копирования
async function setupDatabase() {
    const client = await dbPool.connect();
    try {
        await client.query(`CREATE TABLE IF NOT EXISTS coin_data (id SERIAL PRIMARY KEY, coin_id VARCHAR(100) NOT NULL, network VARCHAR(50) NOT NULL, price DOUBLE PRECISION NOT NULL, volume DOUBLE PRECISION NOT NULL, timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_coin_network_time ON coin_data (coin_id, network, timestamp DESC);`);
        console.log("Проверка таблицы в БД выполнена.");
    } catch (err) {
        console.error("Ошибка при настройке БД:", err);
    } finally {
        client.release();
    }
}

async function getPreviousData(coinId, network) {
    try {
        const res = await dbPool.query(`SELECT price, volume FROM coin_data WHERE coin_id = $1 AND network = $2 ORDER BY timestamp DESC LIMIT 1;`, [coinId, network]);
        return res.rows[0];
    } catch (err) {
        console.error(`Ошибка получения предыдущих данных для ${coinId}:`, err);
        return null;
    }
}

async function insertData(coinId, network, price, volume) {
    try {
        await dbPool.query(`INSERT INTO coin_data (coin_id, network, price, volume) VALUES ($1, $2, $3, $4);`, [coinId, network, price, volume]);
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

function escapeMarkdown(text) {
    const chars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
    return String(text).replace(new RegExp(`[${chars.join('\\')}]`, 'g'), '\\$&');
}

async function sendTelegramMessage(message) {
    try {
        await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'MarkdownV2' });
        console.log("Сообщение успешно отправлено в Telegram.");
    } catch (err) {
        console.error("Ошибка отправки сообщения в Telegram:", err.response ? JSON.stringify(err.response, null, 2) : err);
    }
}