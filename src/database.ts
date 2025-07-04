// database.ts - Работа с PostgreSQL

import { Pool, PoolClient } from 'pg';
import { PoolRow, OHLCVRow, SignalRow } from './types';
import { bucketTs, log } from './utils';

export class Database {
  private pool: Pool;

  constructor(connectionString: string) {
    log(`Connecting to database: ${connectionString.replace(/\/\/.*:.*@/, '//[credentials]@')}`);
    
    // Парсим строку подключения для отдельной настройки SSL
    const isProduction = connectionString.includes('railway') || connectionString.includes('.proxy.rlwy.net');
    
    this.pool = new Pool({
      connectionString,
      ssl: isProduction ? { 
        rejectUnauthorized: false
      } : false,
      // Добавляем дополнительные настройки подключения
      max: 5,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 5000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });

    // Обработка ошибок подключения
    this.pool.on('error', (err) => {
      log('Database pool error:', 'ERROR');
      log(String(err), 'ERROR');
    });

    this.pool.on('connect', () => {
      log('Database client connected');
    });
  }

  /**
   * Инициализация таблиц
   */
  async initialize(): Promise<void> {
    let retries = 3;
    while (retries > 0) {
      try {
        log(`Database connection attempt (${4 - retries}/3)...`);
        
        // Небольшая задержка перед попыткой подключения
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const client = await this.pool.connect();
        try {
          log('Connected to database, creating tables...');
          
          // Создаем таблицы (signals уже существует)
          log('Creating pools table...');
          await client.query(`
            CREATE TABLE IF NOT EXISTS pools (
              mint            TEXT PRIMARY KEY,
              first_seen_ts   BIGINT,
              liq_usd         NUMERIC,
              fdv_usd         NUMERIC
            );
          `);

          log('Creating ohlcv table...');
          await client.query(`
            CREATE TABLE IF NOT EXISTS ohlcv (
              mint TEXT,
              ts   BIGINT,
              o NUMERIC, h NUMERIC, l NUMERIC, c NUMERIC, v NUMERIC,
              PRIMARY KEY (mint, ts)
            );
          `);

          // Создаем/обновляем таблицу signals с правильной структурой
          log('Creating/updating signals table...');
          await client.query(`
            CREATE TABLE IF NOT EXISTS signals (
              id  SERIAL PRIMARY KEY,
              mint TEXT,
              signal_ts BIGINT,
              ema_cross BOOLEAN,
              vol_spike NUMERIC,
              rsi       NUMERIC,
              notified  BOOLEAN DEFAULT FALSE
            );
          `);

          // Миграция: переименовать token_mint в mint, если нужно
          try {
            await client.query(`ALTER TABLE signals RENAME COLUMN token_mint TO mint;`);
            log('Migrated token_mint to mint');
          } catch (e) {
            // Игнорируем ошибку - возможно, миграция уже выполнена
            log('Migration token_mint->mint already done or not needed');
          }

          // Создаем индексы
          log('Creating indexes...');
          await client.query(`CREATE INDEX IF NOT EXISTS idx_pools_first_seen ON pools (first_seen_ts);`);
          await client.query(`CREATE INDEX IF NOT EXISTS idx_ohlcv_mint_ts ON ohlcv (mint, ts DESC);`);
          await client.query(`CREATE INDEX IF NOT EXISTS idx_signals_notified ON signals (notified, signal_ts);`);

          log('Database initialized successfully');
          return; // Успешно инициализировали, выходим
        } finally {
          client.release();
        }
      } catch (error) {
        retries--;
        log(`Database initialization error (attempts left: ${retries}):`, 'ERROR');
        log(String(error), 'ERROR');
        
        if (retries === 0) {
          throw error;
        }
        
        // Ждем перед следующей попыткой
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  /**
   * Добавить или обновить пул
   */
  async upsertPool(mint: string, firstSeenTs: number, liqUsd?: number, fdvUsd?: number): Promise<void> {
    await this.pool.query(`
      INSERT INTO pools(mint, first_seen_ts, liq_usd, fdv_usd)
      VALUES($1, $2, $3, $4)
      ON CONFLICT(mint) DO UPDATE SET
        liq_usd = COALESCE(EXCLUDED.liq_usd, pools.liq_usd),
        fdv_usd = COALESCE(EXCLUDED.fdv_usd, pools.fdv_usd)
    `, [mint, firstSeenTs, liqUsd, fdvUsd]);
  }

  /**
   * Получить информацию о пуле
   */
  async getPool(mint: string): Promise<PoolRow | null> {
    const res = await this.pool.query('SELECT * FROM pools WHERE mint = $1', [mint]);
    return res.rows[0] || null;
  }

  /**
   * Получить все известные минты (старше 14 дней)
   */
  async getOldPools(): Promise<PoolRow[]> {
    const fourteenDaysAgo = Math.floor(Date.now() / 1000) - (14 * 24 * 60 * 60);
    const res = await this.pool.query(
      'SELECT * FROM pools WHERE first_seen_ts <= $1',
      [fourteenDaysAgo]
    );
    return res.rows;
  }

  /**
   * Добавить/обновить OHLCV данные
   */
  async ingestSwap(mint: string, price: number, volUsd: number, tsSec: number): Promise<void> {
    const bucket = bucketTs(tsSec);
    await this.pool.query(`
      INSERT INTO ohlcv (mint, ts, o,h,l,c,v)
      VALUES ($1,$2,$3,$3,$3,$3,$4)
      ON CONFLICT (mint, ts) DO UPDATE
        SET h = GREATEST(ohlcv.h, EXCLUDED.h),
            l = LEAST(ohlcv.l, EXCLUDED.l),
            c = EXCLUDED.c,
            v = ohlcv.v + EXCLUDED.v
    `, [mint, bucket, price, volUsd]);
  }

  /**
   * Обновить OHLCV данные (алиас для ingestSwap для совместимости)
   */
  async updateOHLCV(mint: string, price: number, volumeUsd: number, timestamp: number): Promise<void> {
    return this.ingestSwap(mint, price, volumeUsd, timestamp);
  }

  /**
   * Получить последние свечи для расчета индикаторов
   */
  async getCandles(mint: string, limit: number = 40): Promise<OHLCVRow[]> {
    const res = await this.pool.query(`
      SELECT * FROM ohlcv
      WHERE mint = $1
      ORDER BY ts DESC
      LIMIT $2
    `, [mint, limit]);
    
    return res.rows.reverse(); // oldest → latest для talib
  }

  /**
   * Получить OHLCV данные (алиас для getCandles)
   */
  async getOHLCV(mint: string, limit: number = 40): Promise<OHLCVRow[]> {
    return this.getCandles(mint, limit);
  }

  /**
   * Создать сигнал
   */
  async createSignal(
    mint: string, 
    emaCross: boolean, 
    volSpike: number, 
    rsi: number
  ): Promise<void> {
    const currentTimestamp = Math.floor(Date.now() / 1000);
    await this.pool.query(`
      INSERT INTO signals(mint, signal_ts, ema_cross, vol_spike, rsi, notified)
      VALUES($1, $2, $3, $4, $5, false)
    `, [mint, currentTimestamp, emaCross, volSpike, rsi]);
  }

  /**
   * Получить неотправленные сигналы
   */
  async getUnnotifiedSignals(): Promise<SignalRow[]> {
    const res = await this.pool.query(`
      SELECT id, mint, signal_ts, ema_cross, vol_spike, rsi, notified,
             to_timestamp(signal_ts) as created_at
      FROM signals 
      WHERE notified = false
      ORDER BY signal_ts ASC
    `);
    return res.rows;
  }

  /**
   * Отметить сигнал как отправленный
   */
  async markSignalNotified(signalId: number): Promise<void> {
    await this.pool.query('UPDATE signals SET notified = true WHERE id = $1', [signalId]);
  }

  /**
   * Очистка старых данных
   */
  async cleanup(): Promise<void> {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Удаляем старые OHLCV данные (старше 24 часов)
    const oneDayAgoTs = Math.floor(oneDayAgo.getTime() / 1000);
    await this.pool.query('DELETE FROM ohlcv WHERE ts < $1', [oneDayAgoTs]);
    
    // Удаляем старые сигналы (старше 24 часов) - используем signal_ts, а не created_at
    await this.pool.query('DELETE FROM signals WHERE signal_ts < $1', [oneDayAgoTs]);
    
    log('Database cleanup completed');
  }

  /**
   * Закрыть соединения
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
} 