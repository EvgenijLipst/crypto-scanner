// index.ts - Главный файл сигнального бота

import dotenv from 'dotenv';
import { Database } from './database';
import { HeliusWebSocket } from './helius';
import { JupiterAPI } from './jupiter';
import { TelegramBot } from './telegram';
import { calculateIndicators, checkBuySignal } from './indicators';
import { passesAge, toUnixSeconds, log } from './utils';
import { 
  MIN_LIQUIDITY_USD, 
  MAX_FDV_USD, 
  MIN_HISTORY_CANDLES 
} from './types';

// Загружаем переменные окружения
dotenv.config();

class SignalBot {
  private database: Database;
  private heliusWS: HeliusWebSocket;
  private jupiter: JupiterAPI;
  private telegram: TelegramBot;
  
  private stats = {
    signalsProcessed: 0,
    signalsSent: 0,
    tokensAnalyzed: 0,
    startTime: Date.now()
  };

  constructor() {
    // Проверяем обязательные переменные окружения
    this.validateEnvironment();

    // Инициализируем компоненты
    this.database = new Database(process.env.DATABASE_URL!);
    this.heliusWS = new HeliusWebSocket(process.env.HELIUS_KEY!, this.database);
    this.jupiter = new JupiterAPI();
    this.telegram = new TelegramBot(
      process.env.TELEGRAM_TOKEN!,
      process.env.TELEGRAM_CHAT_ID!
    );
  }

  /**
   * Проверка переменных окружения
   */
  private validateEnvironment(): void {
    const required = [
      'DATABASE_URL',
      'HELIUS_KEY',
      'TELEGRAM_TOKEN',
      'TELEGRAM_CHAT_ID'
    ];

    for (const env of required) {
      if (!process.env[env]) {
        throw new Error(`Missing required environment variable: ${env}`);
      }
    }

    log('Environment variables validated');
  }

  /**
   * Запуск бота
   */
  async start(): Promise<void> {
    try {
      log('Starting Signal Bot...');

      // Инициализируем базу данных
      await this.database.initialize();

      // Отправляем тестовое сообщение в Telegram
      await this.telegram.sendTestMessage();

      // Подключаемся к Helius WebSocket
      await this.heliusWS.connect();

      // Запускаем циклы обработки
      this.startIndicatorLoop();
      this.startNotificationLoop();
      this.startStatsLoop();
      this.startCleanupLoop();

      log('Signal Bot started successfully');
    } catch (error) {
      log(`Failed to start Signal Bot: ${error}`, 'ERROR');
      await this.telegram.sendErrorMessage(`Failed to start: ${error}`);
      process.exit(1);
    }
  }

  /**
   * Цикл расчета индикаторов (каждую минуту)
   */
  private startIndicatorLoop(): void {
    setInterval(async () => {
      await this.runIndicatorSweep();
    }, 60_000); // Каждую минуту

    log('Indicator calculation loop started');
  }

  /**
   * Цикл отправки уведомлений (каждые 20 секунд)
   */
  private startNotificationLoop(): void {
    setInterval(async () => {
      await this.runNotificationSweep();
    }, 20_000); // Каждые 20 секунд

    log('Notification loop started');
  }

  /**
   * Цикл отправки статистики (каждый час)
   */
  private startStatsLoop(): void {
    setInterval(async () => {
      await this.sendStatsUpdate();
    }, 3600_000); // Каждый час

    log('Stats loop started');
  }

  /**
   * Цикл очистки данных (каждые 4 часа)
   */
  private startCleanupLoop(): void {
    setInterval(async () => {
      await this.database.cleanup();
    }, 4 * 3600_000); // Каждые 4 часа

    log('Cleanup loop started');
  }

