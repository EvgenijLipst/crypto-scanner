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
        this.solanaTokensCacheTime = 0;
        this.solanaTokensCacheTimeout = 30 * 60 * 1000; // 30 minutes for tokens list
        // Rate limiting для бесплатного API
        this.lastRequestTime = 0;
        this.requestDelay = 2000; // 2 секунды между запросами для бесплатного API
        this.maxRetries = 3;
        this.apiKey = apiKey;
        // Если есть API ключ, уменьшаем задержку
        if (apiKey && apiKey.length > 0) {
            this.requestDelay = 1000; // 1 секунда для API с ключом
        }
    }
    /**
     * Ожидание для соблюдения rate limiting
     */
    async waitForRateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.requestDelay) {
            const waitTime = this.requestDelay - timeSinceLastRequest;
            (0, utils_1.log)(`Rate limiting: waiting ${waitTime}ms before next request`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        this.lastRequestTime = Date.now();
    }
    /**
     * Выполнить запрос с retry логикой
     */
    async makeRequest(url, params, headers) {
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                await this.waitForRateLimit();
                const response = await (0, cross_fetch_1.default)(`${url}?${params}`, { headers });
                if (response.status === 429) {
                    // Rate limit exceeded
                    const retryAfter = response.headers.get('retry-after');
                    const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 60000; // Default 1 minute
                    (0, utils_1.log)(`Rate limit exceeded. Waiting ${waitTime}ms before retry ${attempt}/${this.maxRetries}`, 'WARN');
                    if (attempt < this.maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue;
                    }
                }
                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`CoinGecko API error: ${response.status} ${response.statusText} - ${errorText}`);
                }
                return await response.json();
            }
            catch (error) {
                (0, utils_1.log)(`Request attempt ${attempt}/${this.maxRetries} failed: ${error}`, 'WARN');
                if (attempt === this.maxRetries) {
                    throw error;
                }
                // Exponential backoff
                const backoffDelay = Math.min(1000 * Math.pow(2, attempt), 30000);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
            }
        }
        throw new Error('Max retries exceeded');
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
            // Шаг 2: Получить рыночные данные для топ токенов (ограничиваем до разумного количества)
            const tokensToAnalyze = Math.min(solanaTokens.length, limit, 500); // Максимум 500 токенов за раз
            const topTokens = await this.getMarketDataForTokens(solanaTokens.slice(0, tokensToAnalyze), tokensToAnalyze);
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
            // Проверяем кэш с более длительным временем жизни
            const now = Date.now();
            if (this.solanaTokensCache.length > 0 &&
                now - this.solanaTokensCacheTime < this.solanaTokensCacheTimeout) {
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
            const allCoins = await this.makeRequest(url, params, headers);
            (0, utils_1.log)(`Retrieved ${allCoins.length} total coins`);
            // Фильтруем только Solana токены
            const solanaTokens = allCoins.filter(coin => coin.platforms?.solana);
            (0, utils_1.log)(`Found ${solanaTokens.length} Solana tokens`);
            // Кэшируем результат с таймстампом
            this.solanaTokensCache = solanaTokens;
            this.solanaTokensCacheTime = now;
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
            const batchSize = 50; // Уменьшаем размер батча для бесплатного API
            // Разбиваем на батчи
            const tokensToProcess = tokens.slice(0, Math.min(tokens.length, limit));
            for (let i = 0; i < tokensToProcess.length; i += batchSize) {
                const batch = tokensToProcess.slice(i, i + batchSize);
                const batchIds = batch.map(token => token.id).join(',');
                try {
                    (0, utils_1.log)(`Fetching batch ${Math.floor(i / batchSize) + 1}: tokens ${i + 1}-${Math.min(i + batchSize, tokensToProcess.length)}`);
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
                    const priceData = await this.makeRequest(url, params, headers);
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
                    // Дополнительная пауза между батчами для бесплатного API
                    if (i + batchSize < tokensToProcess.length) {
                        (0, utils_1.log)(`Waiting 3 seconds before next batch...`);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                    }
                }
                catch (error) {
                    (0, utils_1.log)(`Error processing batch ${Math.floor(i / batchSize) + 1}: ${error}`, 'ERROR');
                    // При ошибке rate limit делаем большую паузу
                    if (error instanceof Error && error.toString().includes('429')) {
                        (0, utils_1.log)('Rate limit error detected, waiting 60 seconds...', 'WARN');
                        await new Promise(resolve => setTimeout(resolve, 60000));
                    }
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
