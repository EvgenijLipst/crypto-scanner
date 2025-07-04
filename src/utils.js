"use strict";
// utils.ts - Утилиты для сигнального бота
Object.defineProperty(exports, "__esModule", { value: true });
exports.passesAge = passesAge;
exports.bucketTs = bucketTs;
exports.toUnixSeconds = toUnixSeconds;
exports.formatNumber = formatNumber;
exports.escapeMarkdown = escapeMarkdown;
exports.createBirdeyeLink = createBirdeyeLink;
exports.log = log;
const types_1 = require("./types");
/**
 * Проверяет, что токен существует >= 14 дней
 */
function passesAge(pool) {
    const ageDays = (Date.now() / 1000 - pool.first_seen_ts) / 86400;
    return ageDays >= types_1.MIN_TOKEN_AGE_DAYS;
}
/**
 * Округляет timestamp до начала минуты
 */
function bucketTs(sec) {
    return sec - (sec % 60);
}
/**
 * Конвертирует Date в unix timestamp (секунды)
 */
function toUnixSeconds(date = new Date()) {
    return Math.floor(date.getTime() / 1000);
}
/**
 * Форматирует число для Telegram
 */
function formatNumber(num, decimals = 2) {
    return num.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}
/**
 * Escape специальных символов для Telegram MarkdownV2
 */
function escapeMarkdown(text) {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}
/**
 * Создает Birdeye ссылку для токена
 */
function createBirdeyeLink(mint) {
    return `https://birdeye.so/token/${mint}`;
}
/**
 * Логирование с временной меткой
 */
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
}
