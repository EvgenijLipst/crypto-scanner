// token-analyzer.ts - Анализ токенов по критериям сигналов
import { CoinGeckoAPI, SolanaToken } from './coingecko';
import { JupiterAPI } from './jupiter';
import { Database } from './database';
import { calculateIndicators, checkBuySignal } from './indicators';
import { log } from './utils';

export interface TokenAnalysisResult {
  mint: string;
  symbol: string;
  name: string;
  passesBasicFilters: boolean;
  passesTechnicalAnalysis: boolean;
  passesLiquidityTest: boolean;
  isSignal: boolean;
  reasons: string[];
  data: {
    age: number;
    marketCap: number;
    fdv: number;
    volume24h: number;
    priceUsd: number;
    volumeSpike?: number;
    rsi?: number;
    emaSignal?: boolean;
    priceImpact?: number;
    liquidity?: number;
  };
}

export interface AnalysisConfig {
  minTokenAgeDays: number;
  minLiquidityUsd: number;
  maxFdvUsd: number;
  minVolumeSpike: number;
  maxRsiOversold: number;
  maxPriceImpactPercent: number;
  priceImpactTestAmount: number;
}

export class TokenAnalyzer {
  private coingecko: CoinGeckoAPI;
  private jupiter: JupiterAPI;
  private database: Database;
  private config: AnalysisConfig;
  
  // Оптимизация кредитов Helius
  private analysisQueue: string[] = [];
  private batchSize = 50; // Анализируем по 50 токенов за раз
  private analysisInterval = 10 * 60 * 1000; // 10 минут между анализами
  private lastAnalysisTime = 0;

  constructor(
    coingecko: CoinGeckoAPI,
    jupiter: JupiterAPI,
    database: Database,
    config: AnalysisConfig
  ) {
    this.coingecko = coingecko;
    this.jupiter = jupiter;
    this.database = database;
    this.config = config;
  }

