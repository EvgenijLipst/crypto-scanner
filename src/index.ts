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

// Инициализация компонентов
const db = new Database(process.env.DATABASE_URL!);
const tg = new TelegramBot(process.env.TELEGRAM_TOKEN!, process.env.TELEGRAM_CHAT_ID!);
const jupiter = new JupiterAPI();
const coingecko = new CoinGeckoAPI(process.env.COINGECKO_API_KEY!);
const helius = new HeliusWebSocket(process.env.HELIUS_API_KEY!, db, tg);

// Конфигурация анализа из переменных окружения
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

// Инициализируем систему диагностики
let diagnostics: DiagnosticsSystem;

// Статистика использования API
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
 * Ежедневное обновление списка токенов (CoinGecko - минимум)
 */
async function dailyTokenRefresh() {
  try {
    log('🔄 Daily token refresh starting...');
    
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
    
    // Получаем топ токены для мониторинга
    const tokens = await tokenAnalyzer.getTopTokensForMonitoring();
    apiUsageStats.coingecko.dailyUsage += 5; // Примерно 5 запросов на обновление
    
    log(`✅ Daily refresh complete: ${tokens.length} tokens ready for monitoring`);
    
    // Отправляем отчет
    await sendDailyReport(tokens.length);
    
  } catch (error) {
    log(`❌ Error in daily token refresh: ${error}`, 'ERROR');
    await tg.sendErrorMessage(`Daily Token Refresh Error: ${error}`);
  }
}

/**
 * Обработка сигналов от Helius WebSocket
 */
async function handleHeliusSignal(mint: string, swapData: any) {
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
    const message = `🚀 **BUY SIGNAL DETECTED** 🚀

💎 **${signal.symbol}** (${signal.name})
📍 Mint: \`${signal.mint}\`

📊 **Analysis Results:**
• Volume Spike: ${signal.data.volumeSpike?.toFixed(2)}x
• RSI: ${signal.data.rsi?.toFixed(2)}
• EMA Signal: ${signal.data.emaSignal ? '✅' : '❌'}
• Price Impact: ${signal.data.priceImpact?.toFixed(2)}%
• Liquidity: $${signal.data.liquidity?.toLocaleString()}

💰 **Market Data:**
• Price: $${signal.data.priceUsd?.toFixed(6)}
• Market Cap: $${signal.data.marketCap?.toLocaleString()}
• FDV: $${signal.data.fdv?.toLocaleString()}
• Volume 24h: $${signal.data.volume24h?.toLocaleString()}

⚡ **All criteria met - Ready to trade!**`;

    await tg.sendMessage(message);
    
  } catch (error) {
    log(`Error sending signal notification: ${error}`, 'ERROR');
  }
}

/**
 * Ежедневный отчет
 */
