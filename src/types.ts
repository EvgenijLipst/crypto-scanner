// types.ts - Типы для сигнального бота

export interface PoolRow {
  mint: string;
  first_seen_ts: number;
  liq_usd: number;
  fdv_usd: number;
}

export interface OHLCVRow {
  mint: string;
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface SignalRow {
  id: number;
  mint: string;
  signal_ts: number; // unix timestamp когда был создан сигнал
  ema_cross: boolean;
  vol_spike: number;
  rsi: number;
  notified: boolean;
}

export interface SwapEvent {
  mint: string;
  price: number;
  volumeUsd: number;
  timestamp: number;
}

export interface InitPoolEvent {
  mint: string;
  timestamp: number;
  liquidityUsd?: number;
  fdvUsd?: number;
}

export interface TechnicalIndicators {
  ema9: number[];
  ema21: number[];
  rsi: number;
  volSpike: number;
  bullishCross: boolean;
}

// Константы для фильтрации - СМЯГЧЕННЫЕ КРИТЕРИИ
export const MIN_TOKEN_AGE_DAYS = 7; // снижено с 14 до 7
export const MIN_LIQUIDITY_USD = 5_000; // снижено с 10_000 до 5_000
export const MAX_FDV_USD = 10_000_000; // увеличено с 5_000_000 до 10_000_000
export const MIN_VOLUME_SPIKE = 2; // снижено с 3 до 2
export const MAX_RSI_OVERSOLD = 45; // увеличено с 35 до 45
export const MAX_PRICE_IMPACT_PERCENT = 5; // увеличено с 3 до 5
export const MIN_HISTORY_CANDLES = 30; // снижено с 40 до 30 