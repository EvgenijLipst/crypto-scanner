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
        this.cache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
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
            const tokens = [];
            const perPage = 250; // Maximum per request
            const pages = Math.ceil(limit / perPage);
            for (let page = 1; page <= pages; page++) {
                const pageTokens = await this.fetchTokensPage(page, perPage);
                tokens.push(...pageTokens);
                if (tokens.length >= limit)
                    break;
                // Rate limiting - wait between requests
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            const solanaTokens = tokens.slice(0, limit);
            // Cache the result
            this.cache.set(cacheKey, {
                data: solanaTokens,
                timestamp: Date.now()
            });
            (0, utils_1.log)(`Successfully fetched ${solanaTokens.length} Solana tokens`);
            return solanaTokens;
        }
        catch (error) {
            (0, utils_1.log)(`Error fetching top Solana tokens: ${error}`, 'ERROR');
            return [];
        }
    }
    /**
     * Получить одну страницу токенов
     */
    async fetchTokensPage(page, perPage) {
        const url = `${this.baseUrl}/coins/markets`;
        const params = new URLSearchParams({
            vs_currency: 'usd',
            category: 'solana-ecosystem',
            order: 'market_cap_desc',
            per_page: perPage.toString(),
            page: page.toString(),
            sparkline: 'false',
            price_change_percentage: '1h,24h,7d'
        });
        const response = await (0, cross_fetch_1.default)(`${url}?${params}`, {
            headers: {
                'accept': 'application/json',
                'x-cg-demo-api-key': this.apiKey
            }
        });
        if (!response.ok) {
            throw new Error(`CoinGecko API error: ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        return data
            .filter(token => token.platforms?.solana) // Only tokens with Solana mint
            .map(token => ({
            mint: token.platforms.solana,
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
            const url = `${this.baseUrl}/coins/${tokenId}`;
            const response = await (0, cross_fetch_1.default)(url, {
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
            const url = `${this.baseUrl}/coins/${tokenId}/market_chart`;
            const params = new URLSearchParams({
                vs_currency: 'usd',
                days: days.toString(),
                interval: 'hourly'
            });
            const response = await (0, cross_fetch_1.default)(`${url}?${params}`, {
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
        (0, utils_1.log)('CoinGecko cache cleared');
    }
}
exports.CoinGeckoAPI = CoinGeckoAPI;
