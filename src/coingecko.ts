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

export class CoinGeckoAPI {
  private apiKey: string;
  private baseUrl = 'https://api.coingecko.com/api/v3';
  private cache: Map<string, { data: any; timestamp: number }> = new Map();
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes

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

      const tokens: SolanaToken[] = [];
      const perPage = 250; // Maximum per request
      const pages = Math.ceil(limit / perPage);

      for (let page = 1; page <= pages; page++) {
        const pageTokens = await this.fetchTokensPage(page, perPage);
        tokens.push(...pageTokens);
        
        if (tokens.length >= limit) break;
        
        // Rate limiting - wait between requests
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      const solanaTokens = tokens.slice(0, limit);
      
      // Cache the result
      this.cache.set(cacheKey, {
        data: solanaTokens,
        timestamp: Date.now()
      });

      log(`Successfully fetched ${solanaTokens.length} Solana tokens`);
      return solanaTokens;
      
    } catch (error) {
      log(`Error fetching top Solana tokens: ${error}`, 'ERROR');
      return [];
    }
  }

  /**
   * Получить одну страницу токенов
   */
  private async fetchTokensPage(page: number, perPage: number): Promise<SolanaToken[]> {
    const url = `${this.baseUrl}/coins/markets`;
    const params = new URLSearchParams({
      vs_currency: 'usd',
      // Убираем category для demo API - используем общий список
      // category: 'solana-ecosystem',
      order: 'market_cap_desc',
      per_page: perPage.toString(),
      page: page.toString(),
      sparkline: 'false',
      price_change_percentage: '1h,24h,7d'
    });

    const response = await fetch(`${url}?${params}`, {
      headers: {
        'accept': 'application/json',
        'x-cg-demo-api-key': this.apiKey
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`CoinGecko API error details: ${errorText}`, 'ERROR');
      throw new Error(`CoinGecko API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data: CoinGeckoToken[] = await response.json();
    
    return data
      .filter(token => token.platforms?.solana) // Only tokens with Solana mint
      .map(token => ({
        mint: token.platforms.solana!,
        symbol: token.symbol.toUpperCase(),
        name: token.name,
        marketCap: token.market_cap || 0,
        fdv: token.fully_diluted_valuation || token.market_cap || 0,
        volume24h: token.total_volume || 0,
        priceUsd: token.current_price || 0,
        priceChange24h: token.price_change_percentage_24h || 0,
        age: this.calculateTokenAge(token.ath_date),
        lastUpdated: token.last_updated
      }));
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

      const url = `${this.baseUrl}/coins/${tokenId}`;
      const response = await fetch(url, {
        headers: {
          'accept': 'application/json',
          'x-cg-demo-api-key': this.apiKey
        }
      });

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

      const url = `${this.baseUrl}/coins/${tokenId}/market_chart`;
      const params = new URLSearchParams({
        vs_currency: 'usd',
        days: days.toString(),
        interval: 'hourly'
      });

      const response = await fetch(`${url}?${params}`, {
        headers: {
          'accept': 'application/json',
          'x-cg-demo-api-key': this.apiKey
        }
      });

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
    log('CoinGecko cache cleared');
  }
} 