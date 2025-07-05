console.log('=== SIMULATING COMPLETE TOKEN SAVE PROCESS ===');

// Импортируем необходимые модули
const { CoinGeckoAPI } = require('./src/coingecko.js');
const { log } = require('./src/utils.js');

// Загружаем переменные окружения
require('dotenv').config();

// Симуляция базы данных
class MockDatabase {
  constructor() {
    this.savedTokens = new Map(); // mint -> token data
    this.saveCount = 0;
    this.updateCount = 0;
  }

  async saveCoinDataBatch(tokens) {
    console.log(`🔄 MockDatabase: Processing ${tokens.length} tokens...`);
    
    for (const token of tokens) {
      if (this.savedTokens.has(token.mint)) {
        // Обновляем существующий токен
        this.savedTokens.set(token.mint, token);
        this.updateCount++;
        console.log(`🔄 Updated existing token: ${token.symbol} (${token.mint})`);
      } else {
        // Вставляем новый токен
        this.savedTokens.set(token.mint, token);
        this.saveCount++;
        console.log(`➕ Inserted new token: ${token.symbol} (${token.mint})`);
      }
    }
    
    console.log(`✅ MockDatabase: ${this.saveCount} new tokens inserted, ${this.updateCount} existing tokens updated`);
    console.log(`📊 Total unique tokens in database: ${this.savedTokens.size}`);
  }

  getStats() {
    return {
      totalTokens: this.savedTokens.size,
      newTokens: this.saveCount,
      updatedTokens: this.updateCount
    };
  }
}

async function simulateCompleteProcess() {
  try {
    console.log('🔄 Starting complete token save simulation...');
    
    // Проверяем API ключ
    if (!process.env.COINGECKO_API_KEY) {
      console.error('❌ Missing COINGECKO_API_KEY');
      return;
    }
    
    console.log('✅ CoinGecko API key found');
    
    // Создаем экземпляры
    const coingecko = new CoinGeckoAPI(process.env.COINGECKO_API_KEY);
    const mockDb = new MockDatabase();
    
    console.log('🔄 FORCE REFRESH MODE: Fetching fresh tokens from CoinGecko...');
    
    // Получаем топ-2000 токенов
    const tokens = await coingecko.getTopSolanaTokens(2000);
    console.log(`CoinGecko returned ${tokens.length} tokens in force refresh mode`);
    
    if (tokens.length === 0) {
      console.log('❌ No tokens received from CoinGecko');
      return;
    }

    // Фильтруем токены с валидными mint адресами
    const validTokens = tokens.filter(t => t.mint && t.mint.length > 20);
    console.log(`Force refresh: ${validTokens.length} tokens with valid mint addresses`);

    // Подготавливаем токены для сохранения
    console.log('🔄 Preparing tokens for database save...');
    const tokensToSave = validTokens.map(token => ({
      coinId: token.coinId,
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      network: 'Solana',
      price: token.priceUsd,
      volume: token.volume24h,
      marketCap: token.marketCap,
      fdv: token.fdv
    }));

    console.log(`📋 Sample tokens to save:`);
    tokensToSave.slice(0, 5).forEach((token, i) => {
      console.log(`${i + 1}. ${token.symbol} (${token.coinId}) - mint: "${token.mint}" - price: $${token.price}`);
    });

    // Симулируем сохранение в базу данных
    console.log('\n🔄 FORCE SAVE: Attempting to save tokens to coin_data table...');
    await mockDb.saveCoinDataBatch(tokensToSave);
    console.log('✅ FORCE SAVE: saveTokensToCoinData completed successfully');

    // Показываем статистику
    const stats = mockDb.getStats();
    console.log('\n📊 FINAL STATISTICS:');
    console.log(`• Total unique tokens in database: ${stats.totalTokens}`);
    console.log(`• New tokens inserted: ${stats.newTokens}`);
    console.log(`• Existing tokens updated: ${stats.updateCount}`);
    console.log(`• Tokens processed: ${tokensToSave.length}`);

    // Показываем топ-10 токенов по market cap
    console.log('\n🏆 TOP 10 TOKENS BY MARKET CAP:');
    const sortedTokens = Array.from(mockDb.savedTokens.values())
      .sort((a, b) => b.marketCap - a.marketCap)
      .slice(0, 10);
    
    sortedTokens.forEach((token, i) => {
      console.log(`${i + 1}. ${token.symbol} - $${token.price} - MC: $${token.marketCap.toLocaleString()}`);
      console.log(`   Mint: ${token.mint}`);
    });

    console.log('\n✅ Complete token save simulation completed successfully!');
    console.log('💡 This shows exactly what would happen when the database is available');
    
  } catch (error) {
    console.error(`❌ Error in simulation: ${error}`);
    if (error instanceof Error) {
      console.error(`❌ Error details: ${error.message}`);
      console.error(`❌ Error stack: ${error.stack}`);
    }
  }
}

// Запускаем симуляцию
simulateCompleteProcess().then(() => {
  console.log('\n=== SIMULATION COMPLETED ===');
  process.exit(0);
}).catch(error => {
  console.error('\n=== SIMULATION FAILED ===');
  console.error(error);
  process.exit(1);
}); 