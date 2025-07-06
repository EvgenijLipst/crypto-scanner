const { TokenAnalyzer } = require('./src/token-analyzer');
const { Database } = require('./src/database');
const { TelegramBot } = require('./src/telegram');
require('dotenv').config();

async function testSignalGeneration() {
  console.log('🔍 Testing signal generation with relaxed criteria...');
  
  try {
    // Инициализация компонентов
    const db = new Database();
    await db.connect();
    
    const tg = new TelegramBot(process.env.TELEGRAM_TOKEN, process.env.TELEGRAM_CHAT_ID);
    
    const tokenAnalyzer = new TokenAnalyzer(db, null, null, {
      minVolumeSpike: 2,
      maxRsiOversold: 45,
      minLiquidityUsd: 5000,
      maxPriceImpactPercent: 5
    });
    
    // Получаем случайные токены из базы
    const tokens = await db.query(`
      SELECT DISTINCT mint 
      FROM ohlcv 
      WHERE v > 0 
      ORDER BY RANDOM() 
      LIMIT 10
    `);
    
    console.log(`📊 Found ${tokens.rows.length} tokens to analyze`);
    
    let signalsGenerated = 0;
    
    for (const token of tokens.rows) {
      try {
        // Создаем тестовые данные для свапа
        const testSwapData = {
          timestamp: Math.floor(Date.now() / 1000),
          amountUsd: Math.random() * 10000 + 1000,
          buy: Math.random() > 0.5,
          sell: Math.random() > 0.5,
          buyer: 'test_buyer_' + Math.random().toString(36).substr(2, 9)
        };
        
        console.log(`\n🔍 Analyzing token: ${token.mint}`);
        
        const result = await tokenAnalyzer.analyzeTokenActivity(token.mint, testSwapData);
        
        if (result) {
          console.log(`📈 Analysis result for ${token.mint}:`);
          console.log(`  • Is Signal: ${result.isSignal ? '✅' : '❌'}`);
          console.log(`  • Volume Spike: ${result.data.volumeSpike?.toFixed(2)}x`);
          console.log(`  • RSI: ${result.data.rsi?.toFixed(1)}`);
          console.log(`  • EMA Bull: ${result.data.emaBull ? '✅' : '❌'}`);
          console.log(`  • Net Flow: ${result.data.netFlow?.toFixed(2)}`);
          console.log(`  • Unique Buyers: ${result.data.uniqueBuyers}`);
          console.log(`  • Avg Vol 60m: $${result.data.avgVol60m?.toFixed(0)}`);
          console.log(`  • Reasons: ${result.reasons.join(', ')}`);
          
          if (result.isSignal) {
            signalsGenerated++;
            console.log(`🚀 SIGNAL GENERATED! Sending to Telegram...`);
            
            const message = `🧪 **TEST SIGNAL** 🧪\n\n` +
              `🪙 **Token:** \`${result.mint}\`\n\n` +
              `📊 **Analysis:**\n` +
              `• Volume Spike: ${result.data.volumeSpike?.toFixed(2)}x\n` +
              `• RSI: ${result.data.rsi?.toFixed(1)}\n` +
              `• EMA Bull: ${result.data.emaBull ? '✅' : '❌'}\n` +
              `• Net Flow: ${result.data.netFlow?.toFixed(2)}\n` +
              `• Unique Buyers: ${result.data.uniqueBuyers}\n` +
              `• Avg Vol 60m: $${result.data.avgVol60m?.toFixed(0)}\n\n` +
              `💡 **Reasons:** ${result.reasons.join(', ')}\n\n` +
              `⏰ ${new Date().toLocaleString()}`;
            
            await tg.sendMessage(message);
          }
        } else {
          console.log(`❌ No analysis result for ${token.mint}`);
        }
        
      } catch (error) {
        console.error(`❌ Error analyzing ${token.mint}:`, error.message);
      }
    }
    
    console.log(`\n📊 Test completed!`);
    console.log(`🎯 Signals generated: ${signalsGenerated}/${tokens.rows.length}`);
    console.log(`📈 Success rate: ${((signalsGenerated / tokens.rows.length) * 100).toFixed(1)}%`);
    
    if (signalsGenerated > 0) {
      console.log(`✅ Signal generation is working with relaxed criteria!`);
    } else {
      console.log(`⚠️ No signals generated. Criteria may still be too strict.`);
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testSignalGeneration().catch(console.error); 