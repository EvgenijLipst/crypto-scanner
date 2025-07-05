"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CoinGeckoAPI = void 0;
// coingecko.ts - Оптимизированный CoinGecko API для экономии кредитов
const cross_fetch_1 = __importDefault(require("cross-fetch"));
const utils_1 = require("./utils");
class CoinGeckoAPI {
    constructor(apiKey) {
        this.baseUrl = 'https://api.coingecko.com/api/v3';
        this.proBaseUrl = 'https://pro-api.coingecko.com/api/v3';
        // Агрессивное кэширование для экономии кредитов
        this.cache = new Map();
        this.solanaTokensCache = [];
        this.solanaTokensCacheTime = 0;
        this.solanaTokensCacheTimeout = 24 * 60 * 60 * 1000; // 24 часа для списка токенов
        // Минимальные rate limits
        this.lastRequestTime = 0;
        this.requestDelay = 3000; // 3 секунды между запросами (очень консервативно)
        this.maxRetries = 2; // Меньше попыток для экономии
        // Счетчик использования API
        this.dailyUsage = 0;
        this.dailyLimit = 280; // Жесткий лимит на день (оставляем запас)
        this.lastResetDate = new Date().toDateString();
        this.apiKey = apiKey;
    }
    /**
     * Проверить дневной лимит
     */
    checkDailyLimit() {
        const today = new Date().toDateString();
        if (this.lastResetDate !== today) {
            this.dailyUsage = 0;
            this.lastResetDate = today;
        }
        if (this.dailyUsage >= this.dailyLimit) {
            (0, utils_1.log)(`⚠️ CoinGecko daily limit reached: ${this.dailyUsage}/${this.dailyLimit}`, 'WARN');
            return false;
        }
        return true;
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
     * Выполнить запрос с минимальными retry
     */
    async makeRequest(url, params, headers) {
        // Проверяем дневной лимит
        if (!this.checkDailyLimit()) {
            throw new Error('Daily API limit exceeded');
        }
        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            try {
                await this.waitForRateLimit();
                const response = await (0, cross_fetch_1.default)(`${url}?${params}`, { headers });
                this.dailyUsage++; // Увеличиваем счетчик использования
                if (response.status === 429) {
                    // Rate limit exceeded - ждем дольше
                    const waitTime = 60000; // 1 минута
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
    async getTopSolanaTokens(limit = 2000) {
        try {
            (0, utils_1.log)(`🔄 Fetching top ${limit} Solana tokens (optimized)...`);
            // Шаг 1: Получить список Solana токенов (кэш на 24 часа)
            const solanaTokens = await this.getAllSolanaTokens();
            (0, utils_1.log)(`Found ${solanaTokens.length} total Solana tokens`);
            if (solanaTokens.length === 0) {
                return [];
            }
            // Шаг 2: Получить рыночные данные для первых N токенов
            const tokensToAnalyze = Math.min(solanaTokens.length, limit);
            const topTokens = await this.getMarketDataForTokens(solanaTokens.slice(0, tokensToAnalyze));
            (0, utils_1.log)(`✅ Successfully fetched ${topTokens.length} Solana tokens (used ${this.dailyUsage}/${this.dailyLimit} daily credits)`);
            return topTokens;
        }
        catch (error) {
            (0, utils_1.log)(`Error fetching top Solana tokens: ${error}`, 'ERROR');
            return [];
        }
    }
    /**
     * Получить все токены Solana (кэш на 24 часа)
     */
    async getAllSolanaTokens() {
        try {
            // Проверяем кэш с 24-часовым временем жизни
            const now = Date.now();
            if (this.solanaTokensCache.length > 0 &&
                now - this.solanaTokensCacheTime < this.solanaTokensCacheTimeout) {
                (0, utils_1.log)('Using cached Solana tokens list (24h cache)');
                return this.solanaTokensCache;
            }
            (0, utils_1.log)('Fetching complete coins list (once per day)...');
            const url = `${this.baseUrl}/coins/list`;
            const params = new URLSearchParams({
                include_platform: 'true'
            });
            const headers = {
                'accept': 'application/json'
            };
            const allCoins = await this.makeRequest(url, params, headers);
            (0, utils_1.log)(`Retrieved ${allCoins.length} total coins`);
            // Фильтруем только Solana токены
            const solanaTokens = allCoins.filter(coin => coin.platforms?.solana);
            (0, utils_1.log)(`Found ${solanaTokens.length} Solana tokens`);
            // Кэшируем результат на 24 часа
            this.solanaTokensCache = solanaTokens;
            this.solanaTokensCacheTime = now;
            return solanaTokens;
        }
        catch (error) {
            (0, utils_1.log)(`Error fetching Solana tokens list: ${error}`, 'ERROR');
            return this.solanaTokensCache; // Возвращаем старый кэш при ошибке
        }
    }
    /**
     * Получить рыночные данные (минимальные батчи)
     */
    async getMarketDataForTokens(tokens) {
        try {
            (0, utils_1.log)(`Getting market data for ${tokens.length} tokens...`);
            const results = [];
            const batchSize = 50; // Увеличиваем батч для получения большего количества токенов
            for (let i = 0; i < tokens.length; i += batchSize) {
                // Проверяем лимит перед каждым батчем
                if (!this.checkDailyLimit()) {
                    (0, utils_1.log)(`Daily limit reached, stopping at ${results.length} tokens`);
                    break;
                }
                const batch = tokens.slice(i, i + batchSize);
                const batchIds = batch.map(token => token.id).join(',');
                try {
                    (0, utils_1.log)(`Fetching batch ${Math.floor(i / batchSize) + 1}: tokens ${i + 1}-${Math.min(i + batchSize, tokens.length)}`);
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
                                fdv: data.usd_market_cap || 0,
                                volume24h: data.usd_24h_vol || 0,
                                priceUsd: data.usd,
                                priceChange24h: data.usd_24h_change || 0,
                                age: 0,
                                lastUpdated: data.last_updated_at ? new Date(data.last_updated_at * 1000).toISOString() : new Date().toISOString()
                            });
                        }
                    }
                    (0, utils_1.log)(`Batch completed: ${results.length} tokens with price data`);
                    // Пауза между батчами для rate limiting
                    if (i + batchSize < tokens.length) {
                        (0, utils_1.log)(`Waiting 5 seconds before next batch...`);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
                catch (error) {
                    (0, utils_1.log)(`Error processing batch: ${error}`, 'ERROR');
                    break; // Прерываем при ошибке для экономии кредитов
                }
            }
            // Сортируем по market cap
            results.sort((a, b) => b.marketCap - a.marketCap);
            (0, utils_1.log)(`Successfully retrieved market data for ${results.length} Solana tokens`);
            return results;
        }
        catch (error) {
            (0, utils_1.log)(`Error getting market data: ${error}`, 'ERROR');
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
exports.CoinGeckoAPI = CoinGeckoAPI;
