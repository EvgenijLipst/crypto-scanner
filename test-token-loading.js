// test-token-loading.js - Тестирование загрузки и сохранения токенов
const { Database } = require('./src/database.js');
require('dotenv').config();

async function testTokenLoading() {
  console.log('🧪 Testing token loading and saving...');
  
  // Проверяем переменные окружения
  if (!process.env.DATABASE_URL) {
    console.log('❌ DATABASE_URL not found in environment variables');
    console.log('ℹ️ This test requires database connection');
    return;
  }
  
  const db = new Database(process.env.DATABASE_URL);
  
  try {
    // 1. Инициализация базы данных
    await db.initialize();
    console.log('✅ Database initialized');
    
    // 2. Проверим текущие токены в базе
    const currentTokens = await db.getFreshTokensFromCoinData('Solana', 48);
    console.log(`📊 Current tokens in database: ${currentTokens.length}`);
    
    if (currentTokens.length > 0) {
      console.log('📋 Sample current tokens:');
      currentTokens.slice(0, 5).forEach((token, i) => {
        console.log(`${i + 1}. ${token.symbol} - mint: "${token.mint || 'NULL'}" - price: $${token.price}`);
      });
      
      // Проверим, сколько токенов имеют реальные mint адреса
      const tokensWithMint = currentTokens.filter(token => token.mint && !token.mint.includes('placeholder'));
      const tokensWithPlaceholder = currentTokens.filter(token => token.mint && token.mint.includes('placeholder'));
      const tokensWithoutMint = currentTokens.filter(token => !token.mint);
      
      console.log(`\n📊 Token mint analysis:`);
      console.log(`• Tokens with real mint addresses: ${tokensWithMint.length}`);
      console.log(`• Tokens with placeholder mints: ${tokensWithPlaceholder.length}`);
      console.log(`• Tokens without mint: ${tokensWithoutMint.length}`);
      
      if (tokensWithMint.length > 0) {
        console.log('\n📋 Tokens with real mint addresses:');
        tokensWithMint.slice(0, 3).forEach((token, i) => {
          console.log(`${i + 1}. ${token.symbol} - mint: "${token.mint}"`);
        });
      }
      
      if (tokensWithPlaceholder.length > 0) {
        console.log('\n📋 Tokens with placeholder mints:');
        tokensWithPlaceholder.slice(0, 3).forEach((token, i) => {
          console.log(`${i + 1}. ${token.symbol} - mint: "${token.mint}"`);
        });
      }
    } else {
      console.log('📊 No tokens found in database');
    }
    
    // 3. Тестируем создание мок-токенов с правильными mint адресами
    console.log('\n💾 Testing mock token saving with real mint addresses...');
    const mockTokens = [
      {
        coinId: 'solana',
        mint: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        name: 'Solana',
        network: 'Solana',
        price: 100.50,
        volume: 1000000,
        marketCap: 50000000,
        fdv: 50000000
      },
      {
        coinId: 'test-token',
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        symbol: 'USDC',
        name: 'USD Coin',
        network: 'Solana',
        price: 1.00,
        volume: 5000000,
        marketCap: 25000000,
        fdv: 25000000
      }
    ];
    
    console.log('📋 Mock tokens to save:');
    mockTokens.forEach((token, i) => {
      console.log(`${i + 1}. ${token.symbol} - mint: "${token.mint}" - coinId: "${token.coinId}"`);
    });
    
    await db.saveCoinDataBatch(mockTokens);
    console.log('✅ Mock tokens saved to database');
    
    // 4. Проверим, что токены сохранились
    const savedTokens = await db.getFreshTokensFromCoinData('Solana', 1); // Последний час
    console.log(`\n📊 Fresh tokens after saving: ${savedTokens.length}`);
    
    if (savedTokens.length > 0) {
      console.log('📋 Recently saved tokens:');
      savedTokens.slice(0, 5).forEach((token, i) => {
        console.log(`${i + 1}. ${token.symbol} - mint: "${token.mint || 'NULL'}" - price: $${token.price}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error);
    console.error('Error details:', error.message);
  } finally {
    await db.close();
  }
}

// Запуск теста
testTokenLoading().catch(console.error); 