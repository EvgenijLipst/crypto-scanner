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

          // Принудительно пересоздаем таблицу signals с правильной структурой
          log('Recreating signals table with correct structure...');
          
          // Удаляем старую таблицу и создаем новую
          await client.query(`DROP TABLE IF EXISTS signals;`);
          await client.query(`
            CREATE TABLE signals (
              id  SERIAL PRIMARY KEY,
              mint TEXT,
              signal_ts BIGINT,
              ema_cross BOOLEAN,
              vol_spike NUMERIC,
              rsi       NUMERIC,
              notified  BOOLEAN DEFAULT FALSE
            );
          `);
          log('Successfully recreated signals table with mint field');

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
   * Сохранить данные токена в coin_data
   */
  async saveCoinData(coinId: string, network: string, price: number, volume: number): Promise<void> {
    try {
      await this.pool.query(`
        INSERT INTO coin_data (coin_id, network, price, volume, timestamp)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (coin_id, network) DO UPDATE SET
          price = EXCLUDED.price,
          volume = EXCLUDED.volume,
          timestamp = EXCLUDED.timestamp
      `, [coinId, network, price, volume]);
    } catch (error) {
      log(`Error saving coin data: ${error}`, 'ERROR');
      throw error;
    }
  }

  /**
   * Сохранить батч токенов в coin_data
   */
  async saveCoinDataBatch(tokens: Array<{coinId: string, network: string, price: number, volume: number}>): Promise<void> {
    if (tokens.length === 0) return;
    
    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        
        for (const token of tokens) {
          await client.query(`
            INSERT INTO coin_data (coin_id, network, price, volume, timestamp)
            VALUES ($1, $2, $3, $4, NOW())
            ON CONFLICT (coin_id, network) DO UPDATE SET
              price = EXCLUDED.price,
              volume = EXCLUDED.volume,
              timestamp = EXCLUDED.timestamp
          `, [token.coinId, token.network, token.price, token.volume]);
        }
        
        await client.query('COMMIT');
        log(`✅ Saved ${tokens.length} tokens to coin_data table`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      log(`Error saving coin data batch: ${error}`, 'ERROR');
      throw error;
    }
  }

  /**
   * Получить данные токена из coin_data
   */
  async getCoinData(coinId: string, network: string = 'Solana'): Promise<any> {
    try {
      const res = await this.pool.query(`
        SELECT * FROM coin_data 
        WHERE coin_id = $1 AND network = $2
        ORDER BY timestamp DESC
        LIMIT 1
      `, [coinId, network]);
      
      return res.rows[0] || null;
    } catch (error) {
      log(`Error getting coin data: ${error}`, 'ERROR');
      return null;
    }
  }

  /**
   * Получить информацию о пуле
   */
  async getPool(mint: string): Promise<PoolRow | null> {
    try {
      log(`🔍 Getting pool info for mint: ${mint}`);
      const sql = 'SELECT * FROM pools WHERE mint = $1';
      log(`📋 SQL: ${sql} with params: [${mint}]`);
      
      const res = await this.pool.query(sql, [mint]);
      log(`📋 getPool returned ${res.rows.length} rows`);
      
      if (res.rows.length > 0) {
        log(`📋 Pool data: ${JSON.stringify(res.rows[0])}`);
      }
      
      return res.rows[0] || null;
    } catch (error) {
      log(`❌ Error in getPool: ${error}`, 'ERROR');
      log(`❌ Error stack: ${error instanceof Error ? error.stack : 'No stack'}`, 'ERROR');
      throw error;
    }
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
    try {
      log(`🔍 Creating signal for mint: ${mint}`);
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const sql = `
        INSERT INTO signals(mint, signal_ts, ema_cross, vol_spike, rsi, notified)
        VALUES($1, $2, $3, $4, $5, false)
      `;
      log(`📋 SQL: ${sql}`);
      log(`📋 Params: [${mint}, ${currentTimestamp}, ${emaCross}, ${volSpike}, ${rsi}]`);
      
      await this.pool.query(sql, [mint, currentTimestamp, emaCross, volSpike, rsi]);
      log(`✅ Successfully created signal for ${mint}`);
    } catch (error) {
      log(`❌ Error in createSignal: ${error}`, 'ERROR');
      log(`❌ Error stack: ${error instanceof Error ? error.stack : 'No stack'}`, 'ERROR');
      throw error;
    }
  }

  /**
   * Получить неотправленные сигналы
   */
  async getUnnotifiedSignals(): Promise<SignalRow[]> {
    try {
      log('🔍 Executing getUnnotifiedSignals query...');
      const sql = `
        SELECT id, mint, signal_ts, ema_cross, vol_spike, rsi, notified
        FROM signals 
        WHERE notified = false
        ORDER BY signal_ts ASC
      `;
      log(`📋 SQL: ${sql}`);
      
      const res = await this.pool.query(sql);
      log(`📋 getUnnotifiedSignals returned ${res.rows.length} rows`);
      
      if (res.rows.length > 0) {
        log(`📋 First signal: ${JSON.stringify(res.rows[0])}`);
      }
      
      return res.rows;
    } catch (error) {
      log(`❌ Error in getUnnotifiedSignals: ${error}`, 'ERROR');
      log(`❌ Error stack: ${error instanceof Error ? error.stack : 'No stack'}`, 'ERROR');
      throw error;
    }
  }

  /**
   * Отметить сигнал как отправленный
   */
  async markSignalNotified(signalId: number): Promise<void> {
    try {
      log(`🔍 Marking signal ${signalId} as notified...`);
      const sql = 'UPDATE signals SET notified = true WHERE id = $1';
      log(`📋 SQL: ${sql} with params: [${signalId}]`);
      
      await this.pool.query(sql, [signalId]);
      log(`✅ Successfully marked signal ${signalId} as notified`);
    } catch (error) {
      log(`❌ Error in markSignalNotified: ${error}`, 'ERROR');
      log(`❌ Error stack: ${error instanceof Error ? error.stack : 'No stack'}`, 'ERROR');
      throw error;
    }
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