"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// index.ts - Гибридная система: CoinGecko (минимум) + Helius (активно)
const dotenv_1 = require("dotenv");
const database_1 = require("./database");
const telegram_1 = require("./telegram");
const jupiter_1 = require("./jupiter");
const coingecko_1 = require("./coingecko");
const token_analyzer_1 = require("./token-analyzer");
const helius_1 = require("./helius");
const diagnostics_1 = require("./diagnostics");
const utils_1 = require("./utils");
(0, dotenv_1.config)();
// Проверяем обязательные переменные окружения
const requiredEnvVars = [
    'DATABASE_URL',
    'TELEGRAM_TOKEN',
    'TELEGRAM_CHAT_ID',
    'COINGECKO_API_KEY',
    'HELIUS_API_KEY'
];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`❌ Missing required environment variable: ${envVar}`);
        process.exit(1);
    }
}
// Инициализация компонентов
const db = new database_1.Database(process.env.DATABASE_URL);
const tg = new telegram_1.TelegramBot(process.env.TELEGRAM_TOKEN, process.env.TELEGRAM_CHAT_ID);
const jupiter = new jupiter_1.JupiterAPI();
const coingecko = new coingecko_1.CoinGeckoAPI(process.env.COINGECKO_API_KEY);
const helius = new helius_1.HeliusWebSocket(process.env.HELIUS_API_KEY, db, tg);
// Конфигурация анализа из переменных окружения
const analysisConfig = {
    minTokenAgeDays: parseInt(process.env.MIN_TOKEN_AGE_DAYS || '14'),
    minLiquidityUsd: parseInt(process.env.MIN_LIQUIDITY_USD || '10000'),
    maxFdvUsd: parseInt(process.env.MAX_FDV_USD || '5000000'),
    minVolumeSpike: parseFloat(process.env.MIN_VOLUME_SPIKE || '3'),
    maxRsiOversold: parseInt(process.env.MAX_RSI_OVERSOLD || '35'),
    maxPriceImpactPercent: parseFloat(process.env.MAX_PRICE_IMPACT_PERCENT || '3'),
    priceImpactTestAmount: parseFloat(process.env.PRICE_IMPACT_TEST_AMOUNT || '10')
};
const tokenAnalyzer = new token_analyzer_1.TokenAnalyzer(coingecko, jupiter, db, analysisConfig);
// Инициализируем систему диагностики
let diagnostics;
// Статистика использования API
let apiUsageStats = {
    coingecko: {
        dailyUsage: 0,
        monthlyLimit: 10000,
        lastReset: new Date().toDateString()
    },
    helius: {
        dailyUsage: 0,
        monthlyLimit: 1000000,
        lastReset: new Date().toDateString()
    }
};
/**
 * Обновление списка токенов каждые 48 часов (сначала база, потом CoinGecko)
 */
async function tokenRefresh() {
    try {
        (0, utils_1.log)('🔄 Token refresh starting (48h cycle)...');
        // Сначала очищаем старые данные из coin_data (старше 72 часов)
        await db.cleanupOldCoinData(72);
        // Проверяем лимиты CoinGecko
        const today = new Date().toDateString();
        if (apiUsageStats.coingecko.lastReset !== today) {
            apiUsageStats.coingecko.dailyUsage = 0;
            apiUsageStats.coingecko.lastReset = today;
        }
        if (apiUsageStats.coingecko.dailyUsage >= 300) { // Оставляем запас
            (0, utils_1.log)('⚠️ CoinGecko daily limit reached, skipping refresh');
            return;
        }
        // Получаем топ токены для мониторинга (сначала из базы, потом из CoinGecko)
        const tokens = await tokenAnalyzer.getTopTokensForMonitoring();
        // Увеличиваем счетчик только если реально использовали CoinGecko
        // (TokenAnalyzer сам решает - база или CoinGecko)
        (0, utils_1.log)(`✅ Token refresh complete: ${tokens.length} tokens ready for monitoring`);
        // Отправляем отчет
        await sendTokenRefreshReport(tokens.length);
    }
    catch (error) {
        (0, utils_1.log)(`❌ Error in token refresh: ${error}`, 'ERROR');
        await tg.sendErrorMessage(`Token Refresh Error: ${error}`);
    }
}
/**
 * Обработка сигналов от Helius WebSocket
 */
