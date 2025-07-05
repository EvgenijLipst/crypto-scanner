// coingecko.ts - CoinGecko API для получения топ токенов Solana
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

export interface SolanaToken {
  mint: string;
  symbol: string;
  name: string;
  marketCap: number;
  fdv: number;
  volume24h: number;
  priceUsd: number;
  priceChange24h: number;
  age: number; // days since token creation
  lastUpdated: string;
}

export interface CoinListItem {
  id: string;
  symbol: string;
  name: string;
  platforms?: {
    solana?: string;
  };
}

export class CoinGeckoAPI {
  private apiKey: string;
  private baseUrl = 'https://api.coingecko.com/api/v3';
  private proBaseUrl = 'https://pro-api.coingecko.com/api/v3';
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes
  private solanaTokensCache: CoinListItem[] = [];

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Получить топ-2000 токенов Solana
   */
  async getTopSolanaTokens(limit: number = 2000): Promise<SolanaToken[]> {
    try {
      log(`Fetching top ${limit} Solana tokens from CoinGecko...`);
      
      const cacheKey = `top-solana-${limit}`;
      const cached = this.cache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        log(`Using cached data for top Solana tokens`);
        return cached.data;
      }

      // Шаг 1: Получить все Solana токены
      const solanaTokens = await this.getAllSolanaTokens();
      log(`Found ${solanaTokens.length} total Solana tokens`);

      if (solanaTokens.length === 0) {
        return [];
      }

      // Шаг 2: Получить рыночные данные для топ токенов
      const topTokens = await this.getMarketDataForTokens(solanaTokens, limit);
      
      // Cache the result
      this.cache.set(cacheKey, {
        data: topTokens,
        timestamp: Date.now()
      });

      log(`Successfully fetched ${topTokens.length} Solana tokens with market data`);
      return topTokens;
      
    } catch (error) {
      log(`Error fetching top Solana tokens: ${error}`, 'ERROR');
      return [];
    }
  }

  /**
   * Получить все токены Solana из списка
   */
  private async getAllSolanaTokens(): Promise<CoinListItem[]> {
    try {
      // Проверяем кэш
      if (this.solanaTokensCache.length > 0) {
        log('Using cached Solana tokens list');
        return this.solanaTokensCache;
      }

      log('Fetching complete coins list with platforms...');
      
      // Используем бесплатный API для стабильности
      const url = `${this.baseUrl}/coins/list`;
      
      const params = new URLSearchParams({
        include_platform: 'true'
      });

      const headers: Record<string, string> = {
        'accept': 'application/json'
      };

      // Временно отключаем API ключ для стабильности
      // if (this.apiKey) {
      //   if (this.apiKey.startsWith('CG-')) {
      //     params.append('x_cg_pro_api_key', this.apiKey);
      //   } else {
      //     headers['x-cg-demo-api-key'] = this.apiKey;
      //   }
      // }

      const response = await fetch(`${url}?${params}`, { headers });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`CoinGecko API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const allCoins: CoinListItem[] = await response.json();
      log(`Retrieved ${allCoins.length} total coins`);

      // Фильтруем только Solana токены
      const solanaTokens = allCoins.filter(coin => coin.platforms?.solana);
      log(`Found ${solanaTokens.length} Solana tokens`);

      // Кэшируем результат
      this.solanaTokensCache = solanaTokens;
      
      return solanaTokens;
      
    } catch (error) {
      log(`Error fetching Solana tokens list: ${error}`, 'ERROR');
      return [];
    }
  }

  /**
   * Получить рыночные данные для токенов
   */
  private async getMarketDataForTokens(tokens: CoinListItem[], limit: number): Promise<SolanaToken[]> {
    try {
      log(`Getting market data for ${Math.min(tokens.length, limit)} tokens...`);
      
      const results: SolanaToken[] = [];
      const batchSize = 100; // Получаем цены по 100 токенов за раз
      
      // Разбиваем на батчи
      for (let i = 0; i < Math.min(tokens.length, limit); i += batchSize) {
        const batch = tokens.slice(i, i + batchSize);
        const batchIds = batch.map(token => token.id).join(',');
        
        try {
          log(`Fetching batch ${Math.floor(i / batchSize) + 1}: tokens ${i + 1}-${Math.min(i + batchSize, tokens.length)}`);
          
          // Используем бесплатный API для стабильности
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

          // Временно отключаем API ключ для стабильности
          // if (this.apiKey) {
          //   if (this.apiKey.startsWith('CG-')) {
          //     params.append('x_cg_pro_api_key', this.apiKey);
          //   } else {
          //     headers['x-cg-demo-api-key'] = this.apiKey;
          //   }
          // }

          const response = await fetch(`${url}?${params}`, { headers });

          if (!response.ok) {
            log(`Error fetching batch ${Math.floor(i / batchSize) + 1}: ${response.status} ${response.statusText}`, 'ERROR');
            continue;
          }

          const priceData = await response.json();
          
          // Обрабатываем результаты
          for (const token of batch) {
            const data = priceData[token.id];
            if (data && data.usd) {
              results.push({
                mint: token.platforms!.solana!,
                symbol: token.symbol.toUpperCase(),
                name: token.name,
                marketCap: data.usd_market_cap || 0,
                fdv: data.usd_market_cap || 0, // FDV часто равен market cap
                volume24h: data.usd_24h_vol || 0,
                priceUsd: data.usd,
                priceChange24h: data.usd_24h_change || 0,
                age: 0, // Будем вычислять отдельно если нужно
                lastUpdated: data.last_updated_at ? new Date(data.last_updated_at * 1000).toISOString() : new Date().toISOString()
              });
            }
          }
          
          log(`Batch ${Math.floor(i / batchSize) + 1} completed: ${results.length} tokens with price data`);
          
          // Rate limiting
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          log(`Error processing batch ${Math.floor(i / batchSize) + 1}: ${error}`, 'ERROR');
        }
      }

      // Сортируем по market cap (по убыванию)
      results.sort((a, b) => b.marketCap - a.marketCap);
      
      log(`Successfully retrieved market data for ${results.length} Solana tokens`);
      return results.slice(0, limit);
      
    } catch (error) {
      log(`Error getting market data: ${error}`, 'ERROR');
      return [];
    }
  }

  /**
   * Вычислить возраст токена в днях
   */
  private calculateTokenAge(athDate: string): number {
    try {
      const athTimestamp = new Date(athDate).getTime();
      const now = Date.now();
      return Math.floor((now - athTimestamp) / (24 * 60 * 60 * 1000));
    } catch (error) {
      return 0; // If can't calculate, assume new token
    }
  }

  /**
   * Получить детальную информацию о токене
   */
  async getTokenDetails(tokenId: string): Promise<any> {
    try {
      const cacheKey = `token-${tokenId}`;
      const cached = this.cache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }

      const baseUrl = this.apiKey ? this.proBaseUrl : this.baseUrl;
      const url = `${baseUrl}/coins/${tokenId}`;
      
      const params = new URLSearchParams();
      const headers: Record<string, string> = {
        'accept': 'application/json'
      };

      if (this.apiKey) {
        if (this.apiKey.startsWith('CG-')) {
          params.append('x_cg_pro_api_key', this.apiKey);
        } else {
          headers['x-cg-demo-api-key'] = this.apiKey;
        }
      }

      const response = await fetch(`${url}?${params}`, { headers });

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      // Cache the result
      this.cache.set(cacheKey, {
        data,
        timestamp: Date.now()
      });

      return data;
      
    } catch (error) {
      log(`Error fetching token details for ${tokenId}: ${error}`, 'ERROR');
      return null;
    }
  }

  /**
   * Получить исторические данные цены токена
   */
  async getTokenPriceHistory(tokenId: string, days: number = 30): Promise<Array<[number, number]>> {
    try {
      const cacheKey = `history-${tokenId}-${days}`;
      const cached = this.cache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
        return cached.data;
      }

      const baseUrl = this.apiKey ? this.proBaseUrl : this.baseUrl;
      const url = `${baseUrl}/coins/${tokenId}/market_chart`;
      
      const params = new URLSearchParams({
        vs_currency: 'usd',
        days: days.toString(),
        interval: 'hourly'
      });

      const headers: Record<string, string> = {
        'accept': 'application/json'
      };

      if (this.apiKey) {
        if (this.apiKey.startsWith('CG-')) {
          params.append('x_cg_pro_api_key', this.apiKey);
        } else {
          headers['x-cg-demo-api-key'] = this.apiKey;
        }
      }

      const response = await fetch(`${url}?${params}`, { headers });

      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const prices = data.prices || [];
      
      // Cache the result
      this.cache.set(cacheKey, {
        data: prices,
        timestamp: Date.now()
      });

      return prices;
      
    } catch (error) {
      log(`Error fetching price history for ${tokenId}: ${error}`, 'ERROR');
      return [];
    }
  }

  /**
   * Очистить кэш
   */
  clearCache(): void {
    this.cache.clear();
    this.solanaTokensCache = [];
    log('CoinGecko cache cleared');
  }
} 