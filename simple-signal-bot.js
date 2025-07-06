require('dotenv').config();

const { TokenAnalyzer } = require('./src/token-analyzer');
const { Database } = require('./src/database');
const { TelegramBot } = require('./src/telegram');
const { CoinGeckoAPI } = require('./src/coingecko');
const { JupiterAPI } = require('./src/jupiter');

class SimpleSignalBot {
  constructor() {
    this.db = null;
    this.tg = null;
    this.coingecko = null;
    this.jupiter = null;
    this.tokenAnalyzer = null;
    
    this.isRunning = false;
    this.tokensCache = [];
    this.lastTokenRefresh = 0;
    this.tokenRefreshInterval = 12 * 60 * 60 * 1000; // 12 часов
    
    this.analysisInterval = 5 * 60 * 1000; // Анализ каждые 5 минут
    this.batchSize = 20; // Анализируем по 20 токенов за раз
    this.currentBatchIndex = 0;
    
    this.stats = {
      tokensAnalyzed: 0,
      signalsGenerated: 0,
      lastSignalTime: null,
      startTime: Date.now()
    };
  }

  async initialize() {
    console.log('🚀 Initializing Simple Signal Bot...');
    
    try {
      // Инициализация базы данных
      this.db = new Database(process.env.DATABASE_URL);
      await this.db.initialize();
      console.log('✅ Database connected');
      
      // Инициализация Telegram
      this.tg = new TelegramBot(process.env.TELEGRAM_TOKEN, process.env.TELEGRAM_CHAT_ID);
      console.log('✅ Telegram bot initialized');
      
      // Инициализация CoinGecko API
      this.coingecko = new CoinGeckoAPI(process.env.COINGECKO_API_KEY);
      console.log('✅ CoinGecko API initialized');
      
      // Инициализация Jupiter API
      this.jupiter = new JupiterAPI();
      console.log('✅ Jupiter API initialized');
      
      // Инициализация анализатора токенов
      this.tokenAnalyzer = new TokenAnalyzer(this.coingecko, this.jupiter, this.db, {
        minVolumeSpike: 2,
        maxRsiOversold: 45,
        minLiquidityUsd: 5000,
        maxPriceImpactPercent: 5
      });
      console.log('✅ Token analyzer initialized');
      
      // Отправляем уведомление о запуске
      await this.tg.sendMessage(`🚀 **Simple Signal Bot Started!**\n\n` +
        `📊 **Configuration:**\n` +
        `• Monitoring: Top 2000 CoinGecko tokens\n` +
        `• Analysis interval: 5 minutes\n` +
        `• Batch size: 20 tokens\n` +
        `• Token refresh: 12 hours\n\n` +
        `🎯 **Signal Criteria:**\n` +
        `• Volume spike: ≥2x\n` +
        `• RSI: <45\n` +
        `• Min liquidity: $5K\n` +
        `• Need 2+ criteria met\n\n` +
        `⏰ Started at: ${new Date().toLocaleString()}`);
      
      console.log('✅ Simple Signal Bot initialized successfully');
      
    } catch (error) {
      console.error('❌ Initialization failed:', error);
      throw error;
    }
  }

  async refreshTokens() {
    try {
      console.log('🔄 Refreshing top 2000 tokens from CoinGecko...');
      
      const tokens = await this.tokenAnalyzer.getTopTokensForMonitoring();
      
      if (tokens.length > 0) {
        this.tokensCache = tokens;
        this.lastTokenRefresh = Date.now();
        this.currentBatchIndex = 0; // Сбрасываем индекс батча
        
        console.log(`✅ Loaded ${tokens.length} tokens for monitoring`);
        
        await this.tg.sendMessage(`🔄 **Token Refresh Complete**\n\n` +
          `📊 **Statistics:**\n` +
          `• Total tokens loaded: ${tokens.length}\n` +
          `• Source: ${tokens.length > 1500 ? 'CoinGecko API' : 'Database cache'}\n` +
          `• Next refresh: ${new Date(Date.now() + this.tokenRefreshInterval).toLocaleString()}\n\n` +
          `🎯 **Ready for signal analysis!**`);
        
      } else {
        console.log('⚠️ No tokens loaded, keeping existing cache');
      }
      
    } catch (error) {
      console.error('❌ Error refreshing tokens:', error);
      await this.tg.sendMessage(`❌ **Token Refresh Failed**\n\n` +
        `Error: ${error.message}\n\n` +
        `Will retry on next cycle.`);
    }
  }

