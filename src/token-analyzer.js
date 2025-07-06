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
        this.topTokensCacheTimeout = 48 * 60 * 60 * 1000; // 48 часов для CoinGecko (топ-2000 стабильны)
        // Helius мониторинг
        this.monitoredTokens = new Set();
        this.lastFullRefresh = 0;
        this.fullRefreshInterval = 48 * 60 * 60 * 1000; // 48 часов
        this.batchSize = 20; // Уменьшаем размер батча для экономии CoinGecko
        this.analysisInterval = 10 * 60 * 1000; // 10 минут между анализами
        this.lastAnalysisTime = 0;
        // Временный режим принудительного обновления
        this.forceRefreshMode = true; // ВКЛЮЧАЕМ ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ
        this.rolling = new Map();
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
            // ПРОВЕРЯЕМ РЕЖИМ ПРИНУДИТЕЛЬНОГО ОБНОВЛЕНИЯ
            if (this.forceRefreshMode) {
                (0, utils_1.log)('🔄 FORCE REFRESH MODE: Skipping cache and database, fetching fresh tokens from CoinGecko...');
                // Создаем callback для немедленного сохранения батчей
                const saveBatchCallback = async (batch) => {
                    try {
                        (0, utils_1.log)(`🔄 FORCE SAVE BATCH: Saving ${batch.length} tokens immediately to database...`);
                        await this.saveTokensToCoinData(batch);
                        (0, utils_1.log)(`✅ FORCE SAVE BATCH: Successfully saved ${batch.length} tokens to database`);
                    }
                    catch (error) {
                        (0, utils_1.log)(`❌ FORCE SAVE BATCH ERROR: ${error}`, 'ERROR');
                    }
                };
                // Получаем топ-2000 токенов напрямую из CoinGecko с callback для сохранения
                const tokens = await this.coingecko.getTopSolanaTokens(2000, saveBatchCallback);
                (0, utils_1.log)(`CoinGecko returned ${tokens.length} tokens in force refresh mode`);
                if (tokens.length === 0) {
                    (0, utils_1.log)('No tokens received from CoinGecko in force refresh mode', 'WARN');
                    return this.topTokensCache; // Возвращаем старый кэш
                }
                // Применяем базовые фильтры
                const filteredTokens = this.applyBasicFilters(tokens);
                (0, utils_1.log)(`Force refresh: ${filteredTokens.length} tokens after basic filters`);
                // Кэшируем результат
                this.topTokensCache = filteredTokens;
                this.topTokensCacheTime = now;
                this.lastFullRefresh = now;
                // Обновляем список для мониторинга
                this.updateMonitoredTokens(filteredTokens);
                (0, utils_1.log)(`✅ Force refresh complete: ${filteredTokens.length} tokens cached for monitoring`);
                return filteredTokens;
            }
            // Проверяем кэш в памяти (быстрая проверка)
            if (this.topTokensCache.length > 0 &&
                now - this.topTokensCacheTime < this.topTokensCacheTimeout) {
                (0, utils_1.log)('Using cached top tokens list (memory cache)');
                return this.topTokensCache;
            }
            (0, utils_1.log)('🔄 Token refresh: Checking database first...');
            // Сначала проверяем базу данных - есть ли свежие токены (48 часов)
            const hasFreshTokens = await this.database.hasFreshTokens('Solana', 1500, 48);
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
            // Создаем callback для немедленного сохранения батчей
            const saveBatchCallback = async (batch) => {
                try {
                    (0, utils_1.log)(`🔄 SAVE BATCH: Saving ${batch.length} tokens immediately to database...`);
                    await this.saveTokensToCoinData(batch);
                    (0, utils_1.log)(`✅ SAVE BATCH: Successfully saved ${batch.length} tokens to database`);
                }
                catch (error) {
                    (0, utils_1.log)(`❌ SAVE BATCH ERROR: ${error}`, 'ERROR');
                }
            };
            // Получаем топ-2000 токенов (согласно требованиям) с callback для сохранения
            const tokens = await this.coingecko.getTopSolanaTokens(2000, saveBatchCallback);
            (0, utils_1.log)(`CoinGecko returned ${tokens.length} tokens`);
            if (tokens.length === 0) {
                (0, utils_1.log)('No tokens received from CoinGecko', 'WARN');
                return this.topTokensCache; // Возвращаем старый кэш
            }
            // Применяем базовые фильтры
            const filteredTokens = this.applyBasicFilters(tokens);
            (0, utils_1.log)(`CoinGecko refresh: ${filteredTokens.length} tokens after basic filters`);
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
            const freshTokens = await this.database.getFreshTokensFromCoinData('Solana', 48);
            // Преобразуем данные из базы в формат SolanaToken
            // ВАЖНО: Фильтруем только токены с реальными mint адресами
            const tokens = freshTokens
                .filter(row => row.mint && !row.mint.includes('placeholder')) // Только токены с реальными mint адресами
                .map(row => ({
                coinId: row.coin_id, // Используем coin_id из базы данных
                mint: row.mint, // Используем только реальные mint адреса
                symbol: row.symbol || row.coin_id.toUpperCase(),
                name: row.name || row.coin_id,
                marketCap: row.market_cap || (row.price * 1000000),
                fdv: row.fdv || (row.price * 1000000),
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
            (0, utils_1.log)(`🔄 Preparing ${tokens.length} tokens for database save...`);
            (0, utils_1.log)(`TOKENS TO SAVE COUNT: ${tokens.length}`);
            (0, utils_1.log)(`TOKENS TO SAVE SAMPLE: ${tokens.slice(0, 10).map(t => t.symbol + ':' + t.mint).join(', ')}`);
            const coinDataTokens = tokens.map(token => ({
                coinId: token.coinId, // Используем правильный coinId из CoinGecko API
                mint: token.mint,
                symbol: token.symbol,
                name: token.name,
                network: 'Solana',
                price: token.priceUsd,
                volume: token.volume24h,
                marketCap: token.marketCap,
                fdv: token.fdv
            }));
            (0, utils_1.log)(`📋 Sample tokens to save:`);
            coinDataTokens.slice(0, 3).forEach((token, i) => {
                (0, utils_1.log)(`${i + 1}. ${token.symbol} (${token.coinId}) - mint: "${token.mint}" - price: $${token.price}`);
            });
            (0, utils_1.log)(`🔄 Calling database.saveCoinDataBatch with ${coinDataTokens.length} tokens...`);
            (0, utils_1.log)(`🔄 Database connection status: ${this.database ? 'Connected' : 'Not connected'}`);
            // Проверяем, что у нас есть токены для сохранения
            if (coinDataTokens.length === 0) {
                (0, utils_1.log)(`⚠️ WARNING: No tokens to save! Original tokens array length: ${tokens.length}`);
                return;
            }
            // Проверяем, что все токены имеют необходимые поля
            const validTokens = coinDataTokens.filter(token => token.coinId && token.mint && token.symbol && token.name);
            if (validTokens.length !== coinDataTokens.length) {
                (0, utils_1.log)(`⚠️ WARNING: ${coinDataTokens.length - validTokens.length} tokens have missing required fields`);
                (0, utils_1.log)(`Valid tokens: ${validTokens.length}, Total tokens: ${coinDataTokens.length}`);
            }
            await this.database.saveCoinDataBatch(coinDataTokens);
            (0, utils_1.log)(`💾 Saved ${coinDataTokens.length} tokens to coin_data table`);
            (0, utils_1.log)(`✅ Database save operation completed successfully`);
        }
        catch (error) {
            (0, utils_1.log)(`❌ Error saving tokens to coin_data: ${error}`, 'ERROR');
            if (error instanceof Error) {
                (0, utils_1.log)(`❌ Error details: ${error.message}`);
                (0, utils_1.log)(`❌ Error stack: ${error.stack}`);
            }
            // Попробуем сохранить по одному для диагностики
            (0, utils_1.log)(`🔄 Attempting individual saves for debugging...`);
            let savedCount = 0;
            for (const token of tokens.slice(0, 5)) { // Пробуем только первые 5
                try {
                    await this.database.saveCoinData(token.coinId, token.mint, token.symbol, token.name, 'Solana', token.priceUsd, token.volume24h, token.marketCap, token.fdv);
                    savedCount++;
                    (0, utils_1.log)(`✅ Individual save successful for ${token.symbol}`);
                }
                catch (individualError) {
                    (0, utils_1.log)(`❌ Failed to save token ${token.symbol}: ${individualError}`, 'ERROR');
                }
            }
            (0, utils_1.log)(`Individual save result: ${savedCount}/5 tokens saved`);
        }
    }
    /**
     * Сохранить токены в coin_data таблицу в пакетах
     */
    async saveTokensInBatches(tokens, batchSize) {
        try {
            (0, utils_1.log)(`🔄 Starting batch save of ${tokens.length} tokens in batches of ${batchSize}...`);
            const batches = this.createBatches(tokens, batchSize);
            (0, utils_1.log)(`📦 Created ${batches.length} batches for saving`);
            let totalSaved = 0;
            let totalBatches = batches.length;
            for (let i = 0; i < batches.length; i++) {
                const batch = batches[i];
                try {
                    (0, utils_1.log)(`🔄 Saving batch ${i + 1}/${totalBatches} with ${batch.length} tokens...`);
                    await this.saveTokensToCoinData(batch);
                    totalSaved += batch.length;
                    (0, utils_1.log)(`✅ Successfully saved batch ${i + 1}/${totalBatches} (${batch.length} tokens). Total saved: ${totalSaved}/${tokens.length}`);
                }
                catch (error) {
                    (0, utils_1.log)(`❌ Error saving batch ${i + 1}/${totalBatches} (${batch.length} tokens): ${error}`, 'ERROR');
                    if (error instanceof Error) {
                        (0, utils_1.log)(`❌ Error details: ${error.message}`);
                    }
                    // Продолжаем с следующим батчем, не останавливаем весь процесс
                }
            }
            (0, utils_1.log)(`✅ Batch save completed: ${totalSaved}/${tokens.length} tokens saved successfully`);
        }
        catch (error) {
            (0, utils_1.log)(`❌ Critical error in batch save process: ${error}`, 'ERROR');
            throw error;
        }
    }
    /**
     * Обновить список токенов для мониторинга через Helius
     */
    updateMonitoredTokens(tokens) {
        this.monitoredTokens.clear();
        for (const token of tokens) {
            this.monitoredTokens.add(token.mint);
            this.ensureRolling(token.mint); // инициализируем rolling
        }
        (0, utils_1.log)(`Updated monitoring list: ${this.monitoredTokens.size} tokens`);
    }
    ensureRolling(mint) {
        if (!this.rolling.has(mint)) {
            this.rolling.set(mint, {
                candles: [],
                lastCandleTs: 0,
                buyers5m: new Set(),
                buyVol5m: 0,
                sellVol5m: 0,
                swapHistory: [],
                lastSignalTs: 0,
                lastDepositTs: 0,
                liquidityBoost: false
            });
        }
        return this.rolling.get(mint);
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
                    emaBull: false,
                    rsi: 0,
                    atr: 0,
                    volumeSpike: 0,
                    netFlow: 0,
                    uniqueBuyers: 0,
                    liquidityBoost: false,
                    avgVol60m: 0,
                    vol5m: 0
                }
            };
            // 1. Технический анализ на основе данных из Helius
            const technicalResult = await this.performTechnicalAnalysis(token);
            result.passesTechnicalAnalysis = technicalResult.passes;
            result.data.volumeSpike = technicalResult.volumeSpike;
            result.data.rsi = technicalResult.rsi;
            result.data.emaBull = technicalResult.emaSignal;
            if (!technicalResult.passes) {
                result.reasons.push(...technicalResult.reasons);
                return result;
            }
            // 2. Тест ликвидности через Jupiter (быстрый и дешевый)
            const liquidityResult = await this.performLiquidityTest(token);
            result.passesLiquidityTest = liquidityResult.passes;
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
     * Основная функция: обработка свапа и анализ сигнала
     */
    async analyzeTokenActivity(mint, swapData) {
        if (!this.shouldMonitorToken(mint))
            return null;
        const rolling = this.ensureRolling(mint);
        const now = Math.floor(Date.now() / 1000);
        // 1. Обновляем минутную свечу
        const minuteTs = Math.floor(swapData.timestamp / 60) * 60;
        let candle = rolling.candles.length > 0 && rolling.lastCandleTs === minuteTs ? rolling.candles[rolling.candles.length - 1] : null;
        if (!candle) {
            candle = { mint, ts: minuteTs, o: swapData.priceUsd, h: swapData.priceUsd, l: swapData.priceUsd, c: swapData.priceUsd, v: 0 };
            rolling.candles.push(candle);
            rolling.lastCandleTs = minuteTs;
            if (rolling.candles.length > 120)
                rolling.candles.shift();
        }
        candle.h = Math.max(candle.h, swapData.priceUsd);
        candle.l = Math.min(candle.l, swapData.priceUsd);
        candle.c = swapData.priceUsd;
        candle.v += swapData.volumeUsd;
        // 2. Обновляем swapHistory (последние 120 свапов)
        rolling.swapHistory.push({ ts: swapData.timestamp, buyer: swapData.buyer || '', buy: swapData.buy || 0, sell: swapData.sell || 0, amountUsd: swapData.volumeUsd });
        if (rolling.swapHistory.length > 120)
            rolling.swapHistory.shift();
        // 3. Iceberg: свапы < $50 не учитываем в объёме, но считаем для UniqueBuyers
        if (swapData.volumeUsd >= 50) {
            if (swapData.buy)
                rolling.buyVol5m += swapData.volumeUsd;
            if (swapData.sell)
                rolling.sellVol5m += swapData.volumeUsd;
        }
        if (swapData.buyer)
            rolling.buyers5m.add(swapData.buyer);
        // 4. LP события
        if (swapData.depositUsd && swapData.depositUsd > 5000) {
            rolling.lastDepositTs = swapData.timestamp;
            rolling.liquidityBoost = true;
        }
        // 5. Окна rolling (очистка старых)
        const cutoff5m = now - 5 * 60;
        rolling.buyers5m = new Set(rolling.swapHistory.filter(s => s.ts >= cutoff5m).map(s => s.buyer));
        rolling.buyVol5m = rolling.swapHistory.filter(s => s.ts >= cutoff5m && s.buy).reduce((a, b) => a + b.amountUsd, 0);
        rolling.sellVol5m = rolling.swapHistory.filter(s => s.ts >= cutoff5m && s.sell).reduce((a, b) => a + b.amountUsd, 0);
        // 6. Технические индикаторы
        const candles = rolling.candles;
        const closes = candles.map(c => c.c);
        const ema12 = this.calculateEMA(closes, 12);
        const ema26 = this.calculateEMA(closes, 26);
        const emaBull = ema12.length > 0 && ema26.length > 0 && ema12[ema12.length - 1] > ema26[ema26.length - 1];
        const rsi = this.calculateRSI(closes, 14);
        const atr = this.calculateATR(candles, 14);
        // 7. Потоковые метрики
        const vol60m = candles.slice(-60).reduce((a, c) => a + c.v, 0);
        const avgVol60m = vol60m / Math.max(1, candles.slice(-60).length);
        const vol5m = candles.slice(-5).reduce((a, c) => a + c.v, 0);
        const avgVol30m = candles.slice(-30, -5).reduce((a, c) => a + c.v, 0) / 25;
        const volumeSpike = avgVol30m > 0 ? vol5m / (avgVol30m * 5) : 0;
        const netFlow = rolling.sellVol5m > 0 ? rolling.buyVol5m / rolling.sellVol5m : 0;
        const uniqueBuyers = rolling.buyers5m.size;
        // 8. LP boost
        const liquidityBoost = rolling.liquidityBoost && (now - rolling.lastDepositTs < 10 * 60);
        // 9. Фильтры допуска
        const poolAgeOk = true; // TODO: добавить проверку возраста пула (first_seen_ts)
        const hasUsdcOrSol = true; // TODO: добавить проверку по tokenTransfers
        const avgVolOk = avgVol60m >= 2000;
        // 10. Сигнальная логика - СМЯГЧЕННЫЕ КРИТЕРИИ
        let isSignal = false;
        let reasons = [];
        
        // Основные критерии (любой из них может сработать)
        const volumeOk = volumeSpike >= 2; // снижено с 3 до 2
        const rsiOk = rsi < 45; // увеличено с 35 до 45
        const emaOk = emaBull;
        const flowOk = netFlow >= 1.5; // снижено с 2 до 1.5
        const buyersOk = uniqueBuyers >= 3; // снижено с 5 до 3
        const volOk = avgVol60m >= 1000; // снижено с 2000 до 1000
        
        // Хотя бы 2 из 6 критериев должны выполняться
        const criteriaMet = [volumeOk, rsiOk, emaOk, flowOk, buyersOk, volOk].filter(Boolean).length;
        
        if (criteriaMet >= 2 && poolAgeOk && hasUsdcOrSol) {
            if (now - rolling.lastSignalTs > 15 * 60) { // снижено с 30 до 15 минут
                isSignal = true;
                rolling.lastSignalTs = now;
                reasons.push(`Signal criteria met: ${criteriaMet}/6 conditions`);
                if (volumeOk) reasons.push(`Volume spike: ${volumeSpike.toFixed(2)}x`);
                if (rsiOk) reasons.push(`RSI favorable: ${rsi.toFixed(1)}`);
                if (emaOk) reasons.push('EMA bullish');
                if (flowOk) reasons.push(`Net flow: ${netFlow.toFixed(2)}`);
                if (buyersOk) reasons.push(`Unique buyers: ${uniqueBuyers}`);
                if (volOk) reasons.push(`Volume: $${avgVol60m.toFixed(0)}`);
            }
        }
        if (rsi > 70 || netFlow < 1) {
            reasons.push('SELL/exit condition met');
        }
        // 11. Возвращаем результат
        return {
            mint,
            symbol: '',
            name: '',
            passesBasicFilters: true,
            passesTechnicalAnalysis: true,
            passesLiquidityTest: true,
            isSignal,
            reasons,
            data: {
                emaBull,
                rsi,
                atr,
                volumeSpike,
                netFlow,
                uniqueBuyers,
                liquidityBoost,
                avgVol60m,
                vol5m
            }
        };
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
                        emaBull: false,
                        rsi: 0,
                        atr: 0,
                        volumeSpike: 0,
                        netFlow: 0,
                        uniqueBuyers: 0,
                        liquidityBoost: false,
                        avgVol60m: 0,
                        vol5m: 0
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
                emaBull: false,
                rsi: 0,
                atr: 0,
                volumeSpike: 0,
                netFlow: 0,
                uniqueBuyers: 0,
                liquidityBoost: false,
                avgVol60m: 0,
                vol5m: 0
            }
        };
        // 1. Технический анализ
        const technicalResult = await this.performTechnicalAnalysis(token);
        result.passesTechnicalAnalysis = technicalResult.passes;
        result.data.volumeSpike = technicalResult.volumeSpike;
        result.data.rsi = technicalResult.rsi;
        result.data.emaBull = technicalResult.emaSignal;
        if (!technicalResult.passes) {
            result.reasons.push(...technicalResult.reasons);
            return result;
        }
        // 2. Тест ликвидности и price impact
        const liquidityResult = await this.performLiquidityTest(token);
        result.passesLiquidityTest = liquidityResult.passes;
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
    // ... реализовать calculateEMA, calculateRSI, calculateATR (можно взять из indicators.ts)
    calculateEMA(prices, period) {
        const ema = [];
        let multiplier = 2 / (period + 1);
        let currentEMA = prices[0];
        ema.push(currentEMA);
        for (let i = 1; i < prices.length; i++) {
            currentEMA = prices[i] * multiplier + currentEMA * (1 - multiplier);
            ema.push(currentEMA);
        }
        return ema;
    }
    calculateRSI(prices, period) {
        let gains = 0;
        let losses = 0;
        let avgGain = 0;
        let avgLoss = 0;
        for (let i = 1; i <= period; i++) {
            const diff = prices[i] - prices[i - 1];
            if (diff > 0) {
                gains += diff;
            }
            else {
                losses -= diff;
            }
        }
        avgGain = gains / period;
        avgLoss = losses / period;
        let rsi = 0;
        if (avgLoss === 0) {
            rsi = 100;
        }
        else {
            rsi = 100 - (100 / (1 + avgGain / avgLoss));
        }
        return rsi;
    }
    calculateATR(candles, period) {
        let tr = 0;
        for (let i = 1; i < candles.length; i++) {
            const high = candles[i].h;
            const low = candles[i].l;
            const prevClose = candles[i - 1].c;
            tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        }
        return tr;
    }
}
exports.TokenAnalyzer = TokenAnalyzer;
