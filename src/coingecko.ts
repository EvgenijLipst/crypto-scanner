// coingecko.ts - Оптимизированный CoinGecko API для экономии кредитов
import fetch from 'cross-fetch';
import { log } from './utils';

export interface CoinGeckoToken {
  id: string;
  symbol: string;
  name: string;
  platforms: {
    solana?: string; // mint address
  };
  current_price: number;
  market_cap: number;
  market_cap_rank: number;
  fully_diluted_valuation: number;
  total_volume: number;
  high_24h: number;
  low_24h: number;
  price_change_24h: number;
  price_change_percentage_24h: number;
  market_cap_change_24h: number;
  market_cap_change_percentage_24h: number;
  circulating_supply: number;
  total_supply: number;
  max_supply: number;
  ath: number;
  ath_change_percentage: number;
  ath_date: string;
  atl: number;
  atl_change_percentage: number;
  atl_date: string;
  roi: any;
  last_updated: string;
  price_change_percentage_1h_in_currency: number;
  price_change_percentage_24h_in_currency: number;
  price_change_percentage_7d_in_currency: number;
}

export interface CoinListItem {
  id: string;
  symbol: string;
  name: string;
  platforms?: {
    solana?: string;
  };
}

export interface SolanaToken {
  coinId: string; // Добавляем coinId из CoinGecko API
  mint: string;
  symbol: string;
  name: string;
  marketCap: number;
  fdv: number;
  volume24h: number;
  priceUsd: number;
  priceChange24h: number;
  age: number;
  lastUpdated: string;
}

export class CoinGeckoAPI {
  private apiKey: string;
  private baseUrl = 'https://api.coingecko.com/api/v3';
  private proBaseUrl = 'https://pro-api.coingecko.com/api/v3';
  
  // Агрессивное кэширование для экономии кредитов
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private solanaTokensCache: CoinListItem[] = [];
  private solanaTokensCacheTime = 0;
  private solanaTokensCacheTimeout = 48 * 60 * 60 * 1000; // 48 часов для списка токенов (топ-2000 редко меняются)
  
  // Минимальные rate limits
  private lastRequestTime = 0;
  private requestDelay = 3000; // 3 секунды между запросами (очень консервативно)
  private maxRetries = 2; // Меньше попыток для экономии
  
  // Счетчик использования API
  private dailyUsage = 0;
  private dailyLimit = 280; // Жесткий лимит на день (оставляем запас)
  private lastResetDate = new Date().toDateString();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Проверить дневной лимит
   */
  private checkDailyLimit(): boolean {
    const today = new Date().toDateString();
    if (this.lastResetDate !== today) {
      this.dailyUsage = 0;
      this.lastResetDate = today;
    }
    
    if (this.dailyUsage >= this.dailyLimit) {
      log(`⚠️ CoinGecko daily limit reached: ${this.dailyUsage}/${this.dailyLimit}`, 'WARN');
      return false;
    }
    
    return true;
  }

  /**
   * Ожидание для соблюдения rate limiting
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.requestDelay) {
      const waitTime = this.requestDelay - timeSinceLastRequest;
      log(`Rate limiting: waiting ${waitTime}ms before next request`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  /**
   * Выполнить запрос с минимальными retry
   */
  private async makeRequest(url: string, params: URLSearchParams, headers: Record<string, string>): Promise<any> {
    // Проверяем дневной лимит
    if (!this.checkDailyLimit()) {
      throw new Error('Daily API limit exceeded');
    }
    
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        await this.waitForRateLimit();
        
        const response = await fetch(`${url}?${params}`, { headers });
        this.dailyUsage++; // Увеличиваем счетчик использования
        
        if (response.status === 429) {
          // Rate limit exceeded - ждем дольше, но не зависаем навсегда
          const waitTime = 60000; // 1 минута
          log(`Rate limit exceeded. Waiting ${waitTime}ms before retry ${attempt}/${this.maxRetries}`, 'WARN');
          
          if (attempt < this.maxRetries) {
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
          } else {
            // Если исчерпали попытки - возвращаем пустой результат вместо зависания
            log(`Max retries exceeded for rate limit, returning empty result`, 'WARN');
            return [];
          }
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`CoinGecko API error: ${response.status} ${response.statusText} - ${errorText}`);
        }

