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
        this.solanaTokensCacheTimeout = 48 * 60 * 60 * 1000; // 48 часов для списка токенов (топ-2000 редко меняются)
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
                    // Rate limit exceeded - ждем дольше, но не зависаем навсегда
                    const waitTime = 60000; // 1 минута
                    (0, utils_1.log)(`Rate limit exceeded. Waiting ${waitTime}ms before retry ${attempt}/${this.maxRetries}`, 'WARN');
                    if (attempt < this.maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue;
                    }
                    else {
                        // Если исчерпали попытки - возвращаем пустой результат вместо зависания
                        (0, utils_1.log)(`Max retries exceeded for rate limit, returning empty result`, 'WARN');
                        return [];
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
    async getTopSolanaTokens(limit = 2000, onBatchComplete) {
        try {
            (0, utils_1.log)(`🔄 Fetching top ${limit} Solana tokens (optimized)...`);
            // Шаг 1: Получить список Solana токенов (кэш на 24 часа)
            const solanaTokens = await this.getAllSolanaTokens();
            (0, utils_1.log)(`Found ${solanaTokens.length} total Solana tokens`);
            if (solanaTokens.length === 0) {
                return [];
            }
            // Шаг 2: Получить рыночные данные для первых N токенов (до 2000)
            const maxTokensPerRequest = Math.min(2000, limit); // Увеличиваем лимит до 2000
            const tokensToAnalyze = Math.min(solanaTokens.length, maxTokensPerRequest);
            (0, utils_1.log)(`Preparing to fetch market data for ${tokensToAnalyze} tokens`);
            const topTokens = await this.getMarketDataForTokens(solanaTokens.slice(0, tokensToAnalyze), onBatchComplete);
            (0, utils_1.log)(`✅ Successfully fetched market data for ${topTokens.length} Solana tokens (used ${this.dailyUsage}/${this.dailyLimit} daily credits)`);
            return topTokens;
        }
        catch (error) {
            (0, utils_1.log)(`Error fetching top Solana tokens: ${error}`, 'ERROR');
            return [];
        }
    }
    /**
     * Получить все токены Solana (кэш на 48 часов)
     */
    async getAllSolanaTokens() {
        try {
            // Проверяем кэш с 48-часовым временем жизни
            const now = Date.now();
            if (this.solanaTokensCache.length > 0 &&
                now - this.solanaTokensCacheTime < this.solanaTokensCacheTimeout) {
                (0, utils_1.log)('Using cached Solana tokens list (48h cache)');
                return this.solanaTokensCache;
            }
            (0, utils_1.log)('Fetching complete coins list (once per 48 hours)...');
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
            // Кэшируем результат на 48 часов
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
    async getMarketDataForTokens(tokens, onBatchComplete) {
        try {
            (0, utils_1.log)(`Getting market data for ${tokens.length} tokens...`);
            const results = [];
            const loadedSymbols = [];
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
                    // Обрабатываем результаты батча
                    const batchResults = [];
                    for (const token of batch) {
                        const data = priceData[token.id];
                        if (data && data.usd) {
                            const solanaToken = {
                                coinId: token.id, // Добавляем coinId
                                mint: token.platforms.solana,
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
                            loadedSymbols.push(`${token.symbol}:${token.platforms.solana}`);
                            (0, utils_1.log)(`📊 Token loaded: ${token.symbol} (${token.name})`);
                            (0, utils_1.log)(`   • Mint: ${token.platforms.solana}`);
                            (0, utils_1.log)(`   • Price: $${data.usd}`);
                            (0, utils_1.log)(`   • Market Cap: $${data.usd_market_cap || 0}`);
                            (0, utils_1.log)(`   • Volume 24h: $${data.usd_24h_vol || 0}`);
                        }
                        else {
                            (0, utils_1.log)(`⚠️ No price data for token: ${token.symbol} (${token.name})`);
                        }
                    }
                    (0, utils_1.log)(`Batch completed: ${batchResults.length} tokens with price data`);
                    // СРАЗУ СОХРАНЯЕМ БАТЧ В БАЗУ ДАННЫХ
                    if (onBatchComplete && batchResults.length > 0) {
                        try {
                            (0, utils_1.log)(`🔄 Immediately saving batch ${Math.floor(i / batchSize) + 1} (${batchResults.length} tokens) to database...`);
                            await onBatchComplete(batchResults);
                            (0, utils_1.log)(`✅ Successfully saved batch ${Math.floor(i / batchSize) + 1} to database`);
                        }
                        catch (saveError) {
                            (0, utils_1.log)(`❌ Error saving batch ${Math.floor(i / batchSize) + 1} to database: ${saveError}`, 'ERROR');
                        }
                    }
                    // Ждем 5 секунд между батчами для соблюдения rate limiting
                    if (i + batchSize < tokens.length) {
                        (0, utils_1.log)(`Waiting 5 seconds before next batch...`);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }
                catch (error) {
                    (0, utils_1.log)(`Error fetching batch ${Math.floor(i / batchSize) + 1}: ${error}`, 'ERROR');
                    // Продолжаем с следующим батчем
                }
            }
            (0, utils_1.log)(`LOADED SYMBOLS COUNT: ${loadedSymbols.length}`);
            (0, utils_1.log)(`LOADED SYMBOLS SAMPLE: ${loadedSymbols.slice(0, 10).join(', ')}`);
            // Финальная статистика
            (0, utils_1.log)(`📋 === FINAL TOKEN SUMMARY ===`);
            (0, utils_1.log)(`Total tokens loaded: ${results.length}`);
            (0, utils_1.log)(`Top 10 tokens by market cap:`);
            const sortedByMarketCap = [...results].sort((a, b) => b.marketCap - a.marketCap).slice(0, 10);
            sortedByMarketCap.forEach((token, index) => {
                (0, utils_1.log)(`${index + 1}. ${token.symbol} - $${token.priceUsd} - MC: $${token.marketCap}`);
                (0, utils_1.log)(`   Mint: ${token.mint}`);
            });
            (0, utils_1.log)(`Tokens with real mint addresses: ${results.filter(t => t.mint && !t.mint.includes('placeholder')).length}`);
            (0, utils_1.log)(`Tokens without mint: ${results.filter(t => !t.mint || t.mint.includes('placeholder')).length}`);
            (0, utils_1.log)(`=== END SUMMARY ===`);
            return results;
        }
        catch (error) {
            (0, utils_1.log)(`Error in getMarketDataForTokens: ${error}`, 'ERROR');
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