async function handleHeliusSignal(mint, swapData) {
    try {
        // Анализируем активность токена
        const result = await tokenAnalyzer.analyzeTokenActivity(mint, swapData);
        if (result && result.isSignal) {
            // Сохраняем сигнал в базу данных
            await db.createSignal(result.mint, true, // is_buy
            result.data.volumeSpike || 0, result.data.rsi || 0);
            // Отправляем уведомление в Telegram
            await sendSignalNotification(result);
            (0, utils_1.log)(`✅ Signal processed: ${result.symbol} (${result.mint})`);
        }
    }
    catch (error) {
        (0, utils_1.log)(`❌ Error processing Helius signal: ${error}`, 'ERROR');
    }
}
/**
 * Отправка уведомления о сигнале
 */
async function sendSignalNotification(signal) {
    try {
        const message = `🚀 **BUY SIGNAL DETECTED** 🚀

💎 **${signal.symbol}** (${signal.name})
📍 Mint: \`${signal.mint}\`

📊 **Analysis Results:**
• Volume Spike: ${signal.data.volumeSpike?.toFixed(2)}x
• RSI: ${signal.data.rsi?.toFixed(2)}
• EMA Signal: ${signal.data.emaSignal ? '✅' : '❌'}
• Price Impact: ${signal.data.priceImpact?.toFixed(2)}%
• Liquidity: $${signal.data.liquidity?.toLocaleString()}

💰 **Market Data:**
• Price: $${signal.data.priceUsd?.toFixed(6)}
• Market Cap: $${signal.data.marketCap?.toLocaleString()}
• FDV: $${signal.data.fdv?.toLocaleString()}
• Volume 24h: $${signal.data.volume24h?.toLocaleString()}

⚡ **All criteria met - Ready to trade!**`;
        await tg.sendMessage(message);
    }
    catch (error) {
        (0, utils_1.log)(`Error sending signal notification: ${error}`, 'ERROR');
    }
}
/**
 * Отчет об обновлении токенов (каждые 48 часов)
 */
async function sendTokenRefreshReport(tokensCount) {
    try {
        const message = `📊 **Token Refresh Report (48h cycle)**

🔄 **System Status:**
• Monitored Tokens: ${tokensCount}
• Analysis Mode: Hybrid (CoinGecko + Helius)
• Status: Active 🟢

📈 **API Usage:**
• CoinGecko: ${apiUsageStats.coingecko.dailyUsage}/280 daily
• Helius: ${apiUsageStats.helius.dailyUsage}/33,333 daily

⚙️ **Configuration:**
• Min Age: ${analysisConfig.minTokenAgeDays} days
• Min Liquidity: $${analysisConfig.minLiquidityUsd.toLocaleString()}
• Max FDV: $${analysisConfig.maxFdvUsd.toLocaleString()}
• Min Volume Spike: ${analysisConfig.minVolumeSpike}x
• Max RSI Oversold: ${analysisConfig.maxRsiOversold}
• Max Price Impact: ${analysisConfig.maxPriceImpactPercent}%
• Test Amount: $${analysisConfig.priceImpactTestAmount}

🎯 **Next token refresh in ~48 hours**
💡 **Optimization:** Top-2000 tokens updated every 48h (more stable, saves API credits)`;
        await tg.sendMessage(message);
    }
    catch (error) {
        (0, utils_1.log)(`Error sending daily report: ${error}`, 'ERROR');
    }
}
/**
 * Инициализация системы
 */
