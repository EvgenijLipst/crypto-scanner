// test-token-saving.js - Тестирование механизма сохранения токенов
const { Database } = require('./src/database');
const { CoinGeckoAPI } = require('./src/coingecko');
const { log } = require('./src/utils');
require('dotenv').config();

async function testTokenSaving() {
  const db = new Database(process.env.DATABASE_URL);
  const coingecko = new CoinGeckoAPI(process.env.COINGECKO_API_KEY);
  
  try {
    console.log('🧪 Testing token saving mechanism...');
    
    // 1. Инициализация базы данных
    await db.initialize();
    console.log('✅ Database initialized');
    
    // 2. Получаем небольшое количество токенов для теста
    console.log('📡 Fetching test tokens from CoinGecko...');
    const tokens = await coingecko.getTopSolanaTokens(10);
    console.log(`📊 Received ${tokens.length} tokens from CoinGecko`);
    
    if (tokens.length === 0) {
      console.log('❌ No tokens received from CoinGecko');
      return;
    }
    
    // 3. Показываем первые несколько токенов
    console.log('\n📋 Sample tokens:');
    tokens.slice(0, 3).forEach((token, i) => {
      console.log(`${i + 1}. ${token.symbol} (${token.name})`);
      console.log(`   Mint: ${token.mint}`);
      console.log(`   Price: $${token.priceUsd}`);
      console.log(`   Volume: $${token.volume24h}`);
      console.log(`   Market Cap: $${token.marketCap}`);
      console.log('');
    });
    
    // 4. Подготавливаем данные для сохранения
    const coinDataTokens = tokens.map(token => ({
      coinId: token.symbol.toLowerCase(),
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      network: 'Solana',
      price: token.priceUsd,
      volume: token.volume24h,
      marketCap: token.marketCap,
      fdv: token.fdv
    }));
    
    console.log(`💾 Attempting to save ${coinDataTokens.length} tokens...`);
    
    // 5. Пробуем сохранить токены
    await db.saveCoinDataBatch(coinDataTokens);
    console.log('✅ Tokens saved successfully');
    
    // 6. Проверяем, что токены действительно сохранились
    const savedTokens = await db.getFreshTokensFromCoinData('Solana', 1);
    console.log(`📊 Found ${savedTokens.length} fresh tokens in database`);
    
    // 7. Показываем сохраненные токены
    if (savedTokens.length > 0) {
      console.log('\n📋 Saved tokens:');
      savedTokens.slice(0, 3).forEach((token, i) => {
        console.log(`${i + 1}. ${token.symbol} (${token.coin_id})`);
        console.log(`   Mint: ${token.mint}`);
        console.log(`   Price: $${token.price}`);
        console.log(`   Timestamp: ${token.timestamp}`);
        console.log('');
      });
    }
    
    // 8. Проверяем общее количество токенов
    const totalCount = await db.pool.query(`
      SELECT COUNT(*) as count FROM coin_data WHERE network = 'Solana'
    `);
    console.log(`📊 Total Solana tokens in database: ${totalCount.rows[0].count}`);
    
    console.log('\n✅ Token saving test completed successfully!');
    
  } catch (error) {
    console.error('❌ Error in token saving test:', error);
    console.error('Stack:', error.stack);
  } finally {
    await db.close();
  }
}

// Запуск теста
testTokenSaving().catch(console.error); 