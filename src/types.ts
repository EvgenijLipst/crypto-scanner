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
  mint: string;  // token_mint из БД
  signal_ts: number; // unix timestamp когда был создан сигнал
  created_at: Date;
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

// Константы для фильтрации
export const MIN_TOKEN_AGE_DAYS = 14;
export const MIN_LIQUIDITY_USD = 10_000;
export const MAX_FDV_USD = 5_000_000;
export const MIN_VOLUME_SPIKE = 3;
export const MAX_RSI_OVERSOLD = 35;
export const MAX_PRICE_IMPACT_PERCENT = 3;
export const MIN_HISTORY_CANDLES = 40; 