async function initialize() {
    try {
        (0, utils_1.log)('🚀 Initializing Hybrid Solana Signal Bot...');
        // Отправляем уведомление о начале инициализации
        await tg.sendMessage(`🚀 **Signal Bot Starting...**

⚙️ **Initialization in progress...**
• Database connection: Connecting...
• API testing: Starting...
• Token loading: Preparing...

📡 **Status:** Initializing services...`);
        // Инициализация базы данных
        await db.initialize();
        (0, utils_1.log)('✅ Database initialized');
        // Инициализация диагностики
        diagnostics = new diagnostics_1.DiagnosticsSystem(db, tg);
        (0, utils_1.log)('✅ Diagnostics system initialized');
        // Тестирование CoinGecko API
        (0, utils_1.log)('🧪 Testing CoinGecko API...');
        let coingeckoStatus = '❌ Failed';
        try {
            const testTokens = await coingecko.getTopSolanaTokens(10);
            coingeckoStatus = `✅ Working (${testTokens.length} tokens)`;
            (0, utils_1.log)(`✅ CoinGecko API working - fetched ${testTokens.length} test tokens`);
        }
        catch (error) {
            (0, utils_1.log)(`❌ CoinGecko API test failed: ${error}`, 'ERROR');
        }
        // Тестирование Jupiter API
        (0, utils_1.log)('🧪 Testing Jupiter API...');
        let jupiterStatus = '❌ Failed';
        try {
            const testQuote = await jupiter.getQuote('So11111111111111111111111111111111111111112', // SOL
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (правильный адрес)
            1000000000 // 1 SOL
            );
            jupiterStatus = testQuote ? '✅ Working' : '⚠️ No quote';
            (0, utils_1.log)(`✅ Jupiter API working - got quote: ${testQuote ? 'success' : 'failed'}`);
        }
        catch (error) {
            (0, utils_1.log)(`❌ Jupiter API test failed: ${error}`, 'ERROR');
        }
        // Первоначальная загрузка токенов
        let tokensLoaded = 0;
        let tokenStatus = '❌ Failed';
        try {
            await tokenRefresh();
            tokensLoaded = tokenAnalyzer.getMonitoredTokens().length;
            tokenStatus = tokensLoaded > 0 ? `✅ ${tokensLoaded} tokens` : '⚠️ No tokens';
        }
        catch (error) {
            (0, utils_1.log)(`❌ Token refresh failed: ${error}`, 'ERROR');
            tokenStatus = `❌ Error: ${error}`;
        }
        // Настройка Helius WebSocket с обработчиком сигналов
        helius.onSwap = handleHeliusSignal;
        // Запуск Helius WebSocket
        let heliusStatus = '❌ Failed';
        try {
            await helius.connect();
            heliusStatus = '✅ Connected';
            (0, utils_1.log)('✅ Helius WebSocket connected');
        }
        catch (error) {
            (0, utils_1.log)(`❌ Helius WebSocket failed: ${error}`, 'ERROR');
            heliusStatus = `❌ Error: ${error}`;
        }
        // Отправляем детальное уведомление о статусе запуска
        const systemStatus = (tokensLoaded > 0 && coingeckoStatus.includes('✅') && heliusStatus.includes('✅')) ? '🟢 OPERATIONAL' : '🟡 PARTIAL';
        await tg.sendMessage(`🚀 **Hybrid Solana Signal Bot Started!**

📊 **System Status:** ${systemStatus}

🔧 **Component Status:**
• Database: ✅ Connected
• CoinGecko API: ${coingeckoStatus}
• Jupiter API: ${jupiterStatus}
• Helius WebSocket: ${heliusStatus}
• Token Loading: ${tokenStatus}

📈 **Configuration:**
• Analysis Mode: CoinGecko + Helius
• Strategy: 48h token refresh + Real-time monitoring
• Monitoring: ${tokensLoaded} tokens

💡 **API Optimization:**
• CoinGecko: 48h refresh cycle (saves credits)
• Helius: Real-time monitoring (uses available credits)

${tokensLoaded > 0 ? '🔍 **Ready for signal detection!**' : '⚠️ **Limited functionality - token loading issues**'}

⏰ Started at: ${new Date().toLocaleString()}`);
        (0, utils_1.log)('✅ Hybrid initialization complete');
    }
    catch (error) {
        (0, utils_1.log)(`❌ Initialization failed: ${error}`, 'ERROR');
        // Отправляем уведомление об ошибке инициализации
        await tg.sendMessage(`🚨 **Signal Bot Initialization Failed!**

❌ **Error:** ${error}

🔧 **Status:** System failed to start properly
⚠️ **Action Required:** Check logs and restart

⏰ Failed at: ${new Date().toLocaleString()}`);
        throw error;
    }
}
/**
 * Запуск системы
 */
