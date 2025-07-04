"use strict";
// indicators.ts - Технический анализ (собственная реализация)
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateIndicators = calculateIndicators;
exports.checkBuySignal = checkBuySignal;
exports.formatIndicators = formatIndicators;
const types_1 = require("./types");
const utils_1 = require("./utils");
/**
 * Вычисляет EMA (Exponential Moving Average)
 */
function calculateEMA(values, period) {
    const ema = [];
    const multiplier = 2 / (period + 1);
    // Первое значение EMA = SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += values[i];
    }
    ema[period - 1] = sum / period;
    // Последующие значения EMA
    for (let i = period; i < values.length; i++) {
        ema[i] = (values[i] * multiplier) + (ema[i - 1] * (1 - multiplier));
    }
    return ema;
}
/**
 * Вычисляет RSI (Relative Strength Index)
 */
function calculateRSI(values, period = 14) {
    const rsi = [];
    const gains = [];
    const losses = [];
    // Вычисляем gains и losses
    for (let i = 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? Math.abs(change) : 0);
    }
    // Первый RSI основан на простом среднем
    let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
    let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
    if (avgLoss === 0) {
        rsi[period] = 100;
    }
    else {
        const rs = avgGain / avgLoss;
        rsi[period] = 100 - (100 / (1 + rs));
    }
    // Остальные RSI используют сглаженное среднее
    for (let i = period + 1; i < gains.length + 1; i++) {
        avgGain = (avgGain * (period - 1) + gains[i - 1]) / period;
        avgLoss = (avgLoss * (period - 1) + losses[i - 1]) / period;
        if (avgLoss === 0) {
            rsi[i] = 100;
        }
        else {
            const rs = avgGain / avgLoss;
            rsi[i] = 100 - (100 / (1 + rs));
        }
    }
    return rsi;
}
/**
 * Вычисляет технические индикаторы для массива свечей
 */
function calculateIndicators(candles) {
    if (candles.length < types_1.MIN_HISTORY_CANDLES) {
        (0, utils_1.log)(`Not enough candles: ${candles.length} < ${types_1.MIN_HISTORY_CANDLES}`, 'WARN');
        return null;
    }
    try {
        const closes = candles.map(c => Number(c.c));
        const volumes = candles.map(c => Number(c.v));
        // EMA 9 и 21
        const ema9 = calculateEMA(closes, 9);
        const ema21 = calculateEMA(closes, 21);
        // Проверяем bullish cross (EMA9 пересекает EMA21 вверх)
        const prevCross = ema9[ema9.length - 2] <= ema21[ema21.length - 2];
        const nowCross = ema9[ema9.length - 1] > ema21[ema21.length - 1];
        const bullishCross = prevCross && nowCross;
        // Volume spike: последние 5 минут vs предыдущие 30 минут
        const vLast5 = volumes.slice(-5).reduce((a, b) => a + b, 0);
        const vPrev30 = volumes.slice(-35, -5).reduce((a, b) => a + b, 0) / 30;
        const volSpike = vPrev30 > 0 ? vLast5 / (vPrev30 * 5) : 0;
        // RSI 14
        const rsiValues = calculateRSI(closes, 14);
        const rsi = rsiValues[rsiValues.length - 1] || 50; // default to neutral
        return {
            ema9,
            ema21,
            rsi,
            volSpike,
            bullishCross
        };
    }
    catch (error) {
        (0, utils_1.log)(`Error calculating indicators: ${error}`, 'ERROR');
        return null;
    }
}
/**
 * Проверяет, генерируется ли сигнал на покупку
 */
function checkBuySignal(indicators) {
    const { bullishCross, volSpike, rsi } = indicators;
    // Все условия должны выполняться одновременно
    return bullishCross &&
        volSpike >= types_1.MIN_VOLUME_SPIKE &&
        rsi < types_1.MAX_RSI_OVERSOLD;
}
/**
 * Форматирует индикаторы для отображения
 */
function formatIndicators(indicators) {
    return [
        `EMA Cross: ${indicators.bullishCross ? '✅' : '❌'}`,
        `Volume Spike: x${indicators.volSpike.toFixed(1)} ${indicators.volSpike >= types_1.MIN_VOLUME_SPIKE ? '✅' : '❌'}`,
        `RSI: ${indicators.rsi.toFixed(1)} ${indicators.rsi < types_1.MAX_RSI_OVERSOLD ? '✅' : '❌'}`
    ].join('\n');
}
