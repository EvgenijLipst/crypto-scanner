console.log('=== SIGNAL BOT STARTED ===');
console.log('🔄 Starting initialization process...');
console.log(`⏰ Start time: ${new Date().toISOString()}`);

// index.ts - Гибридная система: CoinGecko (минимум) + Helius (активно)
import { config } from 'dotenv';
import { Database } from './database';
import { TelegramBot } from './telegram';
import { JupiterAPI } from './jupiter';
import { CoinGeckoAPI } from './coingecko';
import { TokenAnalyzer, AnalysisConfig } from './token-analyzer';
import { HeliusWebSocket } from './helius';
import { DiagnosticsSystem } from './diagnostics';
import { log } from './utils';

config();

console.log('HELIUS_API_KEY:', process.env.HELIUS_API_KEY);
console.log('✅ Environment variables loaded');

// Проверяем обязательные переменные окружения
const requiredEnvVars = [
  'DATABASE_URL',
  'TELEGRAM_TOKEN', 
  'TELEGRAM_CHAT_ID',
  'COINGECKO_API_KEY',
  'HELIUS_API_KEY'
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}
console.log('✅ All required environment variables present');

// Инициализация компонентов
console.log('🔄 Initializing components...');
const db = new Database(process.env.DATABASE_URL!);
const tg = new TelegramBot(process.env.TELEGRAM_TOKEN!, process.env.TELEGRAM_CHAT_ID!);
const jupiter = new JupiterAPI();
const coingecko = new CoinGeckoAPI(process.env.COINGECKO_API_KEY!);

// monitoredTokens — потокобезопасный Set
const monitoredTokens: Set<string> = new Set();

// HeliusWebSocket подключается сразу
const helius = new HeliusWebSocket(process.env.HELIUS_API_KEY!, db, tg);
console.log('✅ Helius WebSocket initialized');

// TokenAnalyzer и Diagnostics создаём после
const analysisConfig: AnalysisConfig = {
  minTokenAgeDays: parseInt(process.env.MIN_TOKEN_AGE_DAYS || '14'),
  minLiquidityUsd: parseInt(process.env.MIN_LIQUIDITY_USD || '10000'),
  maxFdvUsd: parseInt(process.env.MAX_FDV_USD || '5000000'),
  minVolumeSpike: parseFloat(process.env.MIN_VOLUME_SPIKE || '3'),
  maxRsiOversold: parseInt(process.env.MAX_RSI_OVERSOLD || '35'),
  maxPriceImpactPercent: parseFloat(process.env.MAX_PRICE_IMPACT_PERCENT || '3'),
  priceImpactTestAmount: parseFloat(process.env.PRICE_IMPACT_TEST_AMOUNT || '10')
};
const tokenAnalyzer = new TokenAnalyzer(coingecko, jupiter, db, analysisConfig);
console.log('✅ TokenAnalyzer created');

// Diagnostics создаём после
const diagnostics = new DiagnosticsSystem(db, tg);
console.log('✅ Diagnostics system initialized');

// Конфиг анализа (можно вынести в отдельный блок)
// const analysisConfig: AnalysisConfig = {
//   minTokenAgeDays: parseInt(process.env.MIN_TOKEN_AGE_DAYS || '14'),
//   minLiquidityUsd: parseInt(process.env.MIN_LIQUIDITY_USD || '10000'),
//   maxFdvUsd: parseInt(process.env.MAX_FDV_USD || '5000000'),
//   minVolumeSpike: parseFloat(process.env.MIN_VOLUME_SPIKE || '3'),
//   maxRsiOversold: parseInt(process.env.MAX_RSI_OVERSOLD || '35'),
//   maxPriceImpactPercent: parseFloat(process.env.MAX_PRICE_IMPACT_PERCENT || '3'),
//   priceImpactTestAmount: parseFloat(process.env.PRICE_IMPACT_TEST_AMOUNT || '10')
// };

// console.log('✅ Analysis config loaded');

// const tokenAnalyzer = new TokenAnalyzer(coingecko, jupiter, db, analysisConfig);

// console.log('✅ TokenAnalyzer created');

let apiUsageStats = {
  coingecko: {
    dailyUsage: 0,
    monthlyLimit: 10000,
    lastReset: new Date().toDateString()
  },
  helius: {
    dailyUsage: 0,
    monthlyLimit: 1000000,
    lastReset: new Date().toDateString()
  }
};

/**
 * Обновление списка токенов каждые 48 часов (сначала база, потом CoinGecko)
 */