async function start() {
    try {
        await initialize();
        // Планируем обновление токенов каждые 48 часов
        setInterval(tokenRefresh, 48 * 60 * 60 * 1000);
        // Планируем очистку старых данных (каждые 24 часа)
        setInterval(async () => {
            try {
                await db.cleanupOldCoinData(72); // Очищаем данные старше 72 часов
            }
            catch (error) {
                (0, utils_1.log)(`Error in cleanup: ${error}`, 'ERROR');
            }
        }, 24 * 60 * 60 * 1000);
        // Планируем диагностику (каждые 10 минут)
        setInterval(async () => {
            try {
                await diagnostics.runDiagnostics();
            }
            catch (error) {
                (0, utils_1.log)(`Error in diagnostics: ${error}`, 'ERROR');
            }
        }, 10 * 60 * 1000);
        // Планируем отчеты об активности (каждые 12 часов)
        setInterval(async () => {
            try {
                const monitoredCount = tokenAnalyzer.getMonitoredTokens().length;
                await sendTokenRefreshReport(monitoredCount);
            }
            catch (error) {
                (0, utils_1.log)(`Error in activity report: ${error}`, 'ERROR');
            }
        }, 12 * 60 * 60 * 1000);
        // Планируем WebSocket отчеты (каждые 10 минут)
        setInterval(async () => {
            try {
                await helius.sendWebSocketActivityReport();
            }
            catch (error) {
                (0, utils_1.log)(`Error in WebSocket activity report: ${error}`, 'ERROR');
            }
        }, 10 * 60 * 1000);
        (0, utils_1.log)('🎯 Hybrid Signal Bot is running...');
    }
    catch (error) {
        (0, utils_1.log)(`❌ Failed to start: ${error}`, 'ERROR');
        process.exit(1);
    }
}
// Обработка сигналов завершения
process.on('SIGINT', async () => {
    (0, utils_1.log)('🛑 Shutting down Hybrid Signal Bot...');
    // Отправляем уведомление об остановке
    try {
        await tg.sendMessage(`🛑 **Signal Bot Shutting Down**

⚠️ **Manual shutdown detected (SIGINT)**
🔄 **Status:** Gracefully stopping all services...

📊 **Final Stats:**
• Uptime: ${Math.floor(process.uptime() / 60)} minutes
• Monitored Tokens: ${tokenAnalyzer.getMonitoredTokens().length}
• API Usage: CoinGecko ${apiUsageStats.coingecko.dailyUsage}/333

🔌 **Disconnecting services...**`);
    }
    catch (error) {
        (0, utils_1.log)(`Error sending shutdown notification: ${error}`, 'ERROR');
    }
    await helius.disconnect();
    await db.close();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    (0, utils_1.log)('🛑 Shutting down Hybrid Signal Bot...');
    // Отправляем уведомление об остановке
    try {
        await tg.sendMessage(`🛑 **Signal Bot Shutting Down**

⚠️ **System shutdown detected (SIGTERM)**
🔄 **Status:** Gracefully stopping all services...

📊 **Final Stats:**
• Uptime: ${Math.floor(process.uptime() / 60)} minutes
• Monitored Tokens: ${tokenAnalyzer.getMonitoredTokens().length}
• API Usage: CoinGecko ${apiUsageStats.coingecko.dailyUsage}/333

🔌 **Disconnecting services...**`);
    }
    catch (error) {
        (0, utils_1.log)(`Error sending shutdown notification: ${error}`, 'ERROR');
    }
    await helius.disconnect();
    await db.close();
    process.exit(0);
});
// Запуск
start().catch(console.error);