        return await response.json();
        
      } catch (error) {
        log(`Request attempt ${attempt}/${this.maxRetries} failed: ${error}`, 'WARN');
        
        if (attempt === this.maxRetries) {
          throw error;
        }
        
        // Короткий backoff для экономии времени
        const backoffDelay = 5000; // 5 секунд
        await new Promise(resolve => setTimeout(resolve, backoffDelay));
      }
    }
    
    throw new Error('Max retries exceeded');
  }

  /**
   * Получить топ Solana токены (оптимизированная версия)
   */
  async getTopSolanaTokens(limit: number = 2000, onBatchComplete?: (batch: SolanaToken[]) => Promise<void>): Promise<SolanaToken[]> {
    try {
      log(`🔄 Fetching top ${limit} Solana tokens (optimized)...`);
      
      // Шаг 1: Получить список Solana токенов (кэш на 24 часа)
      const solanaTokens = await this.getAllSolanaTokens();
      log(`Found ${solanaTokens.length} total Solana tokens`);

      if (solanaTokens.length === 0) {
        return [];
      }

      // Шаг 2: Получить рыночные данные для первых N токенов (до 2000)
      const maxTokensPerRequest = Math.min(2000, limit); // Увеличиваем лимит до 2000
      const tokensToAnalyze = Math.min(solanaTokens.length, maxTokensPerRequest);
      log(`Preparing to fetch market data for ${tokensToAnalyze} tokens`);
      const topTokens = await this.getMarketDataForTokens(solanaTokens.slice(0, tokensToAnalyze), onBatchComplete);
      log(`✅ Successfully fetched market data for ${topTokens.length} Solana tokens (used ${this.dailyUsage}/${this.dailyLimit} daily credits)`);
      return topTokens;
      
    } catch (error) {
      log(`Error fetching top Solana tokens: ${error}`, 'ERROR');
      return [];
    }
  }

  /**
   * Получить все токены Solana (кэш на 48 часов)
   */
  private async getAllSolanaTokens(): Promise<CoinListItem[]> {
    try {
      // Проверяем кэш с 48-часовым временем жизни
      const now = Date.now();
      if (this.solanaTokensCache.length > 0 && 
          now - this.solanaTokensCacheTime < this.solanaTokensCacheTimeout) {
        log('Using cached Solana tokens list (48h cache)');
        return this.solanaTokensCache;
      }

      log('Fetching complete coins list (once per 48 hours)...');
      
      const url = `${this.baseUrl}/coins/list`;
      const params = new URLSearchParams({
        include_platform: 'true'
      });

      const headers: Record<string, string> = {
        'accept': 'application/json'
      };

      const allCoins: CoinListItem[] = await this.makeRequest(url, params, headers);
      log(`Retrieved ${allCoins.length} total coins`);

      // Фильтруем только Solana токены
      const solanaTokens = allCoins.filter(coin => coin.platforms?.solana);
      log(`Found ${solanaTokens.length} Solana tokens`);

      // Кэшируем результат на 48 часов
      this.solanaTokensCache = solanaTokens;
      this.solanaTokensCacheTime = now;
      
      return solanaTokens;
      
    } catch (error) {
      log(`Error fetching Solana tokens list: ${error}`, 'ERROR');
      return this.solanaTokensCache; // Возвращаем старый кэш при ошибке
    }
  }

  /**
   * Получить рыночные данные (минимальные батчи)
   */
  private async getMarketDataForTokens(tokens: CoinListItem[], onBatchComplete?: (batch: SolanaToken[]) => Promise<void>): Promise<SolanaToken[]> {
    try {
      log(`Getting market data for ${tokens.length} tokens...`);
      
      const results: SolanaToken[] = [];
      const loadedSymbols: string[] = [];
      const batchSize = 50; // Увеличиваем батч для получения большего количества токенов
      
      for (let i = 0; i < tokens.length; i += batchSize) {
        // Проверяем лимит перед каждым батчем
        if (!this.checkDailyLimit()) {
          log(`Daily limit reached, stopping at ${results.length} tokens`);
          break;
        }
        
        const batch = tokens.slice(i, i + batchSize);
        const batchIds = batch.map(token => token.id).join(',');
        
        try {
          log(`Fetching batch ${Math.floor(i / batchSize) + 1}: tokens ${i + 1}-${Math.min(i + batchSize, tokens.length)}`);
          
          const url = `${this.baseUrl}/simple/price`;
          const params = new URLSearchParams({
            ids: batchIds,
            vs_currencies: 'usd',
            include_market_cap: 'true',
            include_24hr_vol: 'true',
            include_24hr_change: 'true',
            include_last_updated_at: 'true'
          });

          const headers: Record<string, string> = {
            'accept': 'application/json'
          };

          const priceData = await this.makeRequest(url, params, headers);
          
          // Обрабатываем результаты батча
          const batchResults: SolanaToken[] = [];
          for (const token of batch) {
            const data = priceData[token.id];
            if (data && data.usd) {
              const solanaToken = {
                coinId: token.id, // Добавляем coinId
                mint: token.platforms!.solana!,
                symbol: token.symbol.toUpperCase(),
                name: token.name,
                marketCap: data.usd_market_cap || 0,
                fdv: data.usd_market_cap || 0,
                volume24h: data.usd_24h_vol || 0,
                priceUsd: data.usd,
                priceChange24h: data.usd_24h_change || 0,
                age: 15, // Предполагаем что токены достаточно старые
                lastUpdated: new Date(data.last_updated_at * 1000).toISOString()
              };
              
              batchResults.push(solanaToken);
              results.push(solanaToken);
              loadedSymbols.push(`${token.symbol}:${token.platforms!.solana!}`);
              
              log(`📊 Token loaded: ${token.symbol} (${token.name})`);
              log(`   • Mint: ${token.platforms!.solana!}`);
              log(`   • Price: $${data.usd}`);
              log(`   • Market Cap: $${data.usd_market_cap || 0}`);
              log(`   • Volume 24h: $${data.usd_24h_vol || 0}`);
            } else {
              log(`⚠️ No price data for token: ${token.symbol} (${token.name})`);
            }
          }
          
          log(`Batch completed: ${batchResults.length} tokens with price data`);
          
          // СРАЗУ СОХРАНЯЕМ БАТЧ В БАЗУ ДАННЫХ
          if (onBatchComplete && batchResults.length > 0) {
            try {
              log(`🔄 Immediately saving batch ${Math.floor(i / batchSize) + 1} (${batchResults.length} tokens) to database...`);
              await onBatchComplete(batchResults);
              log(`✅ Successfully saved batch ${Math.floor(i / batchSize) + 1} to database`);
            } catch (saveError) {
              log(`❌ Error saving batch ${Math.floor(i / batchSize) + 1} to database: ${saveError}`, 'ERROR');
            }
          }
          
          // Ждем 5 секунд между батчами для соблюдения rate limiting
          if (i + batchSize < tokens.length) {
            log(`Waiting 5 seconds before next batch...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
          
        } catch (error) {
          log(`Error fetching batch ${Math.floor(i / batchSize) + 1}: ${error}`, 'ERROR');
          // Продолжаем с следующим батчем
        }
      }
      
      log(`LOADED SYMBOLS COUNT: ${loadedSymbols.length}`);
      log(`LOADED SYMBOLS SAMPLE: ${loadedSymbols.slice(0, 10).join(', ')}`);
      
      // Финальная статистика
      log(`📋 === FINAL TOKEN SUMMARY ===`);
      log(`Total tokens loaded: ${results.length}`);
      log(`Top 10 tokens by market cap:`);
      const sortedByMarketCap = [...results].sort((a, b) => b.marketCap - a.marketCap).slice(0, 10);
      sortedByMarketCap.forEach((token, index) => {
        log(`${index + 1}. ${token.symbol} - $${token.priceUsd} - MC: $${token.marketCap}`);
        log(`   Mint: ${token.mint}`);
      });
      log(`Tokens with real mint addresses: ${results.filter(t => t.mint && !t.mint.includes('placeholder')).length}`);
      log(`Tokens without mint: ${results.filter(t => !t.mint || t.mint.includes('placeholder')).length}`);
      log(`=== END SUMMARY ===`);
      
      return results;
      
    } catch (error) {
      log(`Error in getMarketDataForTokens: ${error}`, 'ERROR');
      return [];
    }
  }

  /**
   * Получить статистику использования API
   */
  getUsageStats() {
    return {
      dailyUsage: this.dailyUsage,
      dailyLimit: this.dailyLimit,
      remaining: this.dailyLimit - this.dailyUsage,
      resetDate: this.lastResetDate
    };
  }
} 