  async analyzeTokenBatch() {
    if (this.tokensCache.length === 0) {
      console.log('⚠️ No tokens in cache, skipping analysis');
      return;
    }

    try {
      // Получаем следующий батч токенов
      const startIndex = this.currentBatchIndex;
      const endIndex = Math.min(startIndex + this.batchSize, this.tokensCache.length);
      const batch = this.tokensCache.slice(startIndex, endIndex);
      
      console.log(`🔍 Analyzing batch ${Math.floor(startIndex / this.batchSize) + 1}: tokens ${startIndex + 1}-${endIndex} of ${this.tokensCache.length}`);
      
      let signalsInBatch = 0;
      
      for (const token of batch) {
        try {
          // Получаем исторические данные из базы
          const candles = await this.db.getCandles(token.mint, 40);
          
          if (candles.length < 30) {
            continue; // Недостаточно данных
          }
          
          // Простой анализ на основе OHLCV данных
          const result = await this.analyzeTokenForSignal(token, candles);
          
          this.stats.tokensAnalyzed++;
          
          if (result.isSignal) {
            signalsInBatch++;
            this.stats.signalsGenerated++;
            this.stats.lastSignalTime = new Date();
            
            // Сохраняем сигнал в базу
            await this.db.createSignal(
              token.mint,
              true, // is_buy
              result.data.volumeSpike || 0,
              result.data.rsi || 0
            );
            
            // Отправляем уведомление
            await this.sendSignalNotification(token, result);
            
            console.log(`🚀 SIGNAL: ${token.symbol} (${token.mint})`);
          }
          
        } catch (error) {
          console.error(`❌ Error analyzing ${token.symbol}:`, error.message);
        }
        
        // Небольшая пауза между токенами
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Переходим к следующему батчу
      this.currentBatchIndex = endIndex;
      
      // Если дошли до конца, начинаем сначала
      if (this.currentBatchIndex >= this.tokensCache.length) {
        this.currentBatchIndex = 0;
        console.log('🔄 Completed full cycle, starting over');
      }
      
      console.log(`✅ Batch analysis complete: ${signalsInBatch} signals generated`);
      
    } catch (error) {
      console.error('❌ Error in batch analysis:', error);
    }
  }

  async analyzeTokenForSignal(token, candles) {
    // Простой анализ на основе последних свечей
    const recentCandles = candles.slice(-30); // Последние 30 минут
    const closes = recentCandles.map(c => Number(c.c));
    const volumes = recentCandles.map(c => Number(c.v));
    
    // Рассчитываем простые индикаторы
    const currentPrice = closes[closes.length - 1];
    const avgPrice = closes.reduce((a, b) => a + b, 0) / closes.length;
    const priceChange = ((currentPrice - avgPrice) / avgPrice) * 100;
    
    // Volume spike
    const recentVolume = volumes.slice(-5).reduce((a, b) => a + b, 0);
    const avgVolume = volumes.slice(-20, -5).reduce((a, b) => a + b, 0) / 15;
    const volumeSpike = avgVolume > 0 ? recentVolume / (avgVolume * 5) : 0;
    
    // Простой RSI
    const gains = [];
    const losses = [];
    for (let i = 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) {
        gains.push(change);
        losses.push(0);
      } else {
        gains.push(0);
        losses.push(Math.abs(change));
      }
    }
    const avgGain = gains.slice(-14).reduce((a, b) => a + b, 0) / 14;
    const avgLoss = losses.slice(-14).reduce((a, b) => a + b, 0) / 14;
    const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
    
    // Проверяем критерии сигнала
    const volumeOk = volumeSpike >= 2;
    const rsiOk = rsi < 45;
    const priceOk = priceChange > -5 && priceChange < 10; // Не слишком большие движения
    const liquidityOk = token.volume24h >= 5000; // Минимальный объем
    
    const criteriaMet = [volumeOk, rsiOk, priceOk, liquidityOk].filter(Boolean).length;
    const isSignal = criteriaMet >= 2;
    
    const reasons = [];
    if (volumeOk) reasons.push(`Volume spike: ${volumeSpike.toFixed(2)}x`);
    if (rsiOk) reasons.push(`RSI: ${rsi.toFixed(1)}`);
    if (priceOk) reasons.push(`Price change: ${priceChange.toFixed(2)}%`);
    if (liquidityOk) reasons.push(`Volume 24h: $${token.volume24h.toLocaleString()}`);
    
    return {
      isSignal,
      reasons,
      data: {
        volumeSpike,
        rsi,
        priceChange,
        volume24h: token.volume24h
      }
    };
  }

