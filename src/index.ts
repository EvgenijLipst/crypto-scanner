// Main Signal Bot - координирует все компоненты

import { config } from 'dotenv';
import { Database } from './database';
import { HeliusWebSocket } from './helius';
import { JupiterAPI } from './jupiter';
import { TelegramBot } from './telegram';
import { log, toUnixSeconds } from './utils';
import { SwapEvent, PoolRow } from './types';

config();

class SignalBot {
  private database: Database;
  private helius: HeliusWebSocket;
  private jupiter: JupiterAPI;
  private telegram: TelegramBot;

  constructor() {
      // Try to use DATABASE_URL first, fallback to PostgreSQL components
      let databaseUrl = process.env.DATABASE_URL;
      
      if (!databaseUrl && process.env.PGHOST) {
        databaseUrl = `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`;
        log(`Built DATABASE_URL from PostgreSQL components: ${databaseUrl}`);
      }
      
      const telegramToken = process.env.TELEGRAM_TOKEN;
      const telegramChatId = process.env.TELEGRAM_CHAT_ID;

    // Debug environment variables
    log(`Environment variables:`, 'INFO');
    log(`DATABASE_URL: ${databaseUrl ? 'SET' : 'NOT SET'}`, 'INFO');
    log(`TELEGRAM_TOKEN: ${telegramToken ? telegramToken.substring(0, 10) + '...' : 'NOT SET'}`, 'INFO');
    log(`TELEGRAM_CHAT_ID: "${telegramChatId}" (type: ${typeof telegramChatId})`, 'INFO');
    log(`HELIUS_KEY: ${process.env.HELIUS_KEY ? 'SET' : 'NOT SET'}`, 'INFO');
    
    // Debug PostgreSQL variables
    log(`PGHOST: ${process.env.PGHOST ? 'SET' : 'NOT SET'}`, 'INFO');
    log(`PGDATABASE: ${process.env.PGDATABASE ? 'SET' : 'NOT SET'}`, 'INFO');

    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is required');
    }

    if (!telegramToken || !telegramChatId) {
      throw new Error('TELEGRAM_TOKEN and TELEGRAM_CHAT_ID environment variables are required');
    }

