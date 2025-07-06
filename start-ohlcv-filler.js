#!/usr/bin/env node

// start-ohlcv-filler.js - Запуск OHLCV filler
// Запускает гибридную схему заполнения OHLCV для всех токенов

require('dotenv').config();
const { Database } = require('./src/database');
const { OHLCVFiller } = require('./src/fill-empty-ohlcv');
const { log } = require('./src/utils');

async function main() {
  try {
    log('🚀 Starting OHLCV Filler...');
    
    // Проверяем переменные окружения
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL environment variable is required');
    }
    
    const coingeckoApiKey = process.env.COINGECKO_API_KEY || null;
    const intervalMinutes = parseInt(process.env.OHLCV_FILL_INTERVAL_MINUTES) || 1;
    
    log(`📊 Configuration:`);
    log(`   • Database: ${databaseUrl.replace(/\/\/.*:.*@/, '//[credentials]@')}`);
    log(`   • Coingecko API Key: ${coingeckoApiKey ? '✅ Set' : '❌ Not set (using free tier)'}`);
    log(`   • Fill interval: ${intervalMinutes} minutes`);
    
    // Инициализируем базу данных
    log('🔌 Connecting to database...');
    const database = new Database(databaseUrl);
    await database.initialize();
    log('✅ Database connected and initialized');
    
    // Создаем и запускаем OHLCV filler
    log('📈 Creating OHLCV filler...');
    const ohlcvFiller = new OHLCVFiller(database, coingeckoApiKey);
    
    // Запускаем заполнение
    ohlcvFiller.start(intervalMinutes);
    
    log('✅ OHLCV filler started successfully');
    log('📊 The filler will now:');
    log('   • Process all tokens from coin_data table');
    log('   • Create empty candles for tokens without trading activity');
    log('   • Fetch prices from Coingecko when needed');
    log('   • Run every ' + intervalMinutes + ' minute(s)');
    
    // Обработка сигналов завершения
    process.on('SIGINT', async () => {
      log('\n🛑 Received SIGINT, shutting down...');
      ohlcvFiller.stop();
      await database.close();
      log('✅ OHLCV filler stopped gracefully');
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      log('\n🛑 Received SIGTERM, shutting down...');
      ohlcvFiller.stop();
      await database.close();
      log('✅ OHLCV filler stopped gracefully');
      process.exit(0);
    });
    
    // Периодический отчет о статусе
    setInterval(() => {
      const stats = ohlcvFiller.getStats();
      log(`📊 OHLCV filler status: ${stats.isRunning ? '🟢 Running' : '🔴 Stopped'}`);
    }, 5 * 60 * 1000); // каждые 5 минут
    
  } catch (error) {
    log(`❌ Fatal error: ${error}`, 'ERROR');
    log(`❌ Stack trace: ${error.stack}`, 'ERROR');
    process.exit(1);
  }
}

// Запускаем основную функцию
main().catch(error => {
  log(`❌ Unhandled error: ${error}`, 'ERROR');
  process.exit(1);
}); 