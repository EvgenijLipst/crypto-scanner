// index.ts - Main orchestration for Solana Signal Bot
import { config } from 'dotenv';
import { Database } from './database';
import { HeliusWebSocket } from './helius';
import { TelegramBot } from './telegram';
import { JupiterAPI } from './jupiter';
import { DiagnosticsSystem } from './diagnostics';
import { passesAge, log } from './utils';
import { calculateIndicators, checkBuySignal } from './indicators';
import { MIN_LIQUIDITY_USD, MAX_FDV_USD, MAX_PRICE_IMPACT_PERCENT, MIN_HISTORY_CANDLES } from './types';

config();

const db = new Database(process.env.DATABASE_URL!);
const helius = new HeliusWebSocket(process.env.HELIUS_KEY!, db);
const tg = new TelegramBot(process.env.TELEGRAM_TOKEN!, process.env.TELEGRAM_CHAT_ID!);
const jupiter = new JupiterAPI();

// Инициализируем систему диагностики
let diagnostics: DiagnosticsSystem;

async function indicatorSweep() {
  try {
    const pools = await db.getOldPools();
    for (const pool of pools) {
      const candles = await db.getCandles(pool.mint, 40);
      if (candles.length < MIN_HISTORY_CANDLES) continue;
      const indicators = calculateIndicators(candles);
      if (!indicators) continue;
      if (checkBuySignal(indicators)) {
        await db.createSignal(pool.mint, true, indicators.volSpike, indicators.rsi);
        log(`🚦 Signal candidate: ${pool.mint}`);
      }
    }
  } catch (e) {
    log(`Error in indicatorSweep: ${e}`, 'ERROR');
    await tg.sendErrorMessage(`Indicator Sweep Error: ${e}`);
  }
}

async function notifySweep() {
  try {
    const signals = await db.getUnnotifiedSignals();
    for (const sig of signals) {
      const pool = await db.getPool(sig.mint);
      if (!pool) continue;
      if (Number(pool.liq_usd) < MIN_LIQUIDITY_USD) continue;
      if (Number(pool.fdv_usd) > MAX_FDV_USD) continue;
      // Проверка price impact через Jupiter
      const quote = await jupiter.getQuote('EPjFWdd5AufqSSqeM2qA9G4KJ9b9wiG9vG7bG6wGw7bS', sig.mint, 200 * 1e6); // USDC mint, $200
      if (!quote || Number(quote.priceImpactPct) * 100 > MAX_PRICE_IMPACT_PERCENT) continue;
      // Passed all filters — send to Telegram
      await tg.sendBuySignal(sig, pool, Number(quote.priceImpactPct) * 100);
      await db.markSignalNotified(sig.id);
      log(`📢 Sent signal for ${sig.mint}`);
    }
  } catch (e) {
    log(`Error in notifySweep: ${e}`, 'ERROR');
    await tg.sendErrorMessage(`Notification Sweep Error: ${e}`);
  }
}

async function runDiagnostics() {
  try {
    log('🔧 Starting diagnostics check...');
    const health = await diagnostics.runDiagnostics();
    
    log(`🔍 Diagnostics completed: ${health.overallStatus}, found ${health.issues.length} issues`);
    
    if (health.overallStatus === 'CRITICAL') {
      const message = 
        `🚨 **CRITICAL SYSTEM ISSUES DETECTED** 🚨\n\n` +
        `Issues found: ${health.issues.length}\n` +
        `Status: ${health.overallStatus}\n\n` +
        health.issues.map(i => `• ${i.issue}: ${i.description}`).join('\n');
      
      log('📢 Sending critical diagnostics alert to Telegram');
      await tg.sendMessage(message);
    } else if (health.overallStatus === 'WARNING') {
      log(`⚠️ System warnings detected: ${health.issues.length} issues`);
      
      // Отправляем предупреждения в Telegram только если их много
      if (health.issues.length > 3) {
        const message = 
          `⚠️ **SYSTEM WARNINGS** ⚠️\n\n` +
          `Issues found: ${health.issues.length}\n\n` +
          health.issues.slice(0, 5).map(i => `• ${i.issue}: ${i.description}`).join('\n') +
          (health.issues.length > 5 ? `\n... и еще ${health.issues.length - 5} проблем` : '');
        
        await tg.sendMessage(message);
      }
    } else {
      log('✅ System health check passed');
    }
  } catch (e) {
    log(`Error in diagnostics: ${e}`, 'ERROR');
    await tg.sendErrorMessage(`Diagnostics Error: ${e}`);
  }
}

async function main() {
  await db.initialize();
  
  // Инициализируем диагностику после базы данных
  diagnostics = new DiagnosticsSystem(db, tg);
  
  await tg.sendMessage('🚀 Signal Bot запущен с системой автодиагностики!');
  await helius.connect();
  
  // Основные интервалы
  setInterval(indicatorSweep, 60_000);
  setInterval(notifySweep, 20_000);
  
  // Диагностика каждые 5 минут
  setInterval(runDiagnostics, 5 * 60 * 1000);
  
  // Первая диагностика через 30 секунд после запуска
  setTimeout(runDiagnostics, 30_000);
  
  // Очистка логов каждые 6 часов
  setInterval(() => {
    try {
      tg.cleanupTelegramLogs();
    } catch (e) {
      log(`Error cleaning telegram logs: ${e}`, 'ERROR');
    }
  }, 6 * 60 * 60 * 1000); // 6 hours
  
  log('Signal bot started with diagnostics system.');
}

main().catch(console.error); 