  /**
   * Анализ всех известных токенов на сигналы
   */
  private async runIndicatorSweep(): Promise<void> {
    try {
      // Получаем все пулы старше 14 дней
      const oldPools = await this.database.getOldPools();
      
      for (const pool of oldPools) {
        if (!passesAge(pool)) continue;

        this.stats.tokensAnalyzed++;

        // Получаем свечи для анализа
        const candles = await this.database.getCandles(pool.mint, MIN_HISTORY_CANDLES);
        
        if (candles.length < MIN_HISTORY_CANDLES) {
          continue; // Недостаточно данных
        }

        // Рассчитываем индикаторы
        const indicators = calculateIndicators(candles);
        if (!indicators) continue;

        // Проверяем сигнал на покупку
        if (checkBuySignal(indicators)) {
          await this.database.createSignal(
            pool.mint,
            toUnixSeconds(),
            indicators.bullishCross,
            indicators.volSpike,
            indicators.rsi
          );

          this.stats.signalsProcessed++;
          log(`Buy signal generated for ${pool.mint}`);
        }
      }
    } catch (error) {
      log(`Error in indicator sweep: ${error}`, 'ERROR');
    }
  }

  /**
   * Обработка и отправка неотправленных сигналов
   */
  private async runNotificationSweep(): Promise<void> {
    try {
      const unnotifiedSignals = await this.database.getUnnotifiedSignals();

      for (const signal of unnotifiedSignals) {
        await this.processSignalForNotification(signal);
      }
    } catch (error) {
      log(`Error in notification sweep: ${error}`, 'ERROR');
    }
  }

  /**
   * Обработка сигнала для уведомления с финальными проверками
   */
  private async processSignalForNotification(signal: any): Promise<void> {
    try {
      const pool = await this.database.getPool(signal.mint);
      if (!pool) {
        await this.database.markSignalNotified(signal.id);
        return;
      }

      // Проверяем ликвидность
      if (pool.liq_usd < MIN_LIQUIDITY_USD) {
        log(`Signal rejected: Low liquidity ${pool.liq_usd} < ${MIN_LIQUIDITY_USD}`);
        await this.database.markSignalNotified(signal.id);
        return;
      }

      // Проверяем FDV
      if (pool.fdv_usd > MAX_FDV_USD) {
        log(`Signal rejected: High FDV ${pool.fdv_usd} > ${MAX_FDV_USD}`);
        await this.database.markSignalNotified(signal.id);
        return;
      }

      // Проверяем price impact через Jupiter
      const { priceImpact, passed } = await this.jupiter.checkPriceImpact(signal.mint);
      
      if (!passed) {
        log(`Signal rejected: High price impact ${priceImpact}%`);
        await this.database.markSignalNotified(signal.id);
        return;
      }

      // Все проверки пройдены - отправляем сигнал
      const success = await this.telegram.sendBuySignal(
        signal,
        { liq_usd: pool.liq_usd, fdv_usd: pool.fdv_usd },
        priceImpact
      );

      if (success) {
        await this.database.markSignalNotified(signal.id);
        this.stats.signalsSent++;
        log(`Signal sent successfully for ${signal.mint}`);
      }
    } catch (error) {
      log(`Error processing signal for ${signal.mint}: ${error}`, 'ERROR');
      // Отмечаем как отправленный, чтобы избежать повторных попыток
      await this.database.markSignalNotified(signal.id);
    }
  }

  /**
   * Отправка статистики работы
   */
  private async sendStatsUpdate(): Promise<void> {
    const uptime = (Date.now() - this.stats.startTime) / 1000;
    
    await this.telegram.sendStats({
      ...this.stats,
      uptime
    });
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    log('Shutting down Signal Bot...');
    
    this.heliusWS.close();
    await this.database.close();
    
    log('Signal Bot shutdown complete');
    process.exit(0);
  }
}

// Главная функция
async function main() {
  const bot = new SignalBot();

  // Graceful shutdown handlers
  process.on('SIGTERM', () => bot.shutdown());
  process.on('SIGINT', () => bot.shutdown());
  
  // Обработка необработанных ошибок
  process.on('unhandledRejection', (reason, promise) => {
    log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, 'ERROR');
  });

  process.on('uncaughtException', (error) => {
    log(`Uncaught Exception: ${error}`, 'ERROR');
    process.exit(1);
  });

  // Запускаем бота
  await bot.start();
}

// Запуск только если это главный модуль
if (require.main === module) {
  main().catch(error => {
    log(`Fatal error: ${error}`, 'ERROR');
    process.exit(1);
  });
}

export { SignalBot }; 