async function tokenRefresh() {
  try {
    console.log('🔄 === TOKEN REFRESH STARTED ===');
    log('🔄 Token refresh starting (48h cycle)...');
    
    // Сначала очищаем старые данные из coin_data (старше 72 часов)
    console.log('🔄 Cleaning up old coin data...');
    await db.cleanupOldCoinData(72);
    console.log('✅ Old coin data cleanup completed');
    
    // Проверяем лимиты CoinGecko
    const today = new Date().toDateString();
    if (apiUsageStats.coingecko.lastReset !== today) {
      apiUsageStats.coingecko.dailyUsage = 0;
      apiUsageStats.coingecko.lastReset = today;
    }
    
    if (apiUsageStats.coingecko.dailyUsage >= 300) { // Оставляем запас
      log('⚠️ CoinGecko daily limit reached, skipping refresh');
      return;
    }
    
    console.log('🔄 Calling tokenAnalyzer.getTopTokensForMonitoring()...');
    // Получаем топ токены для мониторинга (сначала из базы, потом из CoinGecko)
    const tokens = await tokenAnalyzer.getTopTokensForMonitoring();
    console.log(`✅ getTopTokensForMonitoring completed, returned ${tokens.length} tokens`);
    
    // Увеличиваем счетчик только если реально использовали CoinGecko
    // (TokenAnalyzer сам решает - база или CoinGecko)
    
    log(`✅ Token refresh complete: ${tokens.length} tokens ready for monitoring`);
    console.log(`✅ Token refresh complete: ${tokens.length} tokens ready for monitoring`);
    
    // Отправляем отчет
    await sendTokenRefreshReport(tokens.length);
    
  } catch (error) {
    console.error(`❌ Error in token refresh: ${error}`);
    log(`❌ Error in token refresh: ${error}`, 'ERROR');
    await tg.sendErrorMessage(`Token Refresh Error: ${error}`);
  }
}

/**
 * Обработка сигналов от Helius WebSocket
 */
async function handleHeliusSignal(mint: string, swapData: any) {
  if (!monitoredTokens.has(mint)) return; // фильтр
  try {
    // Анализируем активность токена
    const result = await tokenAnalyzer.analyzeTokenActivity(mint, swapData);
    
    if (result && result.isSignal) {
      // Сохраняем сигнал в базу данных
      await db.createSignal(
        result.mint,
        true, // is_buy
        result.data.volumeSpike || 0,
        result.data.rsi || 0
      );
      
      // Отправляем уведомление в Telegram
      await sendSignalNotification(result);
      
      log(`✅ Signal processed: ${result.symbol} (${result.mint})`);
    }
    
  } catch (error) {
    log(`❌ Error processing Helius signal: ${error}`, 'ERROR');
  }
}

/**
 * Отправка уведомления о сигнале
 */
async function sendSignalNotification(signal: any) {
  try {
    const d = signal.data;
    const message = `🚀 **BUY SIGNAL DETECTED** 🚀\n\n💎 **${signal.symbol}** (${signal.name})\n📍 Mint: \`${signal.mint}\`\n\n📊 **Analysis Results:**\n• Volume Spike: ${d.volumeSpike?.toFixed(2)}x\n• RSI: ${d.rsi?.toFixed(2)}\n• EMA Bull: ${d.emaBull ? '✅' : '❌'}\n• ATR: ${d.atr?.toFixed(4)}\n• NetFlow: ${d.netFlow?.toFixed(2)}\n• Unique Buyers (5m): ${d.uniqueBuyers}\n• Liquidity Boost: ${d.liquidityBoost ? 'Yes' : 'No'}\n• Avg Vol 60m: $${d.avgVol60m?.toFixed(0)}\n• Vol 5m: $${d.vol5m?.toFixed(0)}\n\n⚡ **All criteria met - Ready to trade!**`;
    await tg.sendMessage(message);
  } catch (error) {
    log(`Error sending signal notification: ${error}`, 'ERROR');
  }
}

/**
 * Отчет об обновлении токенов (каждые 48 часов)
 */
