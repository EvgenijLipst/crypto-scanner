console.log('=== TESTING TOKEN LOADING AND SAVING LOGIC ===');

// Импортируем необходимые модули
const { CoinGeckoAPI } = require('./src/coingecko.js');
const { log } = require('./src/utils.js');

// Загружаем переменные окружения
require('dotenv').config();

async function testTokenLoading() {
  try {
    console.log('🔄 Starting token loading test...');
    
    // Проверяем API ключ
    if (!process.env.COINGECKO_API_KEY) {
      console.error('❌ Missing COINGECKO_API_KEY');
      return;
    }
    
    console.log('✅ CoinGecko API key found');
    
    // Создаем экземпляр CoinGecko API
    const coingecko = new CoinGeckoAPI(process.env.COINGECKO_API_KEY);
    
    console.log('🔄 Fetching top 2000 Solana tokens from CoinGecko...');
    
    // Получаем топ-2000 токенов
    const tokens = await coingecko.getTopSolanaTokens(2000);
    
    console.log(`📊 CoinGecko returned ${tokens.length} tokens`);
    
    if (tokens.length === 0) {
      console.log('❌ No tokens received from CoinGecko');
      return;
    }
    
    // Показываем первые 10 токенов
    console.log('\n📋 First 10 tokens:');
    tokens.slice(0, 10).forEach((token, i) => {
      console.log(`${i + 1}. ${token.symbol} (${token.name})`);
      console.log(`   • Mint: ${token.mint}`);
      console.log(`   • Price: $${token.priceUsd}`);
      console.log(`   • Market Cap: $${token.marketCap.toLocaleString()}`);
      console.log(`   • Volume 24h: $${token.volume24h.toLocaleString()}`);
      console.log('');
    });
    
    // Статистика по mint адресам
    const tokensWithMint = tokens.filter(t => t.mint && t.mint.length > 20);
    const tokensWithoutMint = tokens.filter(t => !t.mint || t.mint.length <= 20);
    
    console.log(`📊 Token Statistics:`);
    console.log(`• Total tokens: ${tokens.length}`);
    console.log(`• Tokens with valid mint: ${tokensWithMint.length}`);
    console.log(`• Tokens without mint: ${tokensWithoutMint.length}`);
    
    // Симулируем процесс сохранения
    console.log('\n🔄 Simulating save process...');
    
    const tokensToSave = tokensWithMint.map(token => ({
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
    
    console.log(`📋 Prepared ${tokensToSave.length} tokens for saving`);
    console.log(`📋 Sample tokens to save:`);
    tokensToSave.slice(0, 5).forEach((token, i) => {
      console.log(`${i + 1}. ${token.symbol} (${token.coinId}) - mint: "${token.mint}" - price: $${token.price}`);
    });
    
    // Проверяем валидность токенов
    const validTokens = tokensToSave.filter(token => 
      token.coinId && token.mint && token.symbol && token.name
    );
    
    if (validTokens.length !== tokensToSave.length) {
      console.log(`⚠️ WARNING: ${tokensToSave.length - validTokens.length} tokens have missing required fields`);
      console.log(`Valid tokens: ${validTokens.length}, Total tokens: ${tokensToSave.length}`);
    }
    
    console.log(`✅ Token loading test completed successfully!`);
    console.log(`📊 Final result: ${validTokens.length} valid tokens ready for database save`);
    
  } catch (error) {
    console.error(`❌ Error in token loading test: ${error}`);
    if (error instanceof Error) {
      console.error(`❌ Error details: ${error.message}`);
      console.error(`❌ Error stack: ${error.stack}`);
    }
  }
}

// Запускаем тест
testTokenLoading().then(() => {
  console.log('\n=== TEST COMPLETED ===');
  process.exit(0);
}).catch(error => {
  console.error('\n=== TEST FAILED ===');
  console.error(error);
  process.exit(1);
}); 