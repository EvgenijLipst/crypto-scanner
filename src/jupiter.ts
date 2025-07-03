// jupiter.ts - Работа с Jupiter API

import fetch from 'cross-fetch';
import { PublicKey } from '@solana/web3.js';
import { MAX_PRICE_IMPACT_PERCENT } from './types';
import { log } from './utils';

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
}

export class JupiterAPI {
  private baseUrl = 'https://quote-api.jup.ag/v6';

  /**
   * Получить котировку от Jupiter
   */
  async getQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 50
  ): Promise<JupiterQuote | null> {
    try {
      const url = `${this.baseUrl}/quote?` +
        `inputMint=${inputMint}&` +
        `outputMint=${outputMint}&` +
        `amount=${amount}&` +
        `slippageBps=${slippageBps}`;

      const response = await fetch(url);
      
      if (!response.ok) {
        log(`Jupiter API error: ${response.status} ${response.statusText}`, 'ERROR');
        return null;
      }

      const quote = await response.json();
      return quote;
    } catch (error) {
      log(`Error fetching Jupiter quote: ${error}`, 'ERROR');
      return null;
    }
  }

  /**
   * Проверить price impact для токена
   */
  async checkPriceImpact(mint: string, amountUsd: number = 200): Promise<{
    priceImpact: number;
    passed: boolean;
  }> {
    try {
      // Конвертируем USD в lamports USDC
      const amountLamports = Math.round(amountUsd * Math.pow(10, USDC_DECIMALS));

      // Получаем котировку на покупку
      const quote = await this.getQuote(USDC_MINT, mint, amountLamports);

      if (!quote) {
        return { priceImpact: 100, passed: false };
      }

      const priceImpact = parseFloat(quote.priceImpactPct) * 100;
      const passed = priceImpact <= MAX_PRICE_IMPACT_PERCENT;

      log(`Price impact check for ${mint}: ${priceImpact.toFixed(2)}% (${passed ? 'PASS' : 'FAIL'})`);

      return { priceImpact, passed };
    } catch (error) {
      log(`Error checking price impact for ${mint}: ${error}`, 'ERROR');
      return { priceImpact: 100, passed: false };
    }
  }

  /**
   * Получить цену токена в USDC
   */
  async getTokenPrice(mint: string, tokenAmount: number, decimals: number): Promise<number | null> {
    try {
      const amountLamports = Math.round(tokenAmount * Math.pow(10, decimals));
      const quote = await this.getQuote(mint, USDC_MINT, amountLamports);

      if (!quote) {
        return null;
      }

      const usdcAmount = parseFloat(quote.outAmount) / Math.pow(10, USDC_DECIMALS);
      const pricePerToken = usdcAmount / tokenAmount;

      return pricePerToken;
    } catch (error) {
      log(`Error getting token price for ${mint}: ${error}`, 'ERROR');
      return null;
    }
  }
} 