async function sendTokenRefreshReport(tokensCount: number) {
  try {
    const message = `📊 **Token Refresh Report (48h cycle)**

🔄 **System Status:**
• Monitored Tokens: ${tokensCount}
• Analysis Mode: Hybrid (CoinGecko + Helius)
• Status: Active 🟢

📈 **API Usage:**
• CoinGecko: ${apiUsageStats.coingecko.dailyUsage}/280 daily
• Helius: ${apiUsageStats.helius.dailyUsage}/33,333 daily

⚙️ **Configuration:**
• Min Age: ${analysisConfig.minTokenAgeDays} days
• Min Liquidity: $${analysisConfig.minLiquidityUsd.toLocaleString()}
• Max FDV: $${analysisConfig.maxFdvUsd.toLocaleString()}
• Min Volume Spike: ${analysisConfig.minVolumeSpike}x
• Max RSI Oversold: ${analysisConfig.maxRsiOversold}
• Max Price Impact: ${analysisConfig.maxPriceImpactPercent}%
• Test Amount: $${analysisConfig.priceImpactTestAmount}

🎯 **Next token refresh in ~48 hours**
💡 **Optimization:** Top-2000 tokens updated every 48h (more stable, saves API credits)`;

    await tg.sendMessage(message);
    
  } catch (error) {
    log(`Error sending daily report: ${error}`, 'ERROR');
  }
}

/**
 * Инициализация системы
 */
async function initialize() {
  try {
    log('🚀 Initializing Hybrid Solana Signal Bot...');
    
    // Отправляем уведомление о начале инициализации
    await tg.sendMessage(`🚀 **Signal Bot Starting...**

⚙️ **Initialization in progress...**
• Database connection: Connecting...
• API testing: Starting...
• Token loading: Preparing...

📡 **Status:** Initializing services...`);
    
    // Инициализация базы данных
    await db.initialize();
    log('✅ Database initialized');
    
    // Инициализация диагностики
    // diagnostics = new DiagnosticsSystem(db, tg); // This line is removed as per new_code
    log('✅ Diagnostics system initialized');
    
    // Тестирование CoinGecko API
    log('🧪 Testing CoinGecko API...');
    let coingeckoStatus = '❌ Failed';
    try {
      const testTokens = await coingecko.getTopSolanaTokens(10);
      coingeckoStatus = `✅ Working (${testTokens.length} tokens)`;
      log(`✅ CoinGecko API working - fetched ${testTokens.length} test tokens`);
    } catch (error) {
      log(`❌ CoinGecko API test failed: ${error}`, 'ERROR');
    }
    
    // Тестирование Jupiter API
    log('🧪 Testing Jupiter API...');
    let jupiterStatus = '❌ Failed';
    try {
      const testQuote = await jupiter.getQuote(
        'So11111111111111111111111111111111111111112', // SOL
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (правильный адрес)
        1000000000 // 1 SOL
      );
      jupiterStatus = testQuote ? '✅ Working' : '⚠️ No quote';
      log(`✅ Jupiter API working - got quote: ${testQuote ? 'success' : 'failed'}`);
    } catch (error) {
      log(`❌ Jupiter API test failed: ${error}`, 'ERROR');
    }
    
    // Первоначальная загрузка токенов
    let tokensLoaded = 0;
    let tokenStatus = '❌ Failed';
    try {
      await tokenRefresh();
      tokensLoaded = tokenAnalyzer.getMonitoredTokens().length;
      tokenStatus = tokensLoaded > 0 ? `✅ ${tokensLoaded} tokens` : '⚠️ No tokens';
    } catch (error) {
      log(`❌ Token refresh failed: ${error}`, 'ERROR');
      tokenStatus = `❌ Error: ${error}`;
    }
    
    // Настройка и запуск Helius WebSocket (если доступен)
    // if (process.env.HELIUS_API_KEY) { // This block is removed as per new_code
    //   helius = new HeliusWebSocket(process.env.HELIUS_API_KEY, db, tg);
    //   console.log('✅ Helius WebSocket initialized');
    //   helius.onSwap = async (mint: string, swapData: any) => {
    //     if (tokenAnalyzer.shouldMonitorToken(mint)) {
    //       await handleHeliusSignal(mint, swapData);
    //     } else {
    //       log(`Swap for mint ${mint} ignored (not in top-2000)`);
    //     }
    //   };
    //   helius.connect().then(() => log('✅ Helius WebSocket connected')).catch(e => log('❌ Helius connect error: ' + e, 'ERROR'));
    // } else {
    //   console.log('⚠️ Helius WebSocket disabled - no API key provided');
    // }
    
    // Отправляем детальное уведомление о статусе запуска
    const systemStatus = (tokensLoaded > 0 && coingeckoStatus.includes('✅') && (helius ? '✅ Connected' : '❌ Disabled')) ? '🟢 OPERATIONAL' : '🟡 PARTIAL';
    
    await tg.sendMessage(`🚀 **Hybrid Solana Signal Bot Started!**

📊 **System Status:** ${systemStatus}

🔧 **Component Status:**
• Database: ✅ Connected
• CoinGecko API: ${coingeckoStatus}
• Jupiter API: ${jupiterStatus}
• Helius WebSocket: ${helius ? '✅ Connected' : '❌ Disabled'}
• Token Loading: ${tokenStatus}

📈 **Configuration:**
• Analysis Mode: CoinGecko + Helius
• Strategy: 48h token refresh + Real-time monitoring
• Monitoring: ${tokensLoaded} tokens

💡 **API Optimization:**
• CoinGecko: 48h refresh cycle (saves credits)
• Helius: Real-time monitoring (uses available credits)

${tokensLoaded > 0 ? '🔍 **Ready for signal detection!**' : '⚠️ **Limited functionality - token loading issues**'}

⏰ Started at: ${new Date().toLocaleString()}`);
    
    log('✅ Hybrid initialization complete');
    
  } catch (error) {
    log(`❌ Initialization failed: ${error}`, 'ERROR');
    
    // Отправляем уведомление об ошибке инициализации
    await tg.sendMessage(`🚨 **Signal Bot Initialization Failed!**

❌ **Error:** ${error}

🔧 **Status:** System failed to start properly
⚠️ **Action Required:** Check logs and restart

⏰ Failed at: ${new Date().toLocaleString()}`);
    
    throw error;
  }
}