    this.database = new Database(databaseUrl);
    this.helius = new HeliusWebSocket(process.env.HELIUS_KEY!, this.database);
    this.jupiter = new JupiterAPI();
    this.telegram = new TelegramBot(telegramToken, telegramChatId);
  }

  /**
   * Запуск сигнального бота
   */
  async start(): Promise<void> {
    try {
      log('🚀 Starting Solana Signal Bot...');
      
      // Проверяем API ключ Helius
      const heliusKey = process.env.HELIUS_KEY;
      log(`Helius API Key: ${heliusKey ? heliusKey.substring(0, 8) + '...' : 'NOT SET'}`);
      
      // Инициализация базы данных
      await this.database.initialize();
      
      // Отправляем уведомление о запуске в Telegram
      log('🔔 Testing Telegram connection...');
      
      const telegramSuccess = await this.telegram.sendMessage('🚀 Signal Bot запущен и готов к работе!');
      if (telegramSuccess) {
        log('✅ Telegram connected successfully');
      } else {
        log('❌ Telegram connection failed', 'ERROR');
        await this.telegram.sendErrorMessage('Failed to connect to Telegram');
      }
      
      // Подключение к Helius WebSocket
      try {
        await this.helius.connect();
        log('🔗 Helius WebSocket connected successfully');
      } catch (error) {
        log('⚠️ Helius WebSocket connection failed:', 'WARN');
        log(String(error), 'WARN');
        await this.telegram.sendErrorMessage(`WebSocket connection failed: ${error}`);
        log('🔄 Bot will continue without real-time monitoring');
      }
      
      // Запуск мониторинга уведомлений
      this.startNotificationLoop();
      
      // Запуск очистки данных
      this.startCleanupLoop();
      
      // Запуск отчетов активности
      this.startActivityReports();
      
      log('✅ Signal Bot started successfully (Production mode)');
      
      log('🔔 Ready to process signals! Check Telegram for notifications.');
      
    } catch (error) {
      log('❌ Failed to start Signal Bot:', 'ERROR');
      log(String(error), 'ERROR');
      await this.telegram.sendErrorMessage(`Signal Bot startup failed: ${error}`);
      process.exit(1);
    }
  }

  /**
   * Отправка уведомлений в Telegram
   */
  private async startNotificationLoop(): Promise<void> {
    const checkInterval = 30000; // 30 секунд
    
    const sendNotifications = async () => {
      try {
        const unnotifiedSignals = await this.database.getUnnotifiedSignals();
        
        for (const signal of unnotifiedSignals) {
          // Получаем данные пула для полного сигнала
          const pool = await this.database.getPool(signal.mint);
          if (pool) {
            const priceImpact = 0; // TODO: получить через Jupiter API
            const success = await this.telegram.sendBuySignal(signal, { liq_usd: pool.liq_usd || 0, fdv_usd: pool.fdv_usd || 0 }, priceImpact);
            
            // Помечаем как уведомленный только если отправка успешна
            if (success) {
              await this.database.markSignalNotified(signal.id);
            } else {
              log(`Failed to send notification for signal ${signal.id}, will retry later`);
            }
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log('❌ Error sending notifications:', 'ERROR');
        log(errorMessage, 'ERROR');
        
        // Отправляем ошибку в Telegram только если это не сетевая проблема
        if (!errorMessage.includes('timeout') && !errorMessage.includes('Connection terminated')) {
          try {
            await this.telegram.sendErrorMessage(`Notification error: ${errorMessage}`);
          } catch (telegramError) {
            log('Failed to send error message to Telegram (network issue)', 'WARN');
          }
        }
      }
    };
    
    // Отправляем уведомления сразу и потом каждые 30 секунд
    await sendNotifications();
    setInterval(sendNotifications, checkInterval);
    
    log('📤 Notification system started');
  }

  /**
   * Очистка старых данных (каждые 6 часов)
   */
  private startCleanupLoop(): void {
    const cleanupInterval = 6 * 60 * 60 * 1000; // 6 часов
    
    const performCleanup = async () => {
      try {
        await this.database.cleanup();
      } catch (error) {
        log('❌ Error during cleanup:', 'ERROR');
        log(String(error), 'ERROR');
      }
    };
    
    setInterval(performCleanup, cleanupInterval);
    log('🧹 Cleanup loop started');
  }

  /**
   * Отчеты о активности WebSocket (каждые 10 минут)
   */
  private startActivityReports(): void {
    const reportInterval = 10 * 60 * 1000; // 10 минут
    
    const sendActivityReport = async () => {
      try {
        const stats = this.helius.getActivityStats();
        await this.telegram.sendActivityReport(stats);
        
        // Сбрасываем счетчики после отчета для следующего периода
        this.helius.resetStats();
        
        log(`📊 Activity report sent: ${stats.messagesReceived} messages, ${stats.swapEventsProcessed} swaps`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log('❌ Error sending activity report:', 'ERROR');
        log(errorMessage, 'ERROR');
      }
    };
    
    // Первый отчет через 10 минут, затем каждые 10 минут
    setTimeout(() => {
      sendActivityReport();
      setInterval(sendActivityReport, reportInterval);
    }, reportInterval);
    
    log('📊 Activity reporting started (every 10 minutes)');
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    log('Shutting down Signal Bot...');
    
    this.helius.close();
    await this.database.close();
    
    log('Signal Bot shut down successfully');
    process.exit(0);
  }
}

// Создаем и запускаем бота
const signalBot = new SignalBot();

// Graceful shutdown
process.on('SIGINT', () => signalBot.shutdown());
process.on('SIGTERM', () => signalBot.shutdown());

// Запускаем бота
signalBot.start().catch((error) => {
  log('❌ Fatal error:', error);
  process.exit(1);
}); 