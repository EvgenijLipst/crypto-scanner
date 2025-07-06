require('dotenv').config();
const { Database } = require('./src/database');
const { TelegramBot } = require('./src/telegram');
const { CoinGeckoAPI } = require('./src/coingecko');
const { calculateRSI } = require('./src/indicators');

class SimpleSignalBot {
  constructor() {
    this.db = null;
    this.tg = null;
    this.coingecko = null;
    this.isRunning = false;
    
    this.stats = {
      tokensAnalyzed: 0,
      signalsGenerated: 0,
      lastSignalTime: null,
      startTime: new Date()
    };
  }

  async initialize() {
    console.log('🚀 Initializing Simple Signal Bot...');
    
    try {
      // Формируем DATABASE_URL из отдельных переменных Railway
      const databaseUrl = `postgresql://${process.env.PGUSER}:${process.env.PGPASSWORD}@${process.env.PGHOST}:${process.env.PGPORT}/${process.env.PGDATABASE}`;
      
      if (!process.env.PGUSER || !process.env.PGPASSWORD || !process.env.PGHOST) {
        throw new Error('Database connection variables not found in environment');
      }
      if (!process.env.TELEGRAM_TOKEN) {
        throw new Error('TELEGRAM_TOKEN not found in environment variables');
      }
      if (!process.env.TELEGRAM_CHAT_ID) {
        throw new Error('TELEGRAM_CHAT_ID not found in environment variables');
      }
      
      // Инициализация базы данных
      this.db = new Database(databaseUrl);
      await this.db.initialize();
      console.log('✅ Database connected');
      
      // Инициализация Telegram
      this.tg = new TelegramBot(process.env.TELEGRAM_TOKEN, process.env.TELEGRAM_CHAT_ID);
      console.log('✅ Telegram bot initialized');
      
      // Инициализация CoinGecko API
      this.coingecko = new CoinGeckoAPI(process.env.COINGECKO_API_KEY);
      console.log('✅ CoinGecko API initialized');
      
      // Отправляем уведомление о запуске
      await this.tg.sendMessage(`🚀 **REALISTIC Signal Bot Started!**\n\n` +
        `📊 **ТОЛЬКО РЕАЛЬНЫЕ Критерии:**\n` +
        `• Volume 24h: $50K+ minimum\n` +
        `• Market Cap: $500K - $5M\n` +
        `• RSI: <30 (сильно перепродан)\n` +
        `• Min 30 свечей истории\n` +
        `• Volume spike: 5x+\n\n` +
        `⏰ Started at: ${new Date().toLocaleString()}`);
      
      console.log('✅ Simple Signal Bot initialized successfully');
      
    } catch (error) {
      console.error('❌ Initialization failed:', error);
      throw error;
    }
  }

