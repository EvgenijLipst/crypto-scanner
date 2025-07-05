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
    'HELIUS_KEY'
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
const helius = new helius_1.HeliusWebSocket(process.env.HELIUS_KEY, db, tg);
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
 * Ежедневное обновление списка токенов (CoinGecko - минимум)
 */
async function dailyTokenRefresh() {
    try {
        (0, utils_1.log)('🔄 Daily token refresh starting...');
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
        // Получаем топ токены для мониторинга
        const tokens = await tokenAnalyzer.getTopTokensForMonitoring();
        apiUsageStats.coingecko.dailyUsage += 5; // Примерно 5 запросов на обновление
        (0, utils_1.log)(`✅ Daily refresh complete: ${tokens.length} tokens ready for monitoring`);
        // Отправляем отчет
        await sendDailyReport(tokens.length);
    }
    catch (error) {
        (0, utils_1.log)(`❌ Error in daily token refresh: ${error}`, 'ERROR');
        await tg.sendErrorMessage(`Daily Token Refresh Error: ${error}`);
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
 * Ежедневный отчет
 */
async function sendDailyReport(tokensCount) {
    try {
        const message = `📊 **Daily Token Analysis Report**

🔄 **System Status:**
• Monitored Tokens: ${tokensCount}
• Analysis Mode: Hybrid (CoinGecko + Helius)
• Status: Active 🟢

📈 **API Usage:**
• CoinGecko: ${apiUsageStats.coingecko.dailyUsage}/333 daily
• Helius: ${apiUsageStats.helius.dailyUsage}/33,333 daily

⚙️ **Configuration:**
• Min Age: ${analysisConfig.minTokenAgeDays} days
• Min Liquidity: $${analysisConfig.minLiquidityUsd.toLocaleString()}
• Max FDV: $${analysisConfig.maxFdvUsd.toLocaleString()}
• Min Volume Spike: ${analysisConfig.minVolumeSpike}x
• Max RSI Oversold: ${analysisConfig.maxRsiOversold}
• Max Price Impact: ${analysisConfig.maxPriceImpactPercent}%
• Test Amount: $${analysisConfig.priceImpactTestAmount}

🎯 **Next daily refresh in ~24 hours**`;
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
        // Инициализация базы данных
        await db.initialize();
        (0, utils_1.log)('✅ Database initialized');
        // Инициализация диагностики
        diagnostics = new diagnostics_1.DiagnosticsSystem(db, tg);
        (0, utils_1.log)('✅ Diagnostics system initialized');
        // Тестирование CoinGecko API
        (0, utils_1.log)('🧪 Testing CoinGecko API...');
        const testTokens = await coingecko.getTopSolanaTokens(10);
        (0, utils_1.log)(`✅ CoinGecko API working - fetched ${testTokens.length} test tokens`);
        // Тестирование Jupiter API
        (0, utils_1.log)('🧪 Testing Jupiter API...');
        const testQuote = await jupiter.getQuote('So11111111111111111111111111111111111111112', // SOL
        'EPjFWdd5AufqSSqeM2qA9G4KJ9b9wiG9vG7bG6wGw7bS', // USDC
        1000000000 // 1 SOL
        );
        (0, utils_1.log)(`✅ Jupiter API working - got quote: ${testQuote ? 'success' : 'failed'}`);
        // Первоначальная загрузка токенов
        await dailyTokenRefresh();
        // Настройка Helius WebSocket с обработчиком сигналов
        helius.onSwap = handleHeliusSignal;
        // Запуск Helius WebSocket
        await helius.connect();
        (0, utils_1.log)('✅ Helius WebSocket connected');
        // Отправляем уведомление о запуске
        await tg.sendMessage(`🚀 **Hybrid Solana Signal Bot Started!**

📊 **Analysis Mode:** CoinGecko + Helius
🎯 **Strategy:** Daily token refresh + Real-time monitoring
⚙️ **Monitoring:** ${tokenAnalyzer.getMonitoredTokens().length} tokens

💡 **API Optimization:**
• CoinGecko: Once daily refresh (saves credits)
• Helius: Real-time monitoring (uses available credits)

🔍 **Ready for signal detection!**`);
        (0, utils_1.log)('✅ Hybrid initialization complete');
    }
    catch (error) {
        (0, utils_1.log)(`❌ Initialization failed: ${error}`, 'ERROR');
        throw error;
    }
}
/**
 * Запуск системы
 */
async function start() {
    try {
        await initialize();
        // Планируем ежедневное обновление токенов (раз в 24 часа)
        setInterval(dailyTokenRefresh, 24 * 60 * 60 * 1000);
        // Планируем диагностику (каждые 10 минут)
        setInterval(async () => {
            try {
                await diagnostics.runDiagnostics();
            }
            catch (error) {
                (0, utils_1.log)(`Error in diagnostics: ${error}`, 'ERROR');
            }
        }, 10 * 60 * 1000);
        // Планируем отчеты об активности (каждые 6 часов)
        setInterval(async () => {
            try {
                const monitoredCount = tokenAnalyzer.getMonitoredTokens().length;
                await sendDailyReport(monitoredCount);
            }
            catch (error) {
                (0, utils_1.log)(`Error in activity report: ${error}`, 'ERROR');
            }
        }, 6 * 60 * 60 * 1000);
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
    await helius.disconnect();
    await db.close();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    (0, utils_1.log)('🛑 Shutting down Hybrid Signal Bot...');
    await helius.disconnect();
    await db.close();
    process.exit(0);
});
// Запуск
start().catch(console.error);
