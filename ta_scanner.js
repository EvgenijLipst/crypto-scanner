// ta_scanner.js (ВЕРСИЯ 2.1: ПОДКЛЮЧЕН КЛЮЧ COINGECKO API)
const axios = require('axios');
const { Pool } = require('pg');
const { SMA, EMA, RSI } = require('technicalindicators');

const CONFIG = {
    topCoinsToFetch: 500,
    priceChangeThreshold: 3,
    volumeChangeThreshold: 15,
    smaPeriod: 50,
    emaPeriod: 20,
    rsiPeriod: 14,
    dbCleanupHours: 24,
    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID,
    }
};

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const runScanner = async () => {
    console.log('Запуск сканера...');
    await setupDatabase();
    console.log(`1. Получение топ-${CONFIG.topCoinsToFetch} токенов по капитализации...`);
    const marketData = await getTopMarketData(CONFIG.topCoinsToFetch);
    
    if (!marketData || marketData.length === 0) {
        console.error("Не удалось получить рыночные данные. Завершение работы.");
        return;
    }
    console.log(`Найдено ${marketData.length} токенов для анализа.`);
    console.log('2. Сохранение данных в базу...');
    await saveMarketData(marketData);
    console.log('3. Запуск анализа для каждого токена...');
    for (const tokenData of marketData) {
        await analyzeToken(tokenData);
    }
    console.log('4. Очистка старых данных...');
    await cleanupOldData();
};

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

