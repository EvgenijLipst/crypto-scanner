#!/usr/bin/env node

// Скрипт для принудительного обновления coin_data таблицы на Railway
require('ts-node').register({
  project: './tsconfig.json'
});

const { Database } = require('./src/database');
const { CoinGeckoAPI } = require('./src/coingecko');
const { TokenAnalyzer } = require('./src/token-analyzer');
const { JupiterAPI } = require('./src/jupiter');

async function forceCoinDataUpdate() {
  try {
    console.log('🚀 Force updating coin_data table on Railway...');
    
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
    
    // Очищаем старые данные (старше 24 часов)
    console.log('🧹 Cleaning old coin_data records...');
    await db.cleanupOldCoinData(24);
    
    // Проверяем текущее количество записей
    const beforeCount = await db.pool.query('SELECT COUNT(*) as count FROM coin_data');
    console.log(`📊 Records before update: ${beforeCount.rows[0].count}`);
    
    // Получаем токены из CoinGecko (ограничиваем до 100 для экономии API)
    console.log('🔄 Fetching tokens from CoinGecko...');
    const tokens = await coingecko.getTopSolanaTokens(100);
    console.log(`✅ Fetched ${tokens.length} tokens from CoinGecko`);
    
    if (tokens.length === 0) {
      console.log('❌ No tokens received from CoinGecko');
      return;
    }
    
    // Показываем статистику токенов
    console.log('📊 Token statistics:');
    const totalMarketCap = tokens.reduce((sum, token) => sum + token.marketCap, 0);
    const totalVolume = tokens.reduce((sum, token) => sum + token.volume24h, 0);
    console.log(`• Total Market Cap: $${totalMarketCap.toLocaleString()}`);
    console.log(`• Total Volume 24h: $${totalVolume.toLocaleString()}`);
    console.log(`• Average Price: $${(tokens.reduce((sum, token) => sum + token.priceUsd, 0) / tokens.length).toFixed(6)}`);
    
    // Сохраняем токены в базу данных
    console.log('💾 Saving tokens to coin_data table...');
    await tokenAnalyzer.saveTokensToCoinData(tokens);
    
    // Проверяем количество записей после сохранения
    const afterCount = await db.pool.query('SELECT COUNT(*) as count FROM coin_data');
    console.log(`📊 Records after update: ${afterCount.rows[0].count}`);
    
    // Проверяем свежие записи
    console.log('📋 Fresh coin_data records (last 10):');
    const freshRecords = await db.pool.query(`
      SELECT coin_id, symbol, name, mint, price, volume, market_cap, timestamp 
      FROM coin_data 
      WHERE timestamp > NOW() - INTERVAL '1 hour'
      ORDER BY timestamp DESC 
      LIMIT 10
    `);
    
    freshRecords.rows.forEach((record, i) => {
      console.log(`${i + 1}. ${record.symbol} (${record.coin_id}) - $${record.price} - Vol: $${record.volume?.toLocaleString()}`);
    });
    
    // Проверяем уникальность записей
    console.log('🔍 Checking data integrity...');
    const duplicateCheck = await db.pool.query(`
      SELECT coin_id, network, COUNT(*) as count
      FROM coin_data 
      GROUP BY coin_id, network 
      HAVING COUNT(*) > 1
      ORDER BY count DESC
      LIMIT 5
    `);
    
    if (duplicateCheck.rows.length > 0) {
      console.log('⚠️ Found duplicate records:');
      duplicateCheck.rows.forEach(row => {
        console.log(`• ${row.coin_id} (${row.network}): ${row.count} records`);
      });
    } else {
      console.log('✅ No duplicate records found');
    }
    
    console.log('✅ Force update completed successfully!');
    
  } catch (error) {
    console.error('❌ Force update failed:', error);
    if (error instanceof Error) {
      console.error('❌ Error details:', error.message);
      console.error('❌ Error stack:', error.stack);
    }
  } finally {
    process.exit(0);
  }
}

// Запускаем принудительное обновление
forceCoinDataUpdate(); 