async function sendDailyReport(tokensCount: number) {
  try {
    const message = `📊 **Daily Token Analysis Report**

🔄 **System Status:**
• Monitored Tokens: ${tokensCount}
• Analysis Mode: Hybrid (CoinGecko + Helius)
• Status: Active 🟢

📈 **API Usage:**
• CoinGecko: ${apiUsageStats.coingecko.dailyUsage}/333 daily
• Helius: ${apiUsageStats.helius.dailyUsage}/33,333 daily

⚙️ **Configuration:**
• Min Age: ${analysisConfig.minTokenAgeDays} days
• Min Liquidity: $${analysisConfig.minLiquidityUsd.toLocaleString()}
• Max FDV: $${analysisConfig.maxFdvUsd.toLocaleString()}
• Min Volume Spike: ${analysisConfig.minVolumeSpike}x
• Max RSI Oversold: ${analysisConfig.maxRsiOversold}
• Max Price Impact: ${analysisConfig.maxPriceImpactPercent}%
• Test Amount: $${analysisConfig.priceImpactTestAmount}

🎯 **Next daily refresh in ~24 hours**`;

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
    
    // Инициализация базы данных
    await db.initialize();
    log('✅ Database initialized');
    
    // Инициализация диагностики
    diagnostics = new DiagnosticsSystem(db, tg);
    log('✅ Diagnostics system initialized');
    
    // Тестирование CoinGecko API
    log('🧪 Testing CoinGecko API...');
    const testTokens = await coingecko.getTopSolanaTokens(10);
    log(`✅ CoinGecko API working - fetched ${testTokens.length} test tokens`);
    
    // Тестирование Jupiter API
    log('🧪 Testing Jupiter API...');
    const testQuote = await jupiter.getQuote(
      'So11111111111111111111111111111111111111112', // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (правильный адрес)
      1000000000 // 1 SOL
    );
    log(`✅ Jupiter API working - got quote: ${testQuote ? 'success' : 'failed'}`);
    
    // Первоначальная загрузка токенов
    await dailyTokenRefresh();
    
    // Настройка Helius WebSocket с обработчиком сигналов
    helius.onSwap = handleHeliusSignal;
    
    // Запуск Helius WebSocket
    await helius.connect();
    log('✅ Helius WebSocket connected');
    
    // Отправляем уведомление о запуске
    await tg.sendMessage(`🚀 **Hybrid Solana Signal Bot Started!**

📊 **Analysis Mode:** CoinGecko + Helius
🎯 **Strategy:** Daily token refresh + Real-time monitoring
⚙️ **Monitoring:** ${tokenAnalyzer.getMonitoredTokens().length} tokens

💡 **API Optimization:**
• CoinGecko: Once daily refresh (saves credits)
• Helius: Real-time monitoring (uses available credits)

🔍 **Ready for signal detection!**`);
    
    log('✅ Hybrid initialization complete');
    
  } catch (error) {
    log(`❌ Initialization failed: ${error}`, 'ERROR');
    throw error;
  }
}

/**
 * Запуск системы
 */
async function start() {
  try {
    await initialize();
    
    // Планируем ежедневное обновление токенов (раз в 24 часа)
    setInterval(dailyTokenRefresh, 24 * 60 * 60 * 1000);
    
    // Планируем диагностику (каждые 10 минут)
    setInterval(async () => {
      try {
        await diagnostics.runDiagnostics();
      } catch (error) {
        log(`Error in diagnostics: ${error}`, 'ERROR');
      }
    }, 10 * 60 * 1000);
    
    // Планируем отчеты об активности (каждые 6 часов)
    setInterval(async () => {
      try {
        const monitoredCount = tokenAnalyzer.getMonitoredTokens().length;
        await sendDailyReport(monitoredCount);
      } catch (error) {
        log(`Error in activity report: ${error}`, 'ERROR');
      }
    }, 6 * 60 * 60 * 1000);
    
    // Планируем WebSocket отчеты (каждые 10 минут)
    setInterval(async () => {
      try {
        await helius.sendWebSocketActivityReport();
      } catch (error) {
        log(`Error in WebSocket activity report: ${error}`, 'ERROR');
      }
    }, 10 * 60 * 1000);
    
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
• Monitored Tokens: ${tokenAnalyzer.getMonitoredTokens().length}
• API Usage: CoinGecko ${apiUsageStats.coingecko.dailyUsage}/333

🔌 **Disconnecting services...**`);
  } catch (error) {
    log(`Error sending shutdown notification: ${error}`, 'ERROR');
  }
  
  await helius.disconnect();
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
• Monitored Tokens: ${tokenAnalyzer.getMonitoredTokens().length}
• API Usage: CoinGecko ${apiUsageStats.coingecko.dailyUsage}/333

🔌 **Disconnecting services...**`);
  } catch (error) {
    log(`Error sending shutdown notification: ${error}`, 'ERROR');
  }
  
  await helius.disconnect();
  await db.close();
  process.exit(0);
});

// Запуск
start().catch(console.error); 