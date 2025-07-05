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

          log('Ensuring coin_data table compatibility...');
          // Проверяем и создаем/обновляем таблицу coin_data
          await client.query(`
            CREATE TABLE IF NOT EXISTS coin_data (
              id SERIAL PRIMARY KEY,
              coin_id TEXT NOT NULL,
              mint TEXT NOT NULL,
              symbol TEXT NOT NULL,
              name TEXT NOT NULL,
              network TEXT NOT NULL DEFAULT 'Solana',
              price NUMERIC NOT NULL,
              volume NUMERIC NOT NULL,
              market_cap NUMERIC,
              fdv NUMERIC,
              timestamp TIMESTAMP DEFAULT NOW()
            );
          `);
          
          // Проверяем, есть ли уже уникальное ограничение
          const constraintCheck = await client.query(`
            SELECT constraint_name 
            FROM information_schema.table_constraints 
            WHERE table_name = 'coin_data' 
            AND constraint_type = 'UNIQUE' 
            AND constraint_name = 'coin_data_coin_network_uidx'
          `);
          
          if (constraintCheck.rows.length === 0) {
            log('Unique constraint not found, creating it...');
            
            // Сначала удаляем дубликаты (оставляем самые свежие записи)
            log('Removing duplicates from coin_data...');
            const duplicatesResult = await client.query(`
              DELETE FROM coin_data a
              USING coin_data b
              WHERE a.ctid < b.ctid
                AND a.coin_id = b.coin_id
                AND a.network = b.network
            `);
            log(`Removed ${duplicatesResult.rowCount || 0} duplicate records`);
            
            // Теперь создаем уникальное ограничение
            try {
              await client.query(`
                ALTER TABLE coin_data 
                ADD CONSTRAINT coin_data_coin_network_uidx UNIQUE (coin_id, network);
              `);
              log('✅ Successfully added unique constraint for coin_data');
            } catch (constraintError) {
              log(`❌ Failed to add unique constraint: ${constraintError}`, 'ERROR');
              // Если не получилось создать ограничение, будем использовать простые INSERT
            }
          } else {
            log('✅ Unique constraint already exists');
          }
          
          // Добавляем обычные индексы если их нет
          await client.query(`
            CREATE INDEX IF NOT EXISTS idx_coin_data_network_timestamp 
            ON coin_data (network, timestamp DESC);
          `);
          
          await client.query(`
            CREATE INDEX IF NOT EXISTS idx_coin_data_timestamp 
            ON coin_data (timestamp DESC);
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
  async saveCoinData(coinId: string, mint: string, symbol: string, name: string, network: string, price: number, volume: number, marketCap: number, fdv: number): Promise<void> {
    try {
      // Пробуем с ON CONFLICT (если есть уникальное ограничение)
      await this.pool.query(`
        INSERT INTO coin_data (coin_id, mint, symbol, name, network, price, volume, market_cap, fdv, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT ON CONSTRAINT coin_data_coin_network_uidx DO UPDATE SET
          mint = EXCLUDED.mint,
          symbol = EXCLUDED.symbol,
          name = EXCLUDED.name,
          price = EXCLUDED.price,
          volume = EXCLUDED.volume,
          market_cap = EXCLUDED.market_cap,
          fdv = EXCLUDED.fdv,
          timestamp = EXCLUDED.timestamp
      `, [coinId, mint, symbol, name, network, price, volume, marketCap, fdv]);
    } catch (error) {
      // Если ограничения нет, используем простой INSERT
      try {
        await this.pool.query(`
          INSERT INTO coin_data (coin_id, mint, symbol, name, network, price, volume, market_cap, fdv, timestamp)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        `, [coinId, mint, symbol, name, network, price, volume, marketCap, fdv]);
      } catch (insertError) {
        log(`Error saving coin data (fallback): ${insertError}`, 'ERROR');
        // Не бросаем ошибку, чтобы не сломать весь процесс
      }
    }
  }

  /**
   * Сохранить батч токенов в coin_data
   */
  async saveCoinDataBatch(tokens: Array<{coinId: string, mint: string, symbol: string, name: string, network: string, price: number, volume: number, marketCap: number, fdv: number}>): Promise<void> {
    if (tokens.length === 0) return;
    
    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        let savedCount = 0;
        for (const token of tokens) {
          try {
            // Пробуем с ON CONFLICT (если есть уникальное ограничение)
            await client.query(`
              INSERT INTO coin_data (coin_id, mint, symbol, name, network, price, volume, market_cap, fdv, timestamp)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
              ON CONFLICT ON CONSTRAINT coin_data_coin_network_uidx DO UPDATE SET
                mint = EXCLUDED.mint,
                symbol = EXCLUDED.symbol,
                name = EXCLUDED.name,
                price = EXCLUDED.price,
                volume = EXCLUDED.volume,
                market_cap = EXCLUDED.market_cap,
                fdv = EXCLUDED.fdv,
                timestamp = EXCLUDED.timestamp
            `, [token.coinId, token.mint, token.symbol, token.name, token.network, token.price, token.volume, token.marketCap, token.fdv]);
            savedCount++;
          } catch (conflictError) {
            // Если ограничения нет, используем простой INSERT
            await client.query(`
              INSERT INTO coin_data (coin_id, mint, symbol, name, network, price, volume, market_cap, fdv, timestamp)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
            `, [token.coinId, token.mint, token.symbol, token.name, token.network, token.price, token.volume, token.marketCap, token.fdv]);
            savedCount++;
          }
        }
        await client.query('COMMIT');
        log(`✅ Saved ${savedCount}/${tokens.length} tokens to coin_data table`);
      } catch (error) {
        await client.query('ROLLBACK');
        log(`Error in transaction: ${error}`, 'ERROR');
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
   * Получить все свежие токены из coin_data (не старше 24 часов)
   */
  async getFreshTokensFromCoinData(network: string = 'Solana', maxAgeHours: number = 24): Promise<any[]> {
    try {
      const res = await this.pool.query(`
        SELECT coin_id, mint, symbol, name, network, price, volume, market_cap, fdv, timestamp 
        FROM coin_data 
        WHERE network = $1 
        AND timestamp > NOW() - INTERVAL '${maxAgeHours} hours'
        ORDER BY volume DESC
      `, [network]);
      
      log(`📊 Found ${res.rows.length} fresh tokens in coin_data (last ${maxAgeHours} hours)`);
      return res.rows;
    } catch (error) {
      log(`Error getting fresh tokens from coin_data: ${error}`, 'ERROR');
      return [];
    }
  }

  /**
   * Проверить, есть ли достаточно свежих токенов в базе
   */
  async hasFreshTokens(network: string = 'Solana', minCount: number = 500, maxAgeHours: number = 24): Promise<boolean> {
    try {
      const res = await this.pool.query(`
        SELECT COUNT(*) as count
        FROM coin_data 
        WHERE network = $1 
        AND timestamp > NOW() - INTERVAL '${maxAgeHours} hours'
        AND mint IS NOT NULL 
        AND mint != ''
        AND mint NOT LIKE '%placeholder%'
      `, [network]);
      
      const count = parseInt(res.rows[0].count);
      log(`🔍 Database check: ${count} fresh tokens with real mint addresses found (need ${minCount})`);
      return count >= minCount;
    } catch (error) {
      log(`Error checking fresh tokens: ${error}`, 'ERROR');
      return false;
    }
  }

  /**
   * Очистить старые данные из coin_data (старше 48 часов)
   */
  async cleanupOldCoinData(maxAgeHours: number = 48): Promise<void> {
    try {
      const res = await this.pool.query(`
        DELETE FROM coin_data 
        WHERE timestamp < NOW() - INTERVAL '${maxAgeHours} hours'
      `);
      
      const deletedCount = res.rowCount || 0;
      if (deletedCount > 0) {
        log(`🧹 Cleaned up ${deletedCount} old coin_data records (older than ${maxAgeHours} hours)`);
      } else {
        log(`🧹 No old coin_data records to clean up`);
      }
    } catch (error) {
      log(`Error cleaning up old coin_data: ${error}`, 'ERROR');
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