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
import { OHLCVFiller } from './fill-empty-ohlcv';
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

// monitoredTokens теперь управляется через TokenAnalyzer и Helius WebSocket

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

// OHLCV Filler для заполнения пустых свечей
const ohlcvFiller = new OHLCVFiller(db, process.env.COINGECKO_API_KEY);
console.log('✅ OHLCV Filler initialized');

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
 * Проверка свежих токенов в базе данных и обновление списка мониторинга
 */
async function checkAndUpdateTokens(): Promise<number> {
  try {
    console.log('🔄 === SMART TOKEN CHECK STARTED ===');
    log('🔄 Checking for fresh tokens in database (12h cycle)...');
    
    // Проверяем, есть ли ≥1500 свежих токенов (не старше 24 часов)
    const hasFreshTokens = await db.hasFreshTokens('Solana', 1500, 24);
    
    if (hasFreshTokens) {
      console.log('✅ Found ≥1500 fresh tokens in database, using them for monitoring');
      log('✅ Using fresh tokens from database (skipping CoinGecko - API credits saved)');
      
      // Загружаем токены из базы данных
      const freshTokens = await db.getFreshTokensFromCoinData('Solana', 24);
      
      // Преобразуем в формат SolanaToken
      const tokens = freshTokens
        .filter(row => row.mint && !row.mint.includes('placeholder'))
        .map(row => ({
          coinId: row.coin_id,
          mint: row.mint,
          symbol: row.symbol || row.coin_id.toUpperCase(),
          name: row.name || row.coin_id,
          marketCap: row.market_cap || (row.price * 1000000),
          fdv: row.fdv || (row.price * 1000000),
          volume24h: row.volume,
          priceUsd: row.price,
          priceChange24h: 0,
          age: 15,
          lastUpdated: row.timestamp
        }));
      
      // Обновляем список мониторинга через TokenAnalyzer
      
      // Обновляем TokenAnalyzer
      tokenAnalyzer.updateMonitoredTokensFromDatabase(tokens);
      
      // Обновляем Helius WebSocket
      helius.updateMonitoredTokens(tokens.map(t => t.mint));
      
      console.log(`✅ Database tokens loaded: ${tokens.length} tokens ready for monitoring`);
      log(`✅ Database tokens loaded: ${tokens.length} tokens ready for monitoring (API credits saved)`);
      
      return tokens.length;
      
    } else {
      console.log('❌ Not enough fresh tokens in database, fetching from CoinGecko...');
      log('❌ Not enough fresh tokens in database, fetching from CoinGecko (fallback mode)...');
      
      // Запускаем полное обновление токенов через CoinGecko
      await tokenRefresh();
      const monitoredCount = tokenAnalyzer.getMonitoredTokens().length;
      
      // Обновляем Helius WebSocket
      helius.updateMonitoredTokens(tokenAnalyzer.getMonitoredTokens());
      
      console.log(`✅ CoinGecko refresh complete: ${monitoredCount} tokens ready for monitoring`);
      log(`✅ CoinGecko refresh complete: ${monitoredCount} tokens ready for monitoring`);
      
      return monitoredCount;
    }
    
  } catch (error) {
    console.error(`❌ Error in token check: ${error}`);
    log(`❌ Error in token check: ${error}`, 'ERROR');
    await tg.sendErrorMessage(`Token Check Error: ${error}`);
    return 0;
  }
}

/**
 * Обновление списка токенов каждые 48 часов (сначала база, потом CoinGecko)
 */
