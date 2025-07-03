// utils.ts - Утилиты для сигнального бота

import { PoolRow, MIN_TOKEN_AGE_DAYS } from './types';

/**
 * Проверяет, что токен существует >= 14 дней
 */
export function passesAge(pool: PoolRow): boolean {
  const ageDays = (Date.now() / 1000 - pool.first_seen_ts) / 86_400;
  return ageDays >= MIN_TOKEN_AGE_DAYS;
}

/**
 * Округляет timestamp до начала минуты
 */
export function bucketTs(sec: number): number {
  return sec - (sec % 60);
}

/**
 * Конвертирует Date в unix timestamp (секунды)
 */
export function toUnixSeconds(date: Date = new Date()): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Форматирует число для Telegram
 */
export function formatNumber(num: number, decimals: number = 2): string {
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

/**
 * Escape специальных символов для Telegram MarkdownV2
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Создает Birdeye ссылку для токена
 */
export function createBirdeyeLink(mint: string): string {
  return `https://birdeye.so/token/${mint}`;
}

/**
 * Логирование с временной меткой
 */
export function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO'): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
} 