async function getTopMarketData(limit) {
    const marketData = [];
    const perPage = 250;
    const totalPages = Math.ceil(limit / perPage);

    // --- ИЗМЕНЕНИЕ ЗДЕСЬ ---
    const coingeckoApiKey = process.env.COINGECKO_API_KEY;
    if (coingeckoApiKey) {
        console.log('Используется персональный ключ CoinGecko API.');
    } else {
        console.log('Персональный ключ CoinGecko API не найден, используются публичные лимиты.');
    }

    for (let page = 1; page <= totalPages; page++) {
        try {
            let url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${page}&sparkline=false`;
            
            // --- И ИЗМЕНЕНИЕ ЗДЕСЬ ---
            // Если ключ есть, добавляем его к запросу. Pro-ключи передаются как заголовок.
            const headers = {};
            if (coingeckoApiKey) {
                headers['x-cg-pro-api-key'] = coingeckoApiKey;
            }

            const { data } = await axios.get(url, { headers });
            marketData.push(...data);

        } catch (error) {
            console.error(`Ошибка при получении страницы ${page} рыночных данных:`, error.message);
        }
        await new Promise(res => setTimeout(res, 1000));
    }
    return marketData;
}


async function saveMarketData(marketData) {
    let savedCount = 0;
    for (const token of marketData) {
        if (token.id && token.current_price !== null && token.total_volume !== null) {
            try {
                await pool.query(
                    `INSERT INTO token_market_data(coingecko_id, symbol, price_usd, volume_24h_usd) VALUES($1, $2, $3, $4)`,
                    [token.id, token.symbol.toUpperCase(), token.current_price, token.total_volume]
                );
                savedCount++;
            } catch(e) {
                if (e.code !== '23505') { 
                    console.error(`Ошибка при сохранении ${token.id}: ${e.message}`);
                }
            }
        }
    }
    console.log(`Сохранено ${savedCount} новых записей.`);
}

async function analyzeToken(currentTokenData) {
    try {
        const { rows: history } = await pool.query(
            `SELECT price_usd, volume_24h_usd FROM token_market_data WHERE coingecko_id = $1 ORDER BY timestamp DESC LIMIT 100`,
            [currentTokenData.id]
        );

        if (history.length < 2) {
            return;
        }

        const currentPrice = parseFloat(history[0].price_usd);
        const previousPrice = parseFloat(history[1].price_usd);
        const currentVolume = parseFloat(history[0].volume_24h_usd);
        const previousVolume = parseFloat(history[1].volume_24h_usd);
        
        if (!currentPrice || !previousPrice || !currentVolume || !previousVolume) {
            return;
        }

        const priceChange = ((currentPrice - previousPrice) / previousPrice) * 100;
        const volumeChange = ((currentVolume - previousVolume) / previousVolume) * 100;

        if (priceChange >= CONFIG.priceChangeThreshold && volumeChange >= CONFIG.volumeChangeThreshold) {
            console.log(`[ПЕРВИЧНЫЙ СИГНАЛ] для ${currentTokenData.symbol.toUpperCase()}: Рост цены ${priceChange.toFixed(2)}%, Рост объема ${volumeChange.toFixed(2)}%`);
            
            const prices = history.map(row => parseFloat(row.price_usd)).reverse();
            if (prices.length < CONFIG.smaPeriod || prices.length < CONFIG.rsiPeriod) {
                console.log(`[INFO] Недостаточно данных для полного ТА для ${currentTokenData.symbol.toUpperCase()}`);
                return;
            }

            const sma50 = SMA.calculate({ period: CONFIG.smaPeriod, values: prices });
            const ema20 = EMA.calculate({ period: CONFIG.emaPeriod, values: prices });
            const rsi = RSI.calculate({ period: CONFIG.rsiPeriod, values: prices });
            
            const lastSma50 = sma50[sma50.length - 1];
            const lastEma20 = ema20[ema20.length - 1];
            const lastRsi = rsi[rsi.length - 1];

            console.log(`[TA-ДАННЫЕ] для ${currentTokenData.symbol.toUpperCase()}: Цена=${currentPrice.toFixed(4)}, SMA50=${lastSma50.toFixed(4)}, EMA20=${lastEma20.toFixed(4)}, RSI=${lastRsi.toFixed(2)}`);

            const smaCrossover = currentPrice > lastSma50;
            const emaCrossover = currentPrice > lastEma20;
            const rsiInRange = lastRsi > 40 && lastRsi < 70;

            if ((smaCrossover || emaCrossover) && rsiInRange) {
                console.log(`[!!!] ПОЛНЫЙ СИГНАЛ для ${currentTokenData.symbol.toUpperCase()}. Отправка в Telegram...`);
                const message = `
                📈 **Сигнал по токену: ${currentTokenData.symbol.toUpperCase()}**
                -----------------------------------
                **Цена:** $${currentPrice.toFixed(4)}
                **Рост цены (15 мин):** ${priceChange.toFixed(2)}%
                **Рост объема (15 мин):** ${volumeChange.toFixed(2)}%
                -----------------------------------
                **SMA50:** ${lastSma50.toFixed(4)} (пробит: ${smaCrossover})
                **EMA20:** ${lastEma20.toFixed(4)} (пробит: ${emaCrossover})
                **RSI:** ${lastRsi.toFixed(2)} (в норме: ${rsiInRange})
                `;
                await sendTelegramMessage(message);
            } else {
                console.log(`[INFO] Первичный триггер для ${currentTokenData.symbol.toUpperCase()} сработал, но ТА не подтвержден.`);
            }
        }
    } catch (error) {
        console.error(`Ошибка при анализе токена ${currentTokenData.symbol}:`, error.message);
    }
}

async function cleanupOldData() {
    const {rowCount} = await pool.query(`DELETE FROM token_market_data WHERE timestamp < NOW() - INTERVAL '${CONFIG.dbCleanupHours} hours'`);
    console.log(`Очистка старых рыночных данных завершена. Удалено ${rowCount} записей.`);
}

async function sendTelegramMessage(text) {
    const { botToken, chatId } = CONFIG.telegram;
    if (!botToken || !chatId) {
        console.warn('Переменные для Telegram не настроены.');
        return;
    }
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    try {
        await axios.post(url, { chat_id: chatId, text, parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Ошибка отправки сообщения в Telegram:', error.message);
    }
}

runScanner()
    .then(() => console.log('Сканирование завершено.'))
    .catch(e => console.error('Критическая ошибка сканера:', e))
    .finally(() => {
        pool.end();
        console.log('Соединение с базой данных закрыто.');
    });