async function tokenRefresh() {
  try {
    console.log('🔄 === TOKEN REFRESH STARTED ===');
    log('🔄 Token refresh starting (CoinGecko fallback)...');
    
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
    
    // Обновляем Helius WebSocket
    helius.updateMonitoredTokens(tokenAnalyzer.getMonitoredTokens());
    
    log(`✅ Token refresh complete: ${tokens.length} tokens ready for monitoring`);
    console.log(`✅ Token refresh complete: ${tokens.length} tokens ready for monitoring`);
    
    // Отправляем отчет
    const heliusCount = helius.getMonitoredTokensCount();
    await sendTokenRefreshReport(tokens.length, heliusCount);
    
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
  if (!helius.shouldMonitorToken(mint)) return; // фильтр через Helius
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
 * Отчет об обновлении токенов (каждые 12 часов)
 */
async function sendTokenRefreshReport(tokensCount: number, heliusTokensCount: number) {
  try {
    const message = `📊 **Token Status Report (12h cycle)**

🔄 **System Status:**
• Monitored Tokens: ${tokensCount}
• Helius Monitoring: ${heliusTokensCount} tokens
• Analysis Mode: Database-first + Helius
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

🎯 **Next token check in ~12 hours**
💡 **Smart Loading:** Database-first approach saves CoinGecko API credits`;

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
    log('🚀 Initializing Smart Solana Signal Bot...');
    
    // Отправляем уведомление о начале инициализации
    await tg.sendMessage(`🚀 **Smart Signal Bot Starting...**

⚙️ **Initialization in progress...**
• Database connection: Connecting...
• API testing: Starting...
• Token loading: Preparing...
• Smart loading: Database-first strategy...

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
      await checkAndUpdateTokens(); // Используем новую функцию для загрузки
      tokensLoaded = tokenAnalyzer.getMonitoredTokens().length;
      
      // Обновляем Helius WebSocket с загруженными токенами
      helius.updateMonitoredTokens(tokenAnalyzer.getMonitoredTokens());
      
      tokenStatus = tokensLoaded > 0 ? `✅ ${tokensLoaded} tokens` : '⚠️ No tokens';
    } catch (error) {
      log(`❌ Token refresh failed: ${error}`, 'ERROR');
      tokenStatus = `❌ Error: ${error}`;
    }
    
    // Настройка и запуск Helius WebSocket
    helius.onSwap = async (mint: string, swapData: any) => {
      await handleHeliusSignal(mint, swapData);
    };
    
    // Подключаемся к Helius WebSocket
    try {
      await helius.connect();
      log('✅ Helius WebSocket connected');
    } catch (error) {
      log(`❌ Helius WebSocket connection failed: ${error}`, 'ERROR');
    }
    
    // Отправляем детальное уведомление о статусе запуска
    const heliusStatus = helius.isConnectedToHelius() ? '✅ Connected' : '❌ Disconnected';
    const systemStatus = (tokensLoaded > 0 && coingeckoStatus.includes('✅') && helius.isConnectedToHelius()) ? '🟢 OPERATIONAL' : '🟡 PARTIAL';
    
    await tg.sendMessage(`🚀 **Smart Solana Signal Bot Started!**

📊 **System Status:** ${systemStatus}

🔧 **Component Status:**
• Database: ✅ Connected
• CoinGecko API: ${coingeckoStatus}
• Jupiter API: ${jupiterStatus}
• Helius WebSocket: ${heliusStatus}
• Token Loading: ${tokenStatus}

📈 **Configuration:**
• Analysis Mode: Database-first + Helius
• Strategy: 12h token check + Real-time monitoring
• Monitoring: ${tokensLoaded} tokens

💡 **Smart Token Loading:**
• Database check: ≥1500 fresh tokens (24h) = skip CoinGecko
• CoinGecko fallback: only when database insufficient
• 12h refresh cycle: optimal balance

${tokensLoaded > 0 ? '🔍 **Ready for signal detection!**' : '⚠️ **Limited functionality - token loading issues**'}

⏰ Started at: ${new Date().toLocaleString()}`);
    
    log('✅ Smart initialization complete');
    
  } catch (error) {
    log(`❌ Initialization failed: ${error}`, 'ERROR');
    
    // Отправляем уведомление об ошибке инициализации
    await tg.sendMessage(`🚨 **Smart Signal Bot Initialization Failed!**

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
    
    // Планируем проверку и обновление токенов каждые 12 часов
    setInterval(async () => {
      try {
        await checkAndUpdateTokens();
      } catch (error) {
        log(`Error in periodic token check: ${error}`, 'ERROR');
      }
    }, 12 * 60 * 60 * 1000); // 12 часов
    
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
        const heliusCount = helius.getMonitoredTokensCount();
        await sendTokenRefreshReport(monitoredCount, heliusCount);
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
    
    // Запускаем OHLCV Filler для заполнения пустых свечей
    const ohlcvIntervalMinutes = parseInt(process.env.OHLCV_FILL_INTERVAL_MINUTES || '1');
    ohlcvFiller.start(ohlcvIntervalMinutes);
    log(`📊 OHLCV Filler started with ${ohlcvIntervalMinutes} minute interval`);
    
    log('🎯 Smart Signal Bot is running...');
    
  } catch (error) {
    log(`❌ Failed to start: ${error}`, 'ERROR');
    process.exit(1);
  }
}

// Обработка сигналов завершения
process.on('SIGINT', async () => {
  log('🛑 Shutting down Smart Signal Bot...');
  
  // Отправляем уведомление об остановке
  try {
    await tg.sendMessage(`🛑 **Smart Signal Bot Shutting Down**

⚠️ **Manual shutdown detected (SIGINT)**
🔄 **Status:** Gracefully stopping all services...

📊 **Final Stats:**
• Uptime: ${Math.floor(process.uptime() / 60)} minutes
• Monitored Tokens: ${tokenAnalyzer.getMonitoredTokens().length}
• Helius Monitoring: ${helius.getMonitoredTokensCount()}
• API Usage: CoinGecko ${apiUsageStats.coingecko.dailyUsage}/333

🔌 **Disconnecting services...**`);
  } catch (error) {
    log(`Error sending shutdown notification: ${error}`, 'ERROR');
  }
  
  if (helius) {
    await helius.disconnect();
  }
  ohlcvFiller.stop();
  await db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  log('🛑 Shutting down Smart Signal Bot...');
  
  // Отправляем уведомление об остановке
  try {
    await tg.sendMessage(`🛑 **Smart Signal Bot Shutting Down**

⚠️ **System shutdown detected (SIGTERM)**
🔄 **Status:** Gracefully stopping all services...

📊 **Final Stats:**
• Uptime: ${Math.floor(process.uptime() / 60)} minutes
• Monitored Tokens: ${tokenAnalyzer.getMonitoredTokens().length}
• Helius Monitoring: ${helius.getMonitoredTokensCount()}
• API Usage: CoinGecko ${apiUsageStats.coingecko.dailyUsage}/333

🔌 **Disconnecting services...**`);
  } catch (error) {
    log(`Error sending shutdown notification: ${error}`, 'ERROR');
  }
  
  if (helius) {
    await helius.disconnect();
  }
  ohlcvFiller.stop();
  await db.close();
  process.exit(0);
});

// Запуск
start().catch(console.error); 