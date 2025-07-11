"use strict";
// database.ts - Работа с PostgreSQL
Object.defineProperty(exports, "__esModule", { value: true });
exports.Database = void 0;
const pg_1 = require("pg");
const utils_1 = require("./utils");
class Database {
    constructor(connectionString) {
        (0, utils_1.log)(`Connecting to database: ${connectionString.replace(/\/\/.*:.*@/, '//[credentials]@')}`);
        // Парсим строку подключения для отдельной настройки SSL
        const isProduction = connectionString.includes('railway') || connectionString.includes('.proxy.rlwy.net');
        this.pool = new pg_1.Pool({
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
            (0, utils_1.log)('Database pool error:', 'ERROR');
            (0, utils_1.log)(String(err), 'ERROR');
        });
        this.pool.on('connect', () => {
            (0, utils_1.log)('Database client connected');
        });
    }
    /**
     * Инициализация таблиц
     */
    async initialize() {
        let retries = 3;
        while (retries > 0) {
            try {
                (0, utils_1.log)(`Database connection attempt (${4 - retries}/3)...`);
                // Небольшая задержка перед попыткой подключения
                await new Promise(resolve => setTimeout(resolve, 1000));
                const client = await this.pool.connect();
                try {
                    (0, utils_1.log)('Connected to database, creating tables...');
                    // Создаем таблицы (signals уже существует)
                    (0, utils_1.log)('Creating pools table...');
                    await client.query(`
            CREATE TABLE IF NOT EXISTS pools (
              mint            TEXT PRIMARY KEY,
              first_seen_ts   BIGINT,
              liq_usd         NUMERIC,
              fdv_usd         NUMERIC
            );
          `);
                    (0, utils_1.log)('Creating ohlcv table...');
                    await client.query(`
            CREATE TABLE IF NOT EXISTS ohlcv (
              mint TEXT,
              ts   BIGINT,
              o NUMERIC, h NUMERIC, l NUMERIC, c NUMERIC, v NUMERIC,
              PRIMARY KEY (mint, ts)
            );
          `);
                    (0, utils_1.log)('Ensuring coin_data table compatibility...');
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
                        (0, utils_1.log)('Unique constraint not found, creating it...');
                        // Сначала удаляем дубликаты (оставляем самые свежие записи)
                        (0, utils_1.log)('Removing duplicates from coin_data...');
                        const duplicatesResult = await client.query(`
              DELETE FROM coin_data a
              USING coin_data b
              WHERE a.ctid < b.ctid
                AND a.coin_id = b.coin_id
                AND a.network = b.network
            `);
                        (0, utils_1.log)(`Removed ${duplicatesResult.rowCount || 0} duplicate records`);
                        // Теперь создаем уникальное ограничение
                        try {
                            await client.query(`
                ALTER TABLE coin_data 
                ADD CONSTRAINT coin_data_coin_network_uidx UNIQUE (coin_id, network);
              `);
                            (0, utils_1.log)('✅ Successfully added unique constraint for coin_data');
                        }
                        catch (constraintError) {
                            (0, utils_1.log)(`❌ Failed to add unique constraint: ${constraintError}`, 'ERROR');
                            // Если не получилось создать ограничение, будем использовать простые INSERT
                        }
                    }
                    else {
                        (0, utils_1.log)('✅ Unique constraint already exists');
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
                    (0, utils_1.log)('Recreating signals table with correct structure...');
                    // Удаляем старую таблицу и создаем новую
                    await client.query(`DROP TABLE IF EXISTS signals;`);
                    await client.query(`
            CREATE TABLE signals (
              id  SERIAL PRIMARY KEY,
              mint TEXT NOT NULL,
              symbol TEXT,
              signal_ts BIGINT NOT NULL,
              signal_datetime TIMESTAMP DEFAULT NOW(),
              ema_cross BOOLEAN DEFAULT FALSE,
              vol_spike NUMERIC DEFAULT 0,
              rsi NUMERIC DEFAULT 0,
              price_change NUMERIC DEFAULT 0,
              volume_24h NUMERIC DEFAULT 0,
              market_cap NUMERIC DEFAULT 0,
              reasons TEXT,
              notified BOOLEAN DEFAULT FALSE,
              created_at TIMESTAMP DEFAULT NOW()
            );
          `);
                    (0, utils_1.log)('Successfully recreated signals table with proper datetime fields');
                    // Создаем индексы
                    (0, utils_1.log)('Creating indexes...');
                    await client.query(`CREATE INDEX IF NOT EXISTS idx_pools_first_seen ON pools (first_seen_ts);`);
                    await client.query(`CREATE INDEX IF NOT EXISTS idx_ohlcv_mint_ts ON ohlcv (mint, ts DESC);`);
                    await client.query(`CREATE INDEX IF NOT EXISTS idx_signals_notified ON signals (notified, signal_ts);`);
                    (0, utils_1.log)('Database initialized successfully');
                    return; // Успешно инициализировали, выходим
                }
                finally {
                    client.release();
                }
            }
            catch (error) {
                retries--;
                (0, utils_1.log)(`Database initialization error (attempts left: ${retries}):`, 'ERROR');
                (0, utils_1.log)(String(error), 'ERROR');
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
    async upsertPool(mint, firstSeenTs, liqUsd, fdvUsd) {
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
    async saveCoinData(coinId, mint, symbol, name, network, price, volume, marketCap, fdv) {
        try {
            // Проверяем, существует ли уже токен с таким mint адресом
            const existingToken = await this.pool.query(`
        SELECT coin_id, mint FROM coin_data 
        WHERE mint = $1 AND network = $2
        LIMIT 1
      `, [mint, network]);
            if (existingToken.rows.length > 0) {
                // Обновляем существующий токен
                await this.pool.query(`
          UPDATE coin_data 
          SET coin_id = $1, symbol = $2, name = $3, price = $4, volume = $5, market_cap = $6, fdv = $7, timestamp = NOW()
          WHERE mint = $8 AND network = $9
        `, [coinId, symbol, name, price, volume, marketCap, fdv, mint, network]);
                (0, utils_1.log)(`🔄 Updated existing token: ${symbol} (${mint})`);
            }
            else {
                // Вставляем новый токен
                await this.pool.query(`
          INSERT INTO coin_data (coin_id, mint, symbol, name, network, price, volume, market_cap, fdv, timestamp)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        `, [coinId, mint, symbol, name, network, price, volume, marketCap, fdv]);
                (0, utils_1.log)(`➕ Inserted new token: ${symbol} (${mint})`);
            }
        }
        catch (error) {
            (0, utils_1.log)(`Error saving coin data: ${error}`, 'ERROR');
            throw error;
        }
    }
    /**
     * Сохранить батч токенов в coin_data
     */
    async saveCoinDataBatch(tokens) {
        if (tokens.length === 0)
            return;
        try {
            const client = await this.pool.connect();
            try {
                await client.query('BEGIN');
                let savedCount = 0;
                let updatedCount = 0;
                for (const token of tokens) {
                    try {
                        // Проверяем, существует ли уже токен с таким mint адресом
                        const existingToken = await client.query(`
              SELECT coin_id, mint FROM coin_data 
              WHERE mint = $1 AND network = $2
              LIMIT 1
            `, [token.mint, token.network]);
                        if (existingToken.rows.length > 0) {
                            // Обновляем существующий токен
                            await client.query(`
                UPDATE coin_data 
                SET coin_id = $1, symbol = $2, name = $3, price = $4, volume = $5, market_cap = $6, fdv = $7, timestamp = NOW()
                WHERE mint = $8 AND network = $9
              `, [token.coinId, token.symbol, token.name, token.price, token.volume, token.marketCap, token.fdv, token.mint, token.network]);
                            updatedCount++;
                            (0, utils_1.log)(`🔄 Updated existing token: ${token.symbol} (${token.mint})`);
                        }
                        else {
                            // Вставляем новый токен
                            await client.query(`
                INSERT INTO coin_data (coin_id, mint, symbol, name, network, price, volume, market_cap, fdv, timestamp)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
              `, [token.coinId, token.mint, token.symbol, token.name, token.network, token.price, token.volume, token.marketCap, token.fdv]);
                            savedCount++;
                            (0, utils_1.log)(`➕ Inserted new token: ${token.symbol} (${token.mint})`);
                        }
                    }
                    catch (error) {
                        (0, utils_1.log)(`❌ Error processing token ${token.symbol} (${token.mint}): ${error}`, 'ERROR');
                        // Продолжаем с следующим токеном
                    }
                }
                await client.query('COMMIT');
                (0, utils_1.log)(`✅ Database operation completed: ${savedCount} new tokens inserted, ${updatedCount} existing tokens updated`);
                (0, utils_1.log)(`📊 Total tokens processed: ${savedCount + updatedCount}/${tokens.length}`);
            }
            catch (error) {
                await client.query('ROLLBACK');
                (0, utils_1.log)(`Error in transaction: ${error}`, 'ERROR');
                throw error;
            }
            finally {
                client.release();
            }
        }
        catch (error) {
            (0, utils_1.log)(`Error saving coin data batch: ${error}`, 'ERROR');
            throw error;
        }
    }
    /**
     * Получить данные токена из coin_data
     */
    async getCoinData(coinId, network = 'Solana') {
        try {
            const res = await this.pool.query(`
        SELECT * FROM coin_data 
        WHERE coin_id = $1 AND network = $2
        ORDER BY timestamp DESC
        LIMIT 1
      `, [coinId, network]);
            return res.rows[0] || null;
        }
        catch (error) {
            (0, utils_1.log)(`Error getting coin data: ${error}`, 'ERROR');
            return null;
        }
    }
    /**
     * Получить все свежие токены из coin_data (не старше 24 часов)
     */
    async getFreshTokensFromCoinData(network = 'Solana', maxAgeHours = 24) {
        try {
            const res = await this.pool.query(`
        SELECT coin_id, mint, symbol, name, network, price, volume, market_cap, fdv, timestamp 
        FROM coin_data 
        WHERE network = $1 
        AND timestamp > NOW() - INTERVAL '${maxAgeHours} hours'
        ORDER BY volume DESC
      `, [network]);
            (0, utils_1.log)(`📊 Found ${res.rows.length} fresh tokens in coin_data (last ${maxAgeHours} hours)`);
            return res.rows;
        }
        catch (error) {
            (0, utils_1.log)(`Error getting fresh tokens from coin_data: ${error}`, 'ERROR');
            return [];
        }
    }
    /**
     * Проверить, есть ли достаточно свежих токенов в базе
     */
    async hasFreshTokens(network = 'Solana', minCount = 500, maxAgeHours = 24) {
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
            (0, utils_1.log)(`🔍 Database check: ${count} fresh tokens with real mint addresses found (need ${minCount})`);
            return count >= minCount;
        }
        catch (error) {
            (0, utils_1.log)(`Error checking fresh tokens: ${error}`, 'ERROR');
            return false;
        }
    }
    /**
     * Очистить старые данные из coin_data (старше 48 часов)
     */
    async cleanupOldCoinData(maxAgeHours = 48) {
        try {
            const res = await this.pool.query(`
        DELETE FROM coin_data 
        WHERE timestamp < NOW() - INTERVAL '${maxAgeHours} hours'
      `);
            const deletedCount = res.rowCount || 0;
            if (deletedCount > 0) {
                (0, utils_1.log)(`🧹 Cleaned up ${deletedCount} old coin_data records (older than ${maxAgeHours} hours)`);
            }
            else {
                (0, utils_1.log)(`🧹 No old coin_data records to clean up`);
            }
        }
        catch (error) {
            (0, utils_1.log)(`Error cleaning up old coin_data: ${error}`, 'ERROR');
        }
    }
    /**
     * Получить информацию о пуле
     */
    async getPool(mint) {
        try {
            (0, utils_1.log)(`🔍 Getting pool info for mint: ${mint}`);
            const sql = 'SELECT * FROM pools WHERE mint = $1';
            (0, utils_1.log)(`📋 SQL: ${sql} with params: [${mint}]`);
            const res = await this.pool.query(sql, [mint]);
            (0, utils_1.log)(`📋 getPool returned ${res.rows.length} rows`);
            if (res.rows.length > 0) {
                (0, utils_1.log)(`📋 Pool data: ${JSON.stringify(res.rows[0])}`);
            }
            return res.rows[0] || null;
        }
        catch (error) {
            (0, utils_1.log)(`❌ Error in getPool: ${error}`, 'ERROR');
            (0, utils_1.log)(`❌ Error stack: ${error instanceof Error ? error.stack : 'No stack'}`, 'ERROR');
            throw error;
        }
    }
    /**
     * Получить все известные минты (старше 14 дней)
     */
    async getOldPools() {
        const fourteenDaysAgo = Math.floor(Date.now() / 1000) - (14 * 24 * 60 * 60);
        const res = await this.pool.query('SELECT * FROM pools WHERE first_seen_ts <= $1', [fourteenDaysAgo]);
        return res.rows;
    }
    /**
     * Добавить/обновить OHLCV данные
     */
    async ingestSwap(mint, price, volUsd, tsSec) {
        const bucket = (0, utils_1.bucketTs)(tsSec);
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
    async updateOHLCV(mint, price, volumeUsd, timestamp) {
        return this.ingestSwap(mint, price, volumeUsd, timestamp);
    }
    /**
     * Получить последние свечи для расчета индикаторов
     */
    async getCandles(mint, limit = 40) {
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
    async getOHLCV(mint, limit = 40) {
        return this.getCandles(mint, limit);
    }
    /**
     * Создать сигнал
     */
    async createSignal(mint, symbol, emaCross, volSpike, rsi, priceChange, volume24h, marketCap, reasons) {
        try {
            (0, utils_1.log)(`🔍 Creating signal for ${symbol} (${mint})`);
            const currentTimestamp = Math.floor(Date.now() / 1000);
            const sql = `
        INSERT INTO signals(
          mint, symbol, signal_ts, signal_datetime, ema_cross, vol_spike, rsi, 
          price_change, volume_24h, market_cap, reasons, notified, created_at
        )
        VALUES($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9, $10, false, NOW())
      `;
            (0, utils_1.log)(`📋 Creating signal: ${symbol} - ${reasons}`);
            await this.pool.query(sql, [
                mint, symbol, currentTimestamp, emaCross, volSpike, rsi,
                priceChange, volume24h, marketCap, reasons
            ]);
            (0, utils_1.log)(`✅ Successfully created signal for ${symbol}`);
        }
        catch (error) {
            (0, utils_1.log)(`❌ Error in createSignal: ${error}`, 'ERROR');
            throw error;
        }
    }
    /**
     * Получить неотправленные сигналы
     */
    async getUnnotifiedSignals() {
        try {
            (0, utils_1.log)('🔍 Executing getUnnotifiedSignals query...');
            const sql = `
        SELECT id, mint, signal_ts, ema_cross, vol_spike, rsi, notified
        FROM signals 
        WHERE notified = false
        ORDER BY signal_ts ASC
      `;
            (0, utils_1.log)(`📋 SQL: ${sql}`);
            const res = await this.pool.query(sql);
            (0, utils_1.log)(`📋 getUnnotifiedSignals returned ${res.rows.length} rows`);
            if (res.rows.length > 0) {
                (0, utils_1.log)(`📋 First signal: ${JSON.stringify(res.rows[0])}`);
            }
            return res.rows;
        }
        catch (error) {
            (0, utils_1.log)(`❌ Error in getUnnotifiedSignals: ${error}`, 'ERROR');
            (0, utils_1.log)(`❌ Error stack: ${error instanceof Error ? error.stack : 'No stack'}`, 'ERROR');
            throw error;
        }
    }
    /**
     * Отметить сигнал как отправленный
     */
    async markSignalNotified(signalId) {
        try {
            (0, utils_1.log)(`🔍 Marking signal ${signalId} as notified...`);
            const sql = 'UPDATE signals SET notified = true WHERE id = $1';
            (0, utils_1.log)(`📋 SQL: ${sql} with params: [${signalId}]`);
            await this.pool.query(sql, [signalId]);
            (0, utils_1.log)(`✅ Successfully marked signal ${signalId} as notified`);
        }
        catch (error) {
            (0, utils_1.log)(`❌ Error in markSignalNotified: ${error}`, 'ERROR');
            (0, utils_1.log)(`❌ Error stack: ${error instanceof Error ? error.stack : 'No stack'}`, 'ERROR');
            throw error;
        }
    }
    /**
     * Очистка старых данных
     */
    async cleanup() {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        // Удаляем старые OHLCV данные (старше 24 часов)
        const oneDayAgoTs = Math.floor(oneDayAgo.getTime() / 1000);
        await this.pool.query('DELETE FROM ohlcv WHERE ts < $1', [oneDayAgoTs]);
        // Удаляем старые сигналы (старше 24 часов) - используем signal_ts, а не created_at
        await this.pool.query('DELETE FROM signals WHERE signal_ts < $1', [oneDayAgoTs]);
        (0, utils_1.log)('Database cleanup completed');
    }
    /**
     * Закрыть соединения
     */
    async close() {
        await this.pool.end();
    }
}
exports.Database = Database;
