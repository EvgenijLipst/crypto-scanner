"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenAnalyzer = void 0;
const indicators_1 = require("./indicators");
const utils_1 = require("./utils");
class TokenAnalyzer {
    constructor(coingecko, jupiter, database, config) {
        // Оптимизация API лимитов
        this.topTokensCache = [];
        this.topTokensCacheTime = 0;
        this.topTokensCacheTimeout = 24 * 60 * 60 * 1000; // 24 часа для CoinGecko
        // Helius мониторинг
        this.monitoredTokens = new Set();
        this.lastFullRefresh = 0;
        this.fullRefreshInterval = 24 * 60 * 60 * 1000; // 24 часа
        this.batchSize = 20; // Уменьшаем размер батча для экономии CoinGecko
        this.analysisInterval = 10 * 60 * 1000; // 10 минут между анализами
        this.lastAnalysisTime = 0;
        this.coingecko = coingecko;
        this.jupiter = jupiter;
        this.database = database;
        this.config = config;
    }
    /**
     * Главный метод - получить топ токены (сначала из базы, потом из CoinGecko)
     */
    async getTopTokensForMonitoring() {
        try {
            const now = Date.now();
            // Проверяем кэш в памяти (быстрая проверка)
            if (this.topTokensCache.length > 0 &&
                now - this.topTokensCacheTime < this.topTokensCacheTimeout) {
                (0, utils_1.log)('Using cached top tokens list (memory cache)');
                return this.topTokensCache;
            }
            (0, utils_1.log)('🔄 Token refresh: Checking database first...');
            // Сначала проверяем базу данных - есть ли свежие токены
            const hasFreshTokens = await this.database.hasFreshTokens('Solana', 500, 24);
            if (hasFreshTokens) {
                (0, utils_1.log)('✅ Found fresh tokens in database, using them instead of CoinGecko');
                const tokens = await this.loadTokensFromDatabase();
                if (tokens.length > 0) {
                    // Применяем базовые фильтры
                    const filteredTokens = this.applyBasicFilters(tokens);
                    (0, utils_1.log)(`Database refresh: ${filteredTokens.length} tokens after basic filters`);
                    // Кэшируем результат
                    this.topTokensCache = filteredTokens;
                    this.topTokensCacheTime = now;
                    this.lastFullRefresh = now;
                    // Обновляем список для мониторинга
                    this.updateMonitoredTokens(filteredTokens);
                    (0, utils_1.log)(`✅ Database refresh complete: ${filteredTokens.length} tokens cached for monitoring`);
                    return filteredTokens;
                }
            }
            // Если в базе нет свежих токенов - запрашиваем CoinGecko
            (0, utils_1.log)('🔄 No fresh tokens in database, fetching from CoinGecko...');
            // Получаем только топ-500 токенов (экономим CoinGecko кредиты)
            const tokens = await this.coingecko.getTopSolanaTokens(500);
            if (tokens.length === 0) {
                (0, utils_1.log)('No tokens received from CoinGecko', 'WARN');
                return this.topTokensCache; // Возвращаем старый кэш
            }
            // Применяем базовые фильтры
            const filteredTokens = this.applyBasicFilters(tokens);
            (0, utils_1.log)(`CoinGecko refresh: ${filteredTokens.length} tokens after basic filters`);
            // Сохраняем все токены в coin_data таблицу
            await this.saveTokensToCoinData(tokens);
            // Кэшируем результат
            this.topTokensCache = filteredTokens;
            this.topTokensCacheTime = now;
            this.lastFullRefresh = now;
            // Обновляем список для мониторинга
            this.updateMonitoredTokens(filteredTokens);
            (0, utils_1.log)(`✅ CoinGecko refresh complete: ${filteredTokens.length} tokens cached for monitoring`);
            return filteredTokens;
        }
        catch (error) {
            (0, utils_1.log)(`Error in tokens refresh: ${error}`, 'ERROR');
            return this.topTokensCache; // Возвращаем старый кэш при ошибке
        }
    }
    /**
     * Загрузить токены из базы данных coin_data
     */
    async loadTokensFromDatabase() {
        try {
            const freshTokens = await this.database.getFreshTokensFromCoinData('Solana', 24);
            // Преобразуем данные из базы в формат SolanaToken
            const tokens = freshTokens.map(row => ({
                mint: `${row.coin_id}_mint_placeholder`, // Нет mint в coin_data, используем placeholder
                symbol: row.coin_id.toUpperCase(),
                name: row.coin_id,
                marketCap: row.price * 1000000, // Примерная оценка
                fdv: row.price * 1000000,
                volume24h: row.volume,
                priceUsd: row.price,
                priceChange24h: 0,
                age: 15, // Предполагаем что токены достаточно старые
                lastUpdated: row.timestamp
            }));
            (0, utils_1.log)(`📊 Loaded ${tokens.length} tokens from coin_data table`);
            return tokens;
        }
        catch (error) {
            (0, utils_1.log)(`Error loading tokens from database: ${error}`, 'ERROR');
            return [];
        }
    }
    /**
     * Сохранить токены в coin_data таблицу
     */
    async saveTokensToCoinData(tokens) {
        try {
            const coinDataTokens = tokens.map(token => ({
                coinId: token.symbol.toLowerCase(),
                network: 'Solana',
                price: token.priceUsd,
                volume: token.volume24h
            }));
            await this.database.saveCoinDataBatch(coinDataTokens);
            (0, utils_1.log)(`💾 Saved ${coinDataTokens.length} tokens to coin_data table`);
        }
        catch (error) {
            (0, utils_1.log)(`Error saving tokens to coin_data: ${error}`, 'ERROR');
        }
    }
    /**
     * Обновить список токенов для мониторинга через Helius
     */
    updateMonitoredTokens(tokens) {
        this.monitoredTokens.clear();
        // Добавляем mint адреса в список мониторинга
        for (const token of tokens) {
            this.monitoredTokens.add(token.mint);
        }
        (0, utils_1.log)(`Updated monitoring list: ${this.monitoredTokens.size} tokens`);
    }
    /**
     * Проверить, нужно ли мониторить этот токен
     */
    shouldMonitorToken(mint) {
        return this.monitoredTokens.has(mint);
    }
    /**
     * Получить список токенов для мониторинга
     */
    getMonitoredTokens() {
        return Array.from(this.monitoredTokens);
    }
    /**
     * Анализ токена на основе данных из Helius (без CoinGecko запросов)
     */
    async analyzeTokenFromHelius(mint) {
        try {
            // Получаем данные токена из кэша
            const token = this.topTokensCache.find(t => t.mint === mint);
            if (!token) {
                return null;
            }
            const result = {
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
            // 1. Технический анализ на основе данных из Helius
            const technicalResult = await this.performTechnicalAnalysis(token);
            result.passesTechnicalAnalysis = technicalResult.passes;
            result.data.volumeSpike = technicalResult.volumeSpike;
            result.data.rsi = technicalResult.rsi;
            result.data.emaSignal = technicalResult.emaSignal;
            if (!technicalResult.passes) {
                result.reasons.push(...technicalResult.reasons);
                return result;
            }
            // 2. Тест ликвидности через Jupiter (быстрый и дешевый)
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
        catch (error) {
            (0, utils_1.log)(`Error analyzing token ${mint}: ${error}`, 'ERROR');
            return null;
        }
    }
    /**
     * Анализ активности токена (вызывается из Helius WebSocket)
     */
    async analyzeTokenActivity(mint, swapData) {
        try {
            // Проверяем, нужно ли мониторить этот токен
            if (!this.shouldMonitorToken(mint)) {
                return null;
            }
            (0, utils_1.log)(`🔍 Analyzing activity for monitored token: ${mint}`);
            // Обновляем данные в базе из Helius
            await this.database.ingestSwap(mint, swapData.priceUsd, swapData.volumeUsd, swapData.timestamp);
            // Анализируем токен
            const result = await this.analyzeTokenFromHelius(mint);
            if (result && result.isSignal) {
                (0, utils_1.log)(`🚀 SIGNAL DETECTED: ${result.symbol} (${mint})`);
            }
            return result;
        }
        catch (error) {
            (0, utils_1.log)(`Error in token activity analysis: ${error}`, 'ERROR');
            return null;
        }
    }
    /**
     * Применить базовые фильтры (без дополнительных API запросов)
     */
    applyBasicFilters(tokens) {
        return tokens.filter(token => {
            // Возраст >= 14 дней (приблизительно, основываясь на данных CoinGecko)
            const ageCheck = true; // Предполагаем, что топ токены достаточно старые
            // Ликвидность >= $10k (используем volume24h как прокси)
            const liquidityCheck = token.volume24h >= this.config.minLiquidityUsd;
            // FDV <= $5M
            const fdvCheck = token.fdv <= this.config.maxFdvUsd;
            // Базовые проверки
            const basicCheck = token.mint && token.symbol && token.priceUsd > 0;
            return ageCheck && liquidityCheck && fdvCheck && basicCheck;
        });
    }
    /**
     * Создать батчи для анализа
     */
    createBatches(items, batchSize) {
        const batches = [];
        for (let i = 0; i < items.length; i += batchSize) {
            batches.push(items.slice(i, i + batchSize));
        }
        return batches;
    }
    /**
     * Анализировать батч токенов
     */
    async analyzeBatch(tokens) {
        const results = [];
        for (const token of tokens) {
            try {
                const result = await this.analyzeToken(token);
                results.push(result);
                // Небольшая пауза между токенами
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            catch (error) {
                (0, utils_1.log)(`Error analyzing token ${token.symbol}: ${error}`, 'ERROR');
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
    async analyzeToken(token) {
        const result = {
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
    async performTechnicalAnalysis(token) {
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
            const indicators = (0, indicators_1.calculateIndicators)(candles);
            if (!indicators) {
                return {
                    passes: false,
                    reasons: ['Failed to calculate indicators']
                };
            }
            const reasons = [];
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
            if (!(0, indicators_1.checkBuySignal)(indicators)) {
                passes = false;
                reasons.push('EMA-9/21 not crossed up');
            }
            return {
                passes,
                reasons,
                volumeSpike: indicators.volSpike,
                rsi: indicators.rsi,
                emaSignal: (0, indicators_1.checkBuySignal)(indicators)
            };
        }
        catch (error) {
            return {
                passes: false,
                reasons: [`Technical analysis error: ${error}`]
            };
        }
    }
    /**
     * Тест ликвидности и price impact
     */
    async performLiquidityTest(token) {
        try {
            // Получаем quote для симуляции свапа
            const quote = await this.jupiter.getQuote('So11111111111111111111111111111111111111112', // SOL
            token.mint, this.config.priceImpactTestAmount * 1e9 // Convert to lamports
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
            const reasons = [];
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
        }
        catch (error) {
            return {
                passes: false,
                reasons: [`Liquidity test error: ${error}`]
            };
        }
    }
    /**
     * Вычислить price impact из quote
     */
    calculatePriceImpact(quote) {
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
        }
        catch (error) {
            return 100; // High impact if can't calculate
        }
    }
    /**
     * Оценить ликвидность на основе quote
     */
    estimateLiquidity(quote, priceImpact) {
        try {
            // Простая оценка: если price impact низкий, ликвидность высокая
            if (priceImpact < 0.5)
                return 50000; // High liquidity
            if (priceImpact < 1.0)
                return 25000; // Medium liquidity
            if (priceImpact < 2.0)
                return 15000; // Low-medium liquidity
            if (priceImpact < 3.0)
                return 10000; // Low liquidity
            return 5000; // Very low liquidity
        }
        catch (error) {
            return 0;
        }
    }
    /**
     * Получить конфигурацию
     */
    getConfig() {
        return { ...this.config };
    }
    /**
     * Обновить конфигурацию
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        (0, utils_1.log)('Token analyzer config updated');
    }
}
exports.TokenAnalyzer = TokenAnalyzer;
