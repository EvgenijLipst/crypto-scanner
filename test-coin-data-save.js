#!/usr/bin/env node

// Тестовый скрипт для проверки сохранения токенов в coin_data таблицу
require('ts-node').register({
  project: './tsconfig.json'
});

const { Database } = require('./src/database');
const { CoinGeckoAPI } = require('./src/coingecko');
const { TokenAnalyzer } = require('./src/token-analyzer');
const { JupiterAPI } = require('./src/jupiter');

async function testCoinDataSave() {
  try {
    console.log('🧪 Testing coin_data save functionality...');
    
    // Проверяем переменные окружения
    if (!process.env.DATABASE_URL) {
      console.error('❌ DATABASE_URL environment variable is missing');
      process.exit(1);
    }
    
    if (!process.env.COINGECKO_API_KEY) {
      console.error('❌ COINGECKO_API_KEY environment variable is missing');
      process.exit(1);
    }
    
    // Инициализируем компоненты
    const db = new Database(process.env.DATABASE_URL);
    const coingecko = new CoinGeckoAPI(process.env.COINGECKO_API_KEY);
    const jupiter = new JupiterAPI();
    
    // Конфигурация анализа
    const analysisConfig = {
      minTokenAgeDays: 14,
      minLiquidityUsd: 10000,
      maxFdvUsd: 5000000,
      minVolumeSpike: 3,
      maxRsiOversold: 35,
      maxPriceImpactPercent: 3,
      priceImpactTestAmount: 10
    };
    
    const tokenAnalyzer = new TokenAnalyzer(coingecko, jupiter, db, analysisConfig);
    
    // Инициализируем базу данных
    console.log('🔧 Initializing database...');
    await db.initialize();
    console.log('✅ Database initialized');
    
    // Проверяем текущее количество записей в coin_data
    console.log('📊 Checking current coin_data records...');
    const currentCount = await db.pool.query('SELECT COUNT(*) as count FROM coin_data');
    console.log(`📊 Current coin_data records: ${currentCount.rows[0].count}`);
    
    // Получаем тестовые токены (только 10 для экономии API)
    console.log('🔄 Fetching test tokens from CoinGecko...');
    const testTokens = await coingecko.getTopSolanaTokens(10);
    console.log(`✅ Fetched ${testTokens.length} test tokens`);
    
    if (testTokens.length === 0) {
      console.log('❌ No tokens received from CoinGecko');
      return;
    }
    
    // Показываем примеры токенов
    console.log('📋 Sample tokens:');
    testTokens.slice(0, 3).forEach((token, i) => {
      console.log(`${i + 1}. ${token.symbol} (${token.coinId}) - mint: "${token.mint}" - price: $${token.priceUsd}`);
    });
    
    // Сохраняем токены в базу данных
    console.log('💾 Saving tokens to coin_data table...');
    await tokenAnalyzer.saveTokensToCoinData(testTokens);
    
    // Проверяем количество записей после сохранения
    console.log('📊 Checking coin_data records after save...');
    const newCount = await db.pool.query('SELECT COUNT(*) as count FROM coin_data');
    console.log(`📊 New coin_data records: ${newCount.rows[0].count}`);
    
    // Проверяем последние добавленные записи
    console.log('📋 Latest coin_data records:');
    const latestRecords = await db.pool.query(`
      SELECT coin_id, symbol, name, mint, price, volume, timestamp 
      FROM coin_data 
      ORDER BY timestamp DESC 
      LIMIT 5
    `);
    
    latestRecords.rows.forEach((record, i) => {
      console.log(`${i + 1}. ${record.symbol} (${record.coin_id}) - mint: "${record.mint}" - price: $${record.price}`);
    });
    
    console.log('✅ Test completed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    if (error instanceof Error) {
      console.error('❌ Error details:', error.message);
      console.error('❌ Error stack:', error.stack);
    }
  } finally {
    process.exit(0);
  }
}

// Запускаем тест
testCoinDataSave(); 