  async sendSignalNotification(token, result) {
    const message = `🚀 **BUY SIGNAL DETECTED** 🚀\n\n` +
      `💎 **${token.symbol}** (${token.name})\n` +
      `📍 Mint: \`${token.mint}\`\n\n` +
      `📊 **Analysis:**\n` +
      `• Volume Spike: ${result.data.volumeSpike.toFixed(2)}x\n` +
      `• RSI: ${result.data.rsi.toFixed(1)}\n` +
      `• Price Change: ${result.data.priceChange.toFixed(2)}%\n` +
      `• Volume 24h: $${result.data.volume24h.toLocaleString()}\n\n` +
      `💡 **Reasons:** ${result.reasons.join(', ')}\n\n` +
      `🔗 **Links:**\n` +
      `[📊 Birdeye](https://birdeye.so/token/${token.mint})\n` +
      `[📈 DEXScreener](https://dexscreener.com/solana/${token.mint})\n\n` +
      `⏰ ${new Date().toLocaleString()}`;
    
    await this.tg.sendMessage(message);
  }

  async sendStatusReport() {
    const uptime = Date.now() - this.stats.startTime;
    const uptimeHours = Math.floor(uptime / (1000 * 60 * 60));
    const uptimeMinutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
    
    const message = `📊 **Signal Bot Status Report**\n\n` +
      `⏱️ **Uptime:** ${uptimeHours}h ${uptimeMinutes}m\n` +
      `📈 **Statistics:**\n` +
      `• Tokens analyzed: ${this.stats.tokensAnalyzed.toLocaleString()}\n` +
      `• Signals generated: ${this.stats.signalsGenerated}\n` +
      `• Last signal: ${this.stats.lastSignalTime ? this.stats.lastSignalTime.toLocaleString() : 'None'}\n\n` +
      `🔄 **Current Status:**\n` +
      `• Tokens in cache: ${this.tokensCache.length}\n` +
      `• Current batch: ${Math.floor(this.currentBatchIndex / this.batchSize) + 1}\n` +
      `• Next token refresh: ${new Date(this.lastTokenRefresh + this.tokenRefreshInterval).toLocaleString()}\n\n` +
      `✅ **Bot is running smoothly!**`;
    
    await this.tg.sendMessage(message);
  }

  async start() {
    console.log('🚀 Starting Simple Signal Bot...');
    
    try {
      await this.initialize();
      
      // Загружаем токены при запуске
      await this.refreshTokens();
      
      this.isRunning = true;
      
      // Основной цикл анализа
      const analysisLoop = async () => {
        while (this.isRunning) {
          try {
            // Проверяем, нужно ли обновить токены
            if (Date.now() - this.lastTokenRefresh > this.tokenRefreshInterval) {
              await this.refreshTokens();
            }
            
            // Анализируем следующий батч токенов
            await this.analyzeTokenBatch();
            
            // Ждем до следующего анализа
            await new Promise(resolve => setTimeout(resolve, this.analysisInterval));
            
          } catch (error) {
            console.error('❌ Error in analysis loop:', error);
            await new Promise(resolve => setTimeout(resolve, 60000)); // Ждем минуту при ошибке
          }
        }
      };
      
      // Запускаем цикл анализа
      analysisLoop();
      
      // Отправляем статус каждые 6 часов
      setInterval(async () => {
        try {
          await this.sendStatusReport();
        } catch (error) {
          console.error('❌ Error sending status report:', error);
        }
      }, 6 * 60 * 60 * 1000);
      
      console.log('✅ Simple Signal Bot started successfully!');
      
    } catch (error) {
      console.error('❌ Failed to start bot:', error);
      process.exit(1);
    }
  }

  async stop() {
    console.log('🛑 Stopping Simple Signal Bot...');
    this.isRunning = false;
    
    await this.tg.sendMessage(`🛑 **Signal Bot Stopped**\n\n` +
      `📊 **Final Statistics:**\n` +
      `• Tokens analyzed: ${this.stats.tokensAnalyzed.toLocaleString()}\n` +
      `• Signals generated: ${this.stats.signalsGenerated}\n\n` +
      `⏰ Stopped at: ${new Date().toLocaleString()}`);
  }
}

// Запуск бота
async function main() {
  const bot = new SimpleSignalBot();
  
  // Обработка сигналов завершения
  process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, stopping bot...');
    await bot.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\n🛑 Received SIGTERM, stopping bot...');
    await bot.stop();
    process.exit(0);
  });
  
  await bot.start();
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = SimpleSignalBot; 