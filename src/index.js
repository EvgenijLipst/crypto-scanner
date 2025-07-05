"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// index.ts - Main orchestration for Solana Signal Bot with CoinGecko integration
const dotenv_1 = require("dotenv");
const database_1 = require("./database");
const telegram_1 = require("./telegram");
const jupiter_1 = require("./jupiter");
const coingecko_1 = require("./coingecko");
const token_analyzer_1 = require("./token-analyzer");
const diagnostics_1 = require("./diagnostics");
const utils_1 = require("./utils");
(0, dotenv_1.config)();
// Проверяем обязательные переменные окружения
const requiredEnvVars = [
    'DATABASE_URL',
    'TELEGRAM_TOKEN',
    'TELEGRAM_CHAT_ID',
    'COINGECKO_API_KEY'
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
/**
 * Основной цикл анализа токенов
 */
async function runTokenAnalysis() {
    try {
        (0, utils_1.log)('🔍 Starting token analysis cycle...');
        // Анализируем топ токены
        const signals = await tokenAnalyzer.analyzeTopTokens();
        if (signals.length === 0) {
            (0, utils_1.log)('No signals found in this cycle');
            return;
        }
        (0, utils_1.log)(`📊 Found ${signals.length} signals:`);
        // Обрабатываем каждый сигнал
        for (const signal of signals) {
            try {
                // Сохраняем сигнал в базу данных
                await db.createSignal(signal.mint, true, // is_buy
                signal.data.volumeSpike || 0, signal.data.rsi || 0);
                // Отправляем уведомление в Telegram
                await sendSignalNotification(signal);
                (0, utils_1.log)(`✅ Signal processed: ${signal.symbol} (${signal.mint})`);
            }
            catch (error) {
                (0, utils_1.log)(`❌ Error processing signal ${signal.symbol}: ${error}`, 'ERROR');
            }
        }
    }
    catch (error) {
        (0, utils_1.log)(`❌ Error in token analysis: ${error}`, 'ERROR');
        await tg.sendErrorMessage(`Token Analysis Error: ${error}`);
    }
}
/**
 * Отправить уведомление о сигнале
 */
async function sendSignalNotification(signal) {
    try {
        const message = formatSignalMessage(signal);
        await tg.sendMessage(message);
    }
    catch (error) {
        (0, utils_1.log)(`Error sending signal notification: ${error}`, 'ERROR');
    }
}
/**
 * Форматировать сообщение о сигнале
 */
function formatSignalMessage(signal) {
    const { symbol, name, mint, data: { age, marketCap, fdv, volume24h, priceUsd, volumeSpike, rsi, priceImpact, liquidity } } = signal;
    return `🚀 BUY SIGNAL DETECTED

📊 ${symbol} (${name})
🏷️ Mint: ${mint}

📈 Technical Analysis:
• Volume Spike: ${volumeSpike?.toFixed(2)}x
• RSI: ${rsi?.toFixed(1)}
• EMA 9/21: Crossed Up ✅

💰 Fundamentals:
• Price: $${priceUsd?.toFixed(6)}
• Market Cap: $${(marketCap / 1000000).toFixed(2)}M
• FDV: $${(fdv / 1000000).toFixed(2)}M
• Volume 24h: $${(volume24h / 1000).toFixed(0)}k
• Age: ${age} days

🔄 Liquidity Test:
• Liquidity: $${liquidity?.toFixed(0)}
• Price Impact: ${priceImpact?.toFixed(2)}%

⚡ All criteria met - Ready to trade!`;
}
/**
 * Отправить отчет о активности
 */
async function sendActivityReport() {
    try {
        const config = tokenAnalyzer.getConfig();
        const uptime = Math.floor(process.uptime() / 60);
        const report = `📊 Token Analysis Report

⚙️ Configuration:
• Min Age: ${config.minTokenAgeDays} days
• Min Liquidity: $${config.minLiquidityUsd.toLocaleString()}
• Max FDV: $${config.maxFdvUsd.toLocaleString()}
• Min Volume Spike: ${config.minVolumeSpike}x
• Max RSI Oversold: ${config.maxRsiOversold}
• Max Price Impact: ${config.maxPriceImpactPercent}%
• Test Amount: $${config.priceImpactTestAmount}

🕐 System Status:
• Uptime: ${uptime} minutes
• Analysis Mode: CoinGecko Top 2000
• Status: Active 🟢

💡 Next analysis in ~10 minutes`;
        await tg.sendMessage(report);
    }
    catch (error) {
        (0, utils_1.log)(`Error sending activity report: ${error}`, 'ERROR');
    }
}
/**
 * Инициализация системы
 */
async function initialize() {
    try {
        (0, utils_1.log)('🚀 Initializing Solana Signal Bot...');
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
        // Отправляем уведомление о запуске
        await tg.sendMessage('🚀 Solana Signal Bot started!\n\n📊 Analysis Mode: CoinGecko Top 2000\n⚙️ Monitoring for buy signals...');
        (0, utils_1.log)('✅ Initialization complete');
    }
    catch (error) {
        (0, utils_1.log)(`❌ Initialization failed: ${error}`, 'ERROR');
        throw error;
    }
}
/**
 * Главная функция
 */
async function main() {
    try {
        // Инициализация
        await initialize();
        // Запуск периодических задач
        // Анализ токенов каждые 10 минут
        setInterval(runTokenAnalysis, 10 * 60 * 1000);
        // Отчет о активности каждые 30 минут
        setInterval(sendActivityReport, 30 * 60 * 1000);
        // Диагностика каждые 5 минут
        setInterval(async () => {
            try {
                await diagnostics.runDiagnostics();
            }
            catch (error) {
                (0, utils_1.log)(`Diagnostics error: ${error}`, 'ERROR');
            }
        }, 5 * 60 * 1000);
        // Первый запуск через 30 секунд
        setTimeout(runTokenAnalysis, 30 * 1000);
        setTimeout(sendActivityReport, 2 * 60 * 1000); // Первый отчет через 2 минуты
        setTimeout(async () => {
            try {
                await diagnostics.runDiagnostics();
            }
            catch (error) {
                (0, utils_1.log)(`Initial diagnostics error: ${error}`, 'ERROR');
            }
        }, 30 * 1000);
        (0, utils_1.log)('🎯 All systems running - monitoring for signals...');
    }
    catch (error) {
        (0, utils_1.log)(`❌ Fatal error: ${error}`, 'ERROR');
        await tg.sendErrorMessage(`Fatal Error: ${error}`);
        process.exit(1);
    }
}
// Обработка сигналов завершения
process.on('SIGINT', async () => {
    (0, utils_1.log)('🛑 Received SIGINT, shutting down gracefully...');
    await tg.sendMessage('🛑 Solana Signal Bot shutting down...');
    process.exit(0);
});
process.on('SIGTERM', async () => {
    (0, utils_1.log)('🛑 Received SIGTERM, shutting down gracefully...');
    await tg.sendMessage('🛑 Solana Signal Bot shutting down...');
    process.exit(0);
});
// Запуск
main().catch(async (error) => {
    (0, utils_1.log)(`❌ Unhandled error: ${error}`, 'ERROR');
    try {
        await tg.sendErrorMessage(`Unhandled Error: ${error}`);
    }
    catch (e) {
        (0, utils_1.log)(`❌ Failed to send error message: ${e}`, 'ERROR');
    }
    process.exit(1);
});
