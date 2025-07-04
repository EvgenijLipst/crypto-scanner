"use strict";
// jupiter.ts - Работа с Jupiter API
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.JupiterAPI = void 0;
const cross_fetch_1 = __importDefault(require("cross-fetch"));
const types_1 = require("./types");
const utils_1 = require("./utils");
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;
class JupiterAPI {
    constructor() {
        this.baseUrl = 'https://quote-api.jup.ag/v6';
    }
    /**
     * Получить котировку от Jupiter
     */
    async getQuote(inputMint, outputMint, amount, slippageBps = 50) {
        try {
            const url = `${this.baseUrl}/quote?` +
                `inputMint=${inputMint}&` +
                `outputMint=${outputMint}&` +
                `amount=${amount}&` +
                `slippageBps=${slippageBps}`;
            const response = await (0, cross_fetch_1.default)(url);
            if (!response.ok) {
                (0, utils_1.log)(`Jupiter API error: ${response.status} ${response.statusText}`, 'ERROR');
                return null;
            }
            const quote = await response.json();
            return quote;
        }
        catch (error) {
            (0, utils_1.log)(`Error fetching Jupiter quote: ${error}`, 'ERROR');
            return null;
        }
    }
    /**
     * Проверить price impact для токена
     */
    async checkPriceImpact(mint, amountUsd = 200) {
        try {
            // Конвертируем USD в lamports USDC
            const amountLamports = Math.round(amountUsd * Math.pow(10, USDC_DECIMALS));
            // Получаем котировку на покупку
            const quote = await this.getQuote(USDC_MINT, mint, amountLamports);
            if (!quote) {
                return { priceImpact: 100, passed: false };
            }
            const priceImpact = parseFloat(quote.priceImpactPct) * 100;
            const passed = priceImpact <= types_1.MAX_PRICE_IMPACT_PERCENT;
            (0, utils_1.log)(`Price impact check for ${mint}: ${priceImpact.toFixed(2)}% (${passed ? 'PASS' : 'FAIL'})`);
            return { priceImpact, passed };
        }
        catch (error) {
            (0, utils_1.log)(`Error checking price impact for ${mint}: ${error}`, 'ERROR');
            return { priceImpact: 100, passed: false };
        }
    }
    /**
     * Получить цену токена в USDC
     */
    async getTokenPrice(mint, tokenAmount, decimals) {
        try {
            const amountLamports = Math.round(tokenAmount * Math.pow(10, decimals));
            const quote = await this.getQuote(mint, USDC_MINT, amountLamports);
            if (!quote) {
                return null;
            }
            const usdcAmount = parseFloat(quote.outAmount) / Math.pow(10, USDC_DECIMALS);
            const pricePerToken = usdcAmount / tokenAmount;
            return pricePerToken;
        }
        catch (error) {
            (0, utils_1.log)(`Error getting token price for ${mint}: ${error}`, 'ERROR');
            return null;
        }
    }
}
exports.JupiterAPI = JupiterAPI;