  async analyzeTokens() {
    try {
      console.log('🔄 Starting token analysis...');
      
      // Получаем токены из базы данных (реальные данные)
      const tokens = await this.db.getFreshTokensFromCoinData('Solana', 24);
      
      if (tokens.length === 0) {
        console.log('❌ No tokens found in database');
        return;
      }
      
      console.log(`📊 Analyzing ${tokens.length} tokens from database...`);
      
      for (const token of tokens) {
        try {
          const tokenData = {
            mint: token.mint,
            symbol: token.symbol,
            name: token.name,
            price: parseFloat(token.price),
            marketCap: parseFloat(token.market_cap || 0),
            volume24h: parseFloat(token.volume || 0)
          };
          
          await this.analyzeToken(tokenData);
          this.stats.tokensAnalyzed++;
          
          // Небольшая пауза между токенами
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (error) {
          console.error(`❌ Error analyzing ${token.symbol}:`, error.message);
        }
      }
      
      console.log(`✅ Analysis completed: ${this.stats.tokensAnalyzed} tokens analyzed`);
      
    } catch (error) {
      console.error('❌ Error in token analysis:', error.message);
    }
  }
  
  async analyzeToken(token) {
    // РЕАЛИСТИЧНАЯ фильтрация на основе доступных данных
    
    // 1. Проверяем объем (это у нас есть точно)
    if (token.volume24h < 50000) {
      return; // Минимум $50K объема
    }
    
    // 2. Проверяем капитализацию (это у нас есть точно)
    if (token.marketCap < 500000 || token.marketCap > 5000000) {
      return; // $500K - $5M диапазон
    }
    
    // 3. Получаем исторические данные (это у нас есть)
    const candles = await this.db.getCandles(token.mint, 40);
    
    if (candles.length < 30) {
      return; // Нужно минимум 30 свечей для анализа
    }
    
    // 4. Рассчитываем RSI (это мы можем)
    const closes = candles.map(c => parseFloat(c.c));
    const rsi = calculateRSI(closes, 14);
    
    if (rsi > 30) {
      return; // RSI должен быть меньше 30 (сильно перепродан)
    }
    
    // 5. Проверяем объемный всплеск (это мы можем)
    const currentVolume = parseFloat(candles[candles.length - 1].v);
    const avgVolume = candles.slice(-10).reduce((sum, c) => sum + parseFloat(c.v), 0) / 10;
    const volumeSpike = currentVolume / avgVolume;
    
    if (volumeSpike < 5) {
      return; // Всплеск объема должен быть минимум 5x
    }
    
    // 6. Проверяем изменение цены (это мы можем)
    const currentPrice = parseFloat(candles[candles.length - 1].c);
    const previousPrice = parseFloat(candles[candles.length - 2].c);
    const priceChange = ((currentPrice - previousPrice) / previousPrice) * 100;
    
    // СИГНАЛ НАЙДЕН!
    const reasons = [
      `RSI: ${rsi.toFixed(1)} (oversold)`,
      `Volume spike: ${volumeSpike.toFixed(1)}x`,
      `Price change: ${priceChange.toFixed(2)}%`,
      `Volume 24h: $${(token.volume24h / 1000).toFixed(0)}K`,
      `Market cap: $${(token.marketCap / 1000000).toFixed(1)}M`
    ];
    
    console.log(`🎯 SIGNAL FOUND: ${token.symbol} - ${reasons.join(', ')}`);
    
    // Сохраняем сигнал
    await this.db.createSignal(
      token.mint,
      token.symbol,
      true, // ema_cross
      volumeSpike,
      rsi,
      priceChange,
      token.volume24h,
      token.marketCap,
      reasons.join(', ')
    );
    
    // Отправляем уведомление
    await this.sendSignalNotification(token, {
      rsi,
      volumeSpike,
      priceChange,
      reasons
    });
    
    this.stats.signalsGenerated++;
    this.stats.lastSignalTime = new Date();
  }
  
  async sendSignalNotification(token, result) {
    try {
      const message = `🎯 **REALISTIC SIGNAL**\n\n` +
        `**${token.symbol}** (${token.name})\n` +
        `💰 Price: $${token.price?.toFixed(6) || 'N/A'}\n` +
        `📊 Market Cap: $${(token.marketCap / 1000000).toFixed(1)}M\n` +
        `📈 Volume 24h: $${(token.volume24h / 1000).toFixed(0)}K\n\n` +
        `🔍 **Analysis:**\n` +
        `• RSI: ${result.rsi.toFixed(1)} (oversold)\n` +
        `• Volume spike: ${result.volumeSpike.toFixed(1)}x\n` +
        `• Price change: ${result.priceChange.toFixed(2)}%\n\n` +
        `📍 \`${token.mint}\`\n` +
        `⏰ ${new Date().toLocaleString()}`;
      
      await this.tg.sendMessage(message);
      
    } catch (error) {
      console.error('❌ Error sending signal notification:', error.message);
    }
  }
  
  async sendStatusReport() {
    try {
      const uptime = Math.floor((Date.now() - this.stats.startTime.getTime()) / 1000 / 60);
      const lastSignal = this.stats.lastSignalTime 
        ? this.stats.lastSignalTime.toLocaleString()
        : 'No signals yet';
      
      const message = `📊 **Realistic Bot Status**\n\n` +
        `⏰ Uptime: ${uptime} minutes\n` +
        `🔍 Tokens analyzed: ${this.stats.tokensAnalyzed}\n` +
        `🎯 Signals generated: ${this.stats.signalsGenerated}\n` +
        `📅 Last signal: ${lastSignal}\n\n` +
        `🤖 Bot is running normally`;
      
      await this.tg.sendMessage(message);
      
    } catch (error) {
      console.error('❌ Error sending status report:', error.message);
    }
  }
  
  async start() {
    console.log('🚀 Starting Realistic Signal Bot...');
    
    try {
      await this.initialize();
      
      this.isRunning = true;
      
      // Запускаем анализ каждые 10 минут
      const analysisInterval = setInterval(async () => {
        if (this.isRunning) {
          await this.analyzeTokens();
        }
      }, 10 * 60 * 1000); // 10 минут
      
      // Отправляем статус каждые 60 минут
      const statusInterval = setInterval(async () => {
        if (this.isRunning) {
          await this.sendStatusReport();
        }
      }, 60 * 60 * 1000); // 60 минут
      
      // Первый запуск анализа
      await this.analyzeTokens();
      
      console.log('✅ Realistic Signal Bot started successfully');
      console.log('📊 Analysis runs every 10 minutes');
      console.log('📈 Status reports every 60 minutes');
      
      // Обработка сигналов завершения
      process.on('SIGINT', async () => {
        console.log('\n🛑 Shutting down bot...');
        this.isRunning = false;
        clearInterval(analysisInterval);
        clearInterval(statusInterval);
        await this.stop();
        process.exit(0);
      });
      
    } catch (error) {
      console.error('❌ Failed to start bot:', error);
      throw error;
    }
  }
  
  async stop() {
    console.log('🛑 Stopping Realistic Signal Bot...');
    this.isRunning = false;
    
    if (this.db) {
      await this.db.close();
    }
    
    console.log('✅ Bot stopped');
  }
}

async function main() {
  const bot = new SimpleSignalBot();
  await bot.start();
}

if (require.main === module) {
  main().catch(console.error);
} 