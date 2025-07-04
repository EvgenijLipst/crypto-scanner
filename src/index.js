"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// index.ts - Main orchestration for Solana Signal Bot
const dotenv_1 = require("dotenv");
const database_1 = require("./database");
const helius_1 = require("./helius");
const telegram_1 = require("./telegram");
const jupiter_1 = require("./jupiter");
const diagnostics_1 = require("./diagnostics");
const utils_1 = require("./utils");
const indicators_1 = require("./indicators");
const types_1 = require("./types");
(0, dotenv_1.config)();
const db = new database_1.Database(process.env.DATABASE_URL);
const helius = new helius_1.HeliusWebSocket(process.env.HELIUS_KEY, db);
const tg = new telegram_1.TelegramBot(process.env.TELEGRAM_TOKEN, process.env.TELEGRAM_CHAT_ID);
const jupiter = new jupiter_1.JupiterAPI();
// Инициализируем систему диагностики
let diagnostics;
async function indicatorSweep() {
    try {
        const pools = await db.getOldPools();
        for (const pool of pools) {
            const candles = await db.getCandles(pool.mint, 40);
            if (candles.length < types_1.MIN_HISTORY_CANDLES)
                continue;
            const indicators = (0, indicators_1.calculateIndicators)(candles);
            if (!indicators)
                continue;
            if ((0, indicators_1.checkBuySignal)(indicators)) {
                await db.createSignal(pool.mint, true, indicators.volSpike, indicators.rsi);
                (0, utils_1.log)(`🚦 Signal candidate: ${pool.mint}`);
            }
        }
    }
    catch (e) {
        (0, utils_1.log)(`Error in indicatorSweep: ${e}`, 'ERROR');
        await tg.sendErrorMessage(`Indicator Sweep Error: ${e}`);
    }
}
async function notifySweep() {
    try {
        (0, utils_1.log)('🔍 Starting notifySweep...');
        (0, utils_1.log)('📋 Getting unnotified signals...');
        const signals = await db.getUnnotifiedSignals();
        (0, utils_1.log)(`📋 Found ${signals.length} unnotified signals`);
        for (const sig of signals) {
            (0, utils_1.log)(`🔍 Processing signal: ${JSON.stringify(sig)}`);
            (0, utils_1.log)(`📋 Getting pool info for mint: ${sig.mint}`);
            const pool = await db.getPool(sig.mint);
            if (!pool) {
                (0, utils_1.log)(`❌ No pool found for mint: ${sig.mint}`);
                continue;
            }
            (0, utils_1.log)(`📋 Pool info: ${JSON.stringify(pool)}`);
            if (Number(pool.liq_usd) < types_1.MIN_LIQUIDITY_USD) {
                (0, utils_1.log)(`❌ Liquidity too low: ${pool.liq_usd} < ${types_1.MIN_LIQUIDITY_USD}`);
                continue;
            }
            if (Number(pool.fdv_usd) > types_1.MAX_FDV_USD) {
                (0, utils_1.log)(`❌ FDV too high: ${pool.fdv_usd} > ${types_1.MAX_FDV_USD}`);
                continue;
            }
            // Проверка price impact через Jupiter
            (0, utils_1.log)(`🔍 Getting Jupiter quote for ${sig.mint}...`);
            const quote = await jupiter.getQuote('EPjFWdd5AufqSSqeM2qA9G4KJ9b9wiG9vG7bG6wGw7bS', sig.mint, 200 * 1e6); // USDC mint, $200
            if (!quote || Number(quote.priceImpactPct) * 100 > types_1.MAX_PRICE_IMPACT_PERCENT) {
                (0, utils_1.log)(`❌ Price impact check failed for ${sig.mint}`);
                continue;
            }
            (0, utils_1.log)(`✅ All checks passed for ${sig.mint}, sending to Telegram...`);
            // Passed all filters — send to Telegram
            await tg.sendBuySignal(sig, pool, Number(quote.priceImpactPct) * 100);
            (0, utils_1.log)(`📋 Marking signal ${sig.id} as notified...`);
            await db.markSignalNotified(sig.id);
            (0, utils_1.log)(`📢 Sent signal for ${sig.mint}`);
        }
        (0, utils_1.log)('✅ notifySweep completed successfully');
    }
    catch (e) {
        (0, utils_1.log)(`Error in notifySweep: ${e}`, 'ERROR');
        (0, utils_1.log)(`Error stack: ${e instanceof Error ? e.stack : 'No stack trace'}`, 'ERROR');
        await tg.sendErrorMessage(`Notification Sweep Error: ${e}`);
    }
}
async function runDiagnostics() {
    try {
        (0, utils_1.log)('🔧 Starting diagnostics check...');
        (0, utils_1.log)(`🔍 Diagnostics system initialized: ${!!diagnostics}`);
        const health = await diagnostics.runDiagnostics();
        (0, utils_1.log)(`🔍 Diagnostics completed: ${health.overallStatus}, found ${health.issues.length} issues`);
        // Детальное логирование каждой проблемы
        health.issues.forEach((issue, index) => {
            (0, utils_1.log)(`🚨 Issue ${index + 1}: ${issue.issue} (${issue.severity})`);
            (0, utils_1.log)(`   Description: ${issue.description}`);
            (0, utils_1.log)(`   Solution: ${issue.solution}`);
            (0, utils_1.log)(`   Has auto-fix: ${!!issue.autoFix}`);
        });
        if (health.overallStatus === 'CRITICAL') {
            const message = `🚨 **CRITICAL SYSTEM ISSUES DETECTED** 🚨\n\n` +
                `Issues found: ${health.issues.length}\n` +
                `Status: ${health.overallStatus}\n\n` +
                health.issues.map(i => `• ${i.issue}: ${i.description}`).join('\n');
            (0, utils_1.log)('📢 Sending critical diagnostics alert to Telegram');
            await tg.sendMessage(message);
        }
        else if (health.overallStatus === 'WARNING') {
            (0, utils_1.log)(`⚠️ System warnings detected: ${health.issues.length} issues`);
            // Отправляем предупреждения в Telegram только если их много
            if (health.issues.length > 3) {
                const message = `⚠️ **SYSTEM WARNINGS** ⚠️\n\n` +
                    `Issues found: ${health.issues.length}\n\n` +
                    health.issues.slice(0, 5).map(i => `• ${i.issue}: ${i.description}`).join('\n') +
                    (health.issues.length > 5 ? `\n... и еще ${health.issues.length - 5} проблем` : '');
                await tg.sendMessage(message);
            }
        }
        else {
            (0, utils_1.log)('✅ System health check passed');
        }
    }
    catch (e) {
        (0, utils_1.log)(`Error in diagnostics: ${e}`, 'ERROR');
        (0, utils_1.log)(`Diagnostics error stack: ${e instanceof Error ? e.stack : 'No stack trace'}`, 'ERROR');
        await tg.sendErrorMessage(`Diagnostics Error: ${e}`);
    }
}
async function sendWebSocketActivityReport() {
    try {
        (0, utils_1.log)('📊 Sending WebSocket Activity Report...');
        const stats = helius.getActivityStats();
        await tg.sendActivityReport(stats);
        (0, utils_1.log)('✅ WebSocket Activity Report sent successfully');
    }
    catch (e) {
        (0, utils_1.log)(`Error sending WebSocket Activity Report: ${e}`, 'ERROR');
        await tg.sendErrorMessage(`WebSocket Activity Report Error: ${e}`);
    }
}
async function main() {
    await db.initialize();
    // Инициализируем диагностику после базы данных
    diagnostics = new diagnostics_1.DiagnosticsSystem(db, tg);
    await tg.sendMessage('🚀 Signal Bot запущен с системой автодиагностики!');
    await helius.connect();
    // Основные интервалы
    setInterval(indicatorSweep, 60000);
    setInterval(notifySweep, 20000);
    // Диагностика каждые 5 минут
    setInterval(runDiagnostics, 5 * 60 * 1000);
    // WebSocket Activity Report каждые 10 минут
    setInterval(sendWebSocketActivityReport, 10 * 60 * 1000);
    // Первая диагностика через 30 секунд после запуска
    setTimeout(runDiagnostics, 30000);
    // Первый отчет о WebSocket активности через 2 минуты
    setTimeout(sendWebSocketActivityReport, 2 * 60 * 1000);
    // Очистка логов каждые 6 часов
    setInterval(() => {
        try {
            tg.cleanupTelegramLogs();
        }
        catch (e) {
            (0, utils_1.log)(`Error cleaning telegram logs: ${e}`, 'ERROR');
        }
    }, 6 * 60 * 60 * 1000); // 6 hours
    (0, utils_1.log)('Signal bot started with diagnostics system.');
}
main().catch(console.error);
