// index.ts - Main orchestration for Solana Signal Bot
import { config } from 'dotenv';
import { Database } from './database';
import { HeliusWebSocket } from './helius';
import { TelegramBot } from './telegram';
import { JupiterAPI } from './jupiter';
import { passesAge, log } from './utils';
import { calculateIndicators, checkBuySignal } from './indicators';
import { MIN_LIQUIDITY_USD, MAX_FDV_USD, MAX_PRICE_IMPACT_PERCENT, MIN_HISTORY_CANDLES } from './types';

config();

const db = new Database(process.env.DATABASE_URL!);
const helius = new HeliusWebSocket(process.env.HELIUS_KEY!, db);
const tg = new TelegramBot(process.env.TELEGRAM_TOKEN!, process.env.TELEGRAM_CHAT_ID!);
const jupiter = new JupiterAPI();

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
  }
}

async function main() {
  await db.initialize();
  await tg.sendMessage('🚀 Signal Bot запущен!');
  await helius.connect();
  setInterval(indicatorSweep, 60_000);
  setInterval(notifySweep, 20_000);
  log('Signal bot started.');
}

main(); 