  /**
   * Главный метод анализа - получить и проанализировать топ токены
   */
  async analyzeTopTokens(): Promise<TokenAnalysisResult[]> {
    try {
      log('Starting top tokens analysis...');
      
      // Проверяем, не слишком ли часто анализируем
      const now = Date.now();
      if (now - this.lastAnalysisTime < this.analysisInterval) {
        log('Analysis too frequent, skipping...');
        return [];
      }
      this.lastAnalysisTime = now;

      // Получаем топ токены из CoinGecko
      const tokens = await this.coingecko.getTopSolanaTokens(2000);
      if (tokens.length === 0) {
        log('No tokens received from CoinGecko', 'WARN');
        return [];
      }

      log(`Analyzing ${tokens.length} tokens...`);
      
      // Фильтруем токены по базовым критериям
      const filteredTokens = this.applyBasicFilters(tokens);
      log(`${filteredTokens.length} tokens passed basic filters`);

      // Анализируем по батчам для экономии кредитов
      const results: TokenAnalysisResult[] = [];
      const batches = this.createBatches(filteredTokens, this.batchSize);
      
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        log(`Processing batch ${i + 1}/${batches.length} (${batch.length} tokens)`);
        
        const batchResults = await this.analyzeBatch(batch);
        results.push(...batchResults);
        
        // Пауза между батчами для rate limiting
        if (i < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      // Фильтруем только сигналы
      const signals = results.filter(r => r.isSignal);
      log(`Found ${signals.length} signals out of ${results.length} analyzed tokens`);
      
      return signals;
      
    } catch (error) {
      log(`Error in analyzeTopTokens: ${error}`, 'ERROR');
      return [];
    }
  }

  /**
   * Применить базовые фильтры
   */
  private applyBasicFilters(tokens: SolanaToken[]): SolanaToken[] {
    return tokens.filter(token => {
      // Возраст >= 14 дней
      if (token.age < this.config.minTokenAgeDays) return false;
      
      // FDV <= $5M
      if (token.fdv > this.config.maxFdvUsd) return false;
      
      // Должен иметь минимальный объем для анализа
      if (token.volume24h < 1000) return false;
      
      return true;
    });
  }

  /**
   * Создать батчи для анализа
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Анализировать батч токенов
   */
  private async analyzeBatch(tokens: SolanaToken[]): Promise<TokenAnalysisResult[]> {
    const results: TokenAnalysisResult[] = [];
    
    for (const token of tokens) {
      try {
        const result = await this.analyzeToken(token);
        results.push(result);
        
        // Небольшая пауза между токенами
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        log(`Error analyzing token ${token.symbol}: ${error}`, 'ERROR');
        
        // Добавляем неудачный результат
        results.push({
          mint: token.mint,
          symbol: token.symbol,
          name: token.name,
          passesBasicFilters: false,
          passesTechnicalAnalysis: false,
          passesLiquidityTest: false,
          isSignal: false,
          reasons: ['Analysis failed'],
          data: {
            age: token.age,
            marketCap: token.marketCap,
            fdv: token.fdv,
            volume24h: token.volume24h,
            priceUsd: token.priceUsd
          }
        });
      }
    }
    
    return results;
  }

  /**
   * Анализировать один токен
   */
  private async analyzeToken(token: SolanaToken): Promise<TokenAnalysisResult> {
    const result: TokenAnalysisResult = {
      mint: token.mint,
      symbol: token.symbol,
      name: token.name,
      passesBasicFilters: true, // Уже прошел базовые фильтры
      passesTechnicalAnalysis: false,
      passesLiquidityTest: false,
      isSignal: false,
      reasons: [],
      data: {
        age: token.age,
        marketCap: token.marketCap,
        fdv: token.fdv,
        volume24h: token.volume24h,
        priceUsd: token.priceUsd
      }
    };

    // 1. Технический анализ
    const technicalResult = await this.performTechnicalAnalysis(token);
    result.passesTechnicalAnalysis = technicalResult.passes;
    result.data.volumeSpike = technicalResult.volumeSpike;
    result.data.rsi = technicalResult.rsi;
    result.data.emaSignal = technicalResult.emaSignal;
    
    if (!technicalResult.passes) {
      result.reasons.push(...technicalResult.reasons);
      return result;
    }

    // 2. Тест ликвидности и price impact
    const liquidityResult = await this.performLiquidityTest(token);
    result.passesLiquidityTest = liquidityResult.passes;
    result.data.priceImpact = liquidityResult.priceImpact;
    result.data.liquidity = liquidityResult.liquidity;
    
    if (!liquidityResult.passes) {
      result.reasons.push(...liquidityResult.reasons);
      return result;
    }

    // 3. Все проверки пройдены - это сигнал!
    result.isSignal = true;
    result.reasons.push('All criteria met - BUY SIGNAL');
    
    return result;
  }

  /**
   * Технический анализ токена
   */
  private async performTechnicalAnalysis(token: SolanaToken): Promise<{
    passes: boolean;
    reasons: string[];
    volumeSpike?: number;
    rsi?: number;
    emaSignal?: boolean;
  }> {
    try {
      // Получаем исторические данные из базы
      const candles = await this.database.getCandles(token.mint, 40);
      
      if (candles.length < 30) {
        return {
          passes: false,
          reasons: ['Insufficient historical data']
        };
      }

      // Вычисляем индикаторы
      const indicators = calculateIndicators(candles);
      if (!indicators) {
        return {
          passes: false,
          reasons: ['Failed to calculate indicators']
        };
      }

      const reasons: string[] = [];
      let passes = true;

      // Проверяем объем-спайк ×3
      if (indicators.volSpike < this.config.minVolumeSpike) {
        passes = false;
        reasons.push(`Volume spike too low: ${indicators.volSpike.toFixed(2)}x < ${this.config.minVolumeSpike}x`);
      }

      // Проверяем RSI выход из зоны < 35
      if (indicators.rsi <= this.config.maxRsiOversold) {
        passes = false;
        reasons.push(`RSI still oversold: ${indicators.rsi.toFixed(2)} <= ${this.config.maxRsiOversold}`);
      }

      // Проверяем EMA пересечение
      if (!checkBuySignal(indicators)) {
        passes = false;
        reasons.push('EMA-9/21 not crossed up');
      }

      return {
        passes,
        reasons,
        volumeSpike: indicators.volSpike,
        rsi: indicators.rsi,
        emaSignal: checkBuySignal(indicators)
      };
      
    } catch (error) {
      return {
        passes: false,
        reasons: [`Technical analysis error: ${error}`]
      };
    }
  }

  /**
   * Тест ликвидности и price impact
   */
  private async performLiquidityTest(token: SolanaToken): Promise<{
    passes: boolean;
    reasons: string[];
    priceImpact?: number;
    liquidity?: number;
  }> {
    try {
      // Получаем quote для симуляции свапа
      const quote = await this.jupiter.getQuote(
        'So11111111111111111111111111111111111111112', // SOL
        token.mint,
        this.config.priceImpactTestAmount * 1e9 // Convert to lamports
      );

      if (!quote) {
        return {
          passes: false,
          reasons: ['No liquidity - Jupiter quote failed']
        };
      }

      // Вычисляем price impact
      const priceImpact = this.calculatePriceImpact(quote);
      
      // Оценка ликвидности на основе slippage
      const liquidity = this.estimateLiquidity(quote, priceImpact);

      const reasons: string[] = [];
      let passes = true;

      // Проверяем ликвидность >= $10k
      if (liquidity < this.config.minLiquidityUsd) {
        passes = false;
        reasons.push(`Liquidity too low: $${liquidity.toFixed(0)} < $${this.config.minLiquidityUsd}`);
      }

      // Проверяем price impact <= 3%
      if (priceImpact > this.config.maxPriceImpactPercent) {
        passes = false;
        reasons.push(`Price impact too high: ${priceImpact.toFixed(2)}% > ${this.config.maxPriceImpactPercent}%`);
      }

      return {
        passes,
        reasons,
        priceImpact,
        liquidity
      };
      
    } catch (error) {
      return {
        passes: false,
        reasons: [`Liquidity test error: ${error}`]
      };
    }
  }

  /**
   * Вычислить price impact из quote
   */
  private calculatePriceImpact(quote: any): number {
    try {
      // Jupiter quote содержит priceImpactPct
      if (quote.priceImpactPct) {
        return Math.abs(parseFloat(quote.priceImpactPct));
      }
      
      // Fallback - вычисляем из routePlan
      if (quote.routePlan && quote.routePlan.length > 0) {
        const route = quote.routePlan[0];
        if (route.swapInfo && route.swapInfo.feeAmount && route.swapInfo.inAmount) {
          return (parseFloat(route.swapInfo.feeAmount) / parseFloat(route.swapInfo.inAmount)) * 100;
        }
      }
      
      return 0;
    } catch (error) {
      return 100; // High impact if can't calculate
    }
  }

  /**
   * Оценить ликвидность на основе quote
   */
  private estimateLiquidity(quote: any, priceImpact: number): number {
    try {
      // Простая оценка: если price impact низкий, ликвидность высокая
      if (priceImpact < 0.5) return 50000; // High liquidity
      if (priceImpact < 1.0) return 25000; // Medium liquidity
      if (priceImpact < 2.0) return 15000; // Low-medium liquidity
      if (priceImpact < 3.0) return 10000; // Low liquidity
      return 5000; // Very low liquidity
    } catch (error) {
      return 0;
    }
  }

  /**
   * Получить конфигурацию
   */
  getConfig(): AnalysisConfig {
    return { ...this.config };
  }

  /**
   * Обновить конфигурацию
   */
  updateConfig(newConfig: Partial<AnalysisConfig>): void {
    this.config = { ...this.config, ...newConfig };
    log('Token analyzer config updated');
  }
} 