/**
 * Запуск системы
 */
async function start() {
  try {
    await initialize();
    
    // Планируем обновление токенов каждые 48 часов
    setInterval(tokenRefresh, 48 * 60 * 60 * 1000);
    
    // Планируем очистку старых данных (каждые 24 часа)
    setInterval(async () => {
      try {
        await db.cleanupOldCoinData(72); // Очищаем данные старше 72 часов
      } catch (error) {
        log(`Error in cleanup: ${error}`, 'ERROR');
      }
    }, 24 * 60 * 60 * 1000);
    
    // Планируем диагностику (каждые 10 минут)
    setInterval(async () => {
      try {
        await diagnostics.runDiagnostics();
      } catch (error) {
        log(`Error in diagnostics: ${error}`, 'ERROR');
      }
    }, 10 * 60 * 1000);
    
    // Планируем отчеты об активности (каждые 12 часов)
    setInterval(async () => {
      try {
        const monitoredCount = tokenAnalyzer.getMonitoredTokens().length;
        await sendTokenRefreshReport(monitoredCount);
      } catch (error) {
        log(`Error in activity report: ${error}`, 'ERROR');
      }
    }, 12 * 60 * 60 * 1000);
    
    // Планируем WebSocket отчеты (каждые 10 минут) - только если Helius доступен
    if (helius) {
      setInterval(async () => {
        try {
          await helius!.sendWebSocketActivityReport();
        } catch (error) {
          log(`Error in WebSocket activity report: ${error}`, 'ERROR');
        }
      }, 10 * 60 * 1000);
    }
    
    log('🎯 Hybrid Signal Bot is running...');
    
  } catch (error) {
    log(`❌ Failed to start: ${error}`, 'ERROR');
    process.exit(1);
  }
}

// Обработка сигналов завершения
process.on('SIGINT', async () => {
  log('🛑 Shutting down Hybrid Signal Bot...');
  
  // Отправляем уведомление об остановке
  try {
    await tg.sendMessage(`🛑 **Signal Bot Shutting Down**

⚠️ **Manual shutdown detected (SIGINT)**
🔄 **Status:** Gracefully stopping all services...

📊 **Final Stats:**
• Uptime: ${Math.floor(process.uptime() / 60)} minutes
• Monitored Tokens: ${monitoredTokens.size}
• API Usage: CoinGecko ${apiUsageStats.coingecko.dailyUsage}/333

🔌 **Disconnecting services...**`);
  } catch (error) {
    log(`Error sending shutdown notification: ${error}`, 'ERROR');
  }
  
  if (helius) {
    await helius.disconnect();
  }
  await db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('🛑 Shutting down Hybrid Signal Bot...');
  
  // Отправляем уведомление об остановке
  try {
    await tg.sendMessage(`🛑 **Signal Bot Shutting Down**

⚠️ **System shutdown detected (SIGTERM)**
🔄 **Status:** Gracefully stopping all services...

📊 **Final Stats:**
• Uptime: ${Math.floor(process.uptime() / 60)} minutes
• Monitored Tokens: ${monitoredTokens.size}
• API Usage: CoinGecko ${apiUsageStats.coingecko.dailyUsage}/333

🔌 **Disconnecting services...**`);
  } catch (error) {
    log(`Error sending shutdown notification: ${error}`, 'ERROR');
  }
  
  if (helius) {
    await helius.disconnect();
  }
  await db.close();
  process.exit(0);
});

// Запуск
start().catch(console.error); 