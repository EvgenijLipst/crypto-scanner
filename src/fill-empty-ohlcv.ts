// fill-empty-ohlcv.ts - Гибридная схема заполнения OHLCV
// Автоматически создает пустые свечи для токенов без торговой активности

import { Database } from './database';
import { log, bucketTs } from './utils';

interface TokenInfo {
  mint: string;
  symbol: string;
  coin_id: string;
}

interface CoingeckoPrice {
  [symbol: string]: {
    usd: number;
    usd_24h_vol?: number;
  };
}

export class OHLCVFiller {
  private database: Database;
  private coingeckoApiKey: string | null;
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(database: Database, coingeckoApiKey?: string) {
    this.database = database;
    this.coingeckoApiKey = coingeckoApiKey || null;
  }

  /**
   * Запустить периодическое заполнение OHLCV
   */
  start(intervalMinutes: number = 1): void {
    if (this.isRunning) {
      log('⚠️ OHLCV filler is already running');
      return;
    }

    this.isRunning = true;
    log(`🚀 Starting OHLCV filler with ${intervalMinutes} minute interval`);

    // Запускаем сразу
    this.fillEmptyCandles();

    // Затем по расписанию
    this.intervalId = setInterval(() => {
      this.fillEmptyCandles();
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Остановить заполнение OHLCV
   */
  stop(): void {
    if (!this.isRunning) {
      log('⚠️ OHLCV filler is not running');
      return;
    }

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    log('🛑 OHLCV filler stopped');
  }

  /**
   * Основной метод заполнения пустых свечей
   */
  async fillEmptyCandles(): Promise<void> {
    try {
      log('🔄 Starting OHLCV fill cycle...');
      
      // Получаем все токены из coin_data
      const tokens = await this.database.getAllTokensFromCoinData('Solana');
      log(`📊 Processing ${tokens.length} tokens from coin_data`);

      if (tokens.length === 0) {
        log('⚠️ No tokens found in coin_data');
        return;
      }

      // Получаем текущий timestamp для минуты
      const currentMinute = bucketTs(Math.floor(Date.now() / 1000));
      
      // Получаем цены с Coingecko для всех токенов
      const prices = await this.fetchPricesFromCoingecko(tokens);
      
      let processedCount = 0;
      let emptyCandlesCreated = 0;
      let priceFetchedCount = 0;

      // Обрабатываем каждый токен
      for (const token of tokens) {
        try {
          // Проверяем, есть ли уже свеча за текущий период
          const hasCandle = await this.database.hasCandleForPeriod(token.mint, currentMinute);
          
          if (!hasCandle) {
            // Нет свечи - нужно создать пустую
            let price = 0;
            
            // Сначала пытаемся получить последнюю известную цену из базы
            const lastKnownPrice = await this.database.getLastKnownPrice(token.mint);
            
            if (lastKnownPrice && lastKnownPrice > 0) {
              price = lastKnownPrice;
              log(`📈 Using last known price for ${token.symbol}: $${price}`);
            } else {
              // Если нет цены в базе, берем с Coingecko
              const coingeckoPrice = prices[token.symbol.toLowerCase()];
              if (coingeckoPrice && coingeckoPrice.usd > 0) {
                price = coingeckoPrice.usd;
                priceFetchedCount++;
                log(`🌐 Using Coingecko price for ${token.symbol}: $${price}`);
              } else {
                log(`⚠️ No price available for ${token.symbol} (${token.mint})`);
                continue; // Пропускаем токены без цены
              }
            }

            // Создаем пустую свечу
            await this.database.createEmptyCandle(token.mint, price, currentMinute);
            emptyCandlesCreated++;
          }
          
          processedCount++;
          
          // Логируем прогресс каждые 100 токенов
          if (processedCount % 100 === 0) {
            log(`📊 Processed ${processedCount}/${tokens.length} tokens...`);
          }
          
        } catch (error) {
          log(`❌ Error processing token ${token.symbol}: ${error}`, 'ERROR');
        }
      }

      log(`✅ OHLCV fill cycle completed:`);
      log(`   • Processed: ${processedCount} tokens`);
      log(`   • Empty candles created: ${emptyCandlesCreated}`);
      log(`   • Prices fetched from Coingecko: ${priceFetchedCount}`);
      log(`   • Current minute timestamp: ${currentMinute}`);

    } catch (error) {
      log(`❌ Error in fillEmptyCandles: ${error}`, 'ERROR');
    }
  }

  /**
   * Получить цены с Coingecko API
   */
  private async fetchPricesFromCoingecko(tokens: TokenInfo[]): Promise<CoingeckoPrice> {
    try {
      // Группируем токены по 250 (лимит Coingecko API)
      const batchSize = 250;
      const batches = [];
      
      for (let i = 0; i < tokens.length; i += batchSize) {
        batches.push(tokens.slice(i, i + batchSize));
      }

      const allPrices: CoingeckoPrice = {};
      
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const symbols = batch.map(t => t.symbol.toLowerCase()).join(',');
        
        log(`🌐 Fetching Coingecko prices for batch ${i + 1}/${batches.length} (${batch.length} tokens)`);
        
        try {
          const url = `https://api.coingecko.com/api/v3/simple/price?ids=${symbols}&vs_currencies=usd&include_24hr_vol=true`;
          
          const response = await fetch(url, {
            headers: this.coingeckoApiKey ? {
              'X-CG-API-KEY': this.coingeckoApiKey
            } : {}
          });

          if (!response.ok) {
            const errorText = await response.text();
            log(`❌ Coingecko API error (batch ${i + 1}): ${response.status} - ${errorText}`, 'ERROR');
            continue;
          }

          const prices = await response.json();
          Object.assign(allPrices, prices);
          
          // Небольшая задержка между запросами (чтобы не превысить лимиты)
          if (i < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
        } catch (error) {
          log(`❌ Error fetching Coingecko batch ${i + 1}: ${error}`, 'ERROR');
        }
      }

      log(`🌐 Successfully fetched prices for ${Object.keys(allPrices).length} tokens from Coingecko`);
      return allPrices;
      
    } catch (error) {
      log(`❌ Error in fetchPricesFromCoingecko: ${error}`, 'ERROR');
      return {};
    }
  }

  /**
   * Получить статистику работы
   */
  getStats(): { isRunning: boolean; lastRun?: number } {
    return {
      isRunning: this.isRunning
    };
  }
}

// Экспорт для использования в других модулях
export default OHLCVFiller; 