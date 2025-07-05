"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoinGeckoAPI = void 0;
// coingecko.ts - CoinGecko API для получения топ токенов Solana
const cross_fetch_1 = __importDefault(require("cross-fetch"));
const utils_1 = require("./utils");
class CoinGeckoAPI {
    constructor(apiKey) {
        this.baseUrl = 'https://api.coingecko.com/api/v3';
        this.proBaseUrl = 'https://pro-api.coingecko.com/api/v3';
        this.cache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
        this.solanaTokensCache = [];
        this.apiKey = apiKey;
    }
    /**
     * Получить топ-2000 токенов Solana
     */
    async getTopSolanaTokens(limit = 2000) {
        try {
            (0, utils_1.log)(`Fetching top ${limit} Solana tokens from CoinGecko...`);
            const cacheKey = `top-solana-${limit}`;
            const cached = this.cache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
                (0, utils_1.log)(`Using cached data for top Solana tokens`);
                return cached.data;
            }
            // Шаг 1: Получить все Solana токены
            const solanaTokens = await this.getAllSolanaTokens();
            (0, utils_1.log)(`Found ${solanaTokens.length} total Solana tokens`);
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
            (0, utils_1.log)(`Successfully fetched ${topTokens.length} Solana tokens with market data`);
            return topTokens;
        }
        catch (error) {
            (0, utils_1.log)(`Error fetching top Solana tokens: ${error}`, 'ERROR');
            return [];
        }
    }
    /**
     * Получить все токены Solana из списка
     */
    async getAllSolanaTokens() {
        try {
            // Проверяем кэш
            if (this.solanaTokensCache.length > 0) {
                (0, utils_1.log)('Using cached Solana tokens list');
                return this.solanaTokensCache;
            }
            (0, utils_1.log)('Fetching complete coins list with platforms...');
            // Используем бесплатный API для стабильности
            const url = `${this.baseUrl}/coins/list`;
            const params = new URLSearchParams({
                include_platform: 'true'
            });
            const headers = {
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
            const response = await (0, cross_fetch_1.default)(`${url}?${params}`, { headers });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`CoinGecko API error: ${response.status} ${response.statusText} - ${errorText}`);
            }
            const allCoins = await response.json();
            (0, utils_1.log)(`Retrieved ${allCoins.length} total coins`);
            // Фильтруем только Solana токены
            const solanaTokens = allCoins.filter(coin => coin.platforms?.solana);
            (0, utils_1.log)(`Found ${solanaTokens.length} Solana tokens`);
            // Кэшируем результат
            this.solanaTokensCache = solanaTokens;
            return solanaTokens;
        }
        catch (error) {
            (0, utils_1.log)(`Error fetching Solana tokens list: ${error}`, 'ERROR');
            return [];
        }
    }
    /**
     * Получить рыночные данные для токенов
     */
    async getMarketDataForTokens(tokens, limit) {
        try {
            (0, utils_1.log)(`Getting market data for ${Math.min(tokens.length, limit)} tokens...`);
            const results = [];
            const batchSize = 100; // Получаем цены по 100 токенов за раз
            // Разбиваем на батчи
            for (let i = 0; i < Math.min(tokens.length, limit); i += batchSize) {
                const batch = tokens.slice(i, i + batchSize);
                const batchIds = batch.map(token => token.id).join(',');
                try {
                    (0, utils_1.log)(`Fetching batch ${Math.floor(i / batchSize) + 1}: tokens ${i + 1}-${Math.min(i + batchSize, tokens.length)}`);
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
                    const headers = {
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
                    const response = await (0, cross_fetch_1.default)(`${url}?${params}`, { headers });
                    if (!response.ok) {
                        (0, utils_1.log)(`Error fetching batch ${Math.floor(i / batchSize) + 1}: ${response.status} ${response.statusText}`, 'ERROR');
                        continue;
                    }
                    const priceData = await response.json();
                    // Обрабатываем результаты
                    for (const token of batch) {
                        const data = priceData[token.id];
                        if (data && data.usd) {
                            results.push({
                                mint: token.platforms.solana,
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
                    (0, utils_1.log)(`Batch ${Math.floor(i / batchSize) + 1} completed: ${results.length} tokens with price data`);
                    // Rate limiting
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                catch (error) {
                    (0, utils_1.log)(`Error processing batch ${Math.floor(i / batchSize) + 1}: ${error}`, 'ERROR');
                }
            }
            // Сортируем по market cap (по убыванию)
            results.sort((a, b) => b.marketCap - a.marketCap);
            (0, utils_1.log)(`Successfully retrieved market data for ${results.length} Solana tokens`);
            return results.slice(0, limit);
        }
        catch (error) {
            (0, utils_1.log)(`Error getting market data: ${error}`, 'ERROR');
            return [];
        }
    }
    /**
     * Вычислить возраст токена в днях
     */
    calculateTokenAge(athDate) {
        try {
            const athTimestamp = new Date(athDate).getTime();
            const now = Date.now();
            return Math.floor((now - athTimestamp) / (24 * 60 * 60 * 1000));
        }
        catch (error) {
            return 0; // If can't calculate, assume new token
        }
    }
    /**
     * Получить детальную информацию о токене
     */
    async getTokenDetails(tokenId) {
        try {
            const cacheKey = `token-${tokenId}`;
            const cached = this.cache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
                return cached.data;
            }
            const baseUrl = this.apiKey ? this.proBaseUrl : this.baseUrl;
            const url = `${baseUrl}/coins/${tokenId}`;
            const params = new URLSearchParams();
            const headers = {
                'accept': 'application/json'
            };
            if (this.apiKey) {
                if (this.apiKey.startsWith('CG-')) {
                    params.append('x_cg_pro_api_key', this.apiKey);
                }
                else {
                    headers['x-cg-demo-api-key'] = this.apiKey;
                }
            }
            const response = await (0, cross_fetch_1.default)(`${url}?${params}`, { headers });
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
        }
        catch (error) {
            (0, utils_1.log)(`Error fetching token details for ${tokenId}: ${error}`, 'ERROR');
            return null;
        }
    }
    /**
     * Получить исторические данные цены токена
     */
    async getTokenPriceHistory(tokenId, days = 30) {
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
            const headers = {
                'accept': 'application/json'
            };
            if (this.apiKey) {
                if (this.apiKey.startsWith('CG-')) {
                    params.append('x_cg_pro_api_key', this.apiKey);
                }
                else {
                    headers['x-cg-demo-api-key'] = this.apiKey;
                }
            }
            const response = await (0, cross_fetch_1.default)(`${url}?${params}`, { headers });
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
        }
        catch (error) {
            (0, utils_1.log)(`Error fetching price history for ${tokenId}: ${error}`, 'ERROR');
            return [];
        }
    }
    /**
     * Очистить кэш
     */
    clearCache() {
        this.cache.clear();
        this.solanaTokensCache = [];
        (0, utils_1.log)('CoinGecko cache cleared');
    }
}
exports.CoinGeckoAPI = CoinGeckoAPI;
