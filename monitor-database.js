const { Client } = require('pg');

const DATABASE_URL = 'postgresql://postgres:dTtyTrvuMamPWfoukDRNAlUAvghvlODD@mainline.proxy.rlwy.net:17147/railway';

class DatabaseMonitor {
    constructor() {
        this.client = new Client({
            connectionString: DATABASE_URL,
            ssl: {
                rejectUnauthorized: false
            }
        });
        this.isConnected = false;
    }

    async connect() {
        try {
            if (!this.isConnected) {
                await this.client.connect();
                this.isConnected = true;
                console.log('✅ Подключен к базе данных');
            }
        } catch (error) {
            console.error('❌ Ошибка подключения:', error.message);
            throw error;
        }
    }

    async disconnect() {
        if (this.isConnected) {
            await this.client.end();
            this.isConnected = false;
            console.log('🔌 Отключен от базы данных');
        }
    }

    async getPoolsCount() {
        const result = await this.client.query('SELECT COUNT(*) as count FROM pools');
        return parseInt(result.rows[0].count);
    }

    async getLatestPools(limit = 10) {
        const result = await this.client.query(`
            SELECT mint, first_seen_ts, liq_usd, fdv_usd 
            FROM pools 
            ORDER BY first_seen_ts DESC 
            LIMIT $1
        `, [limit]);
        return result.rows;
    }

    async getOHLCVCount() {
        const result = await this.client.query('SELECT COUNT(*) as count FROM ohlcv');
        return parseInt(result.rows[0].count);
    }

    async getLatestOHLCV(limit = 5) {
        const result = await this.client.query(`
            SELECT mint, ts, o, h, l, c, v 
            FROM ohlcv 
            ORDER BY ts DESC 
            LIMIT $1
        `, [limit]);
        return result.rows;
    }

    async getCoinDataCount() {
        const result = await this.client.query('SELECT COUNT(*) as count FROM coin_data');
        return parseInt(result.rows[0].count);
    }

    async getTableSizes() {
        const result = await this.client.query(`
            SELECT 
                schemaname,
                tablename,
                attname,
                n_distinct,
                correlation
            FROM pg_stats 
            WHERE schemaname = 'public'
            ORDER BY tablename, attname;
        `);
        return result.rows;
    }

    async showStats() {
        try {
            const poolsCount = await this.getPoolsCount();
            const ohlcvCount = await this.getOHLCVCount();
            const coinDataCount = await this.getCoinDataCount();

            console.clear();
            console.log('🔍 МОНИТОРИНГ БАЗЫ ДАННЫХ');
            console.log('========================');
            console.log(`📊 Пулы: ${poolsCount}`);
            console.log(`📈 OHLCV записи: ${ohlcvCount}`);
            console.log(`🪙 Данные монет: ${coinDataCount}`);
            console.log(`⏰ Время: ${new Date().toLocaleString('ru-RU')}`);
            console.log('');

            if (poolsCount > 0) {
                console.log('🏊 ПОСЛЕДНИЕ ПУЛЫ:');
                const latestPools = await this.getLatestPools(5);
                latestPools.forEach(pool => {
                    console.log(`  ${pool.mint} | ${new Date(pool.first_seen_ts).toLocaleString('ru-RU')} | $${pool.liq_usd} | FDV: $${pool.fdv_usd}`);
                });
                console.log('');
            }

            console.log('📈 ПОСЛЕДНИЕ OHLCV:');
            const latestOHLCV = await this.getLatestOHLCV(3);
            latestOHLCV.forEach(candle => {
                console.log(`  ${candle.mint.substring(0, 8)}... | ${new Date(parseInt(candle.ts) * 1000).toLocaleString('ru-RU')} | O:${candle.o} H:${candle.h} L:${candle.l} C:${candle.c} V:${candle.v}`);
            });

        } catch (error) {
            console.error('❌ Ошибка при получении статистики:', error.message);
            // Помечаем соединение как закрытое при ошибке
            this.isConnected = false;
        }
    }

    async startMonitoring(intervalSeconds = 10) {
        console.log(`🚀 Запуск мониторинга (обновление каждые ${intervalSeconds} секунд)`);
        console.log('Нажмите Ctrl+C для остановки\n');

        await this.showStats();

        const interval = setInterval(async () => {
            // Переподключаемся если соединение закрыто
            if (!this.isConnected) {
                try {
                    // Создаем новый клиент для переподключения
                    this.client = new Client({
                        connectionString: DATABASE_URL,
                        ssl: {
                            rejectUnauthorized: false
                        }
                    });
                    await this.connect();
                } catch (error) {
                    console.error('❌ Ошибка переподключения:', error.message);
                    return;
                }
            }
            await this.showStats();
        }, intervalSeconds * 1000);

        // Обработка завершения
        process.on('SIGINT', async () => {
            console.log('\n🛑 Остановка мониторинга...');
            clearInterval(interval);
            await this.disconnect();
            process.exit(0);
        });
    }

    // Выполнить произвольный SQL запрос
    async executeQuery(query) {
        try {
            const result = await this.client.query(query);
            return result.rows;
        } catch (error) {
            console.error('❌ Ошибка выполнения запроса:', error.message);
            throw error;
        }
    }
}

// Использование
async function main() {
    const monitor = new DatabaseMonitor();
    
    try {
        await monitor.connect();
        
        // Получить аргументы командной строки
        const args = process.argv.slice(2);
        
        if (args.length > 0) {
            const command = args[0];
            
            switch (command) {
                case 'stats':
                    await monitor.showStats();
                    break;
                case 'monitor':
                    const interval = args[1] ? parseInt(args[1]) : 10;
                    await monitor.startMonitoring(interval);
                    break;
                case 'pools':
                    const pools = await monitor.getLatestPools(20);
                    console.log('🏊 ВСЕ ПУЛЫ:');
                    pools.forEach(pool => {
                        console.log(`${pool.mint} | ${new Date(pool.first_seen_ts).toLocaleString('ru-RU')} | Liq: $${pool.liq_usd} | FDV: $${pool.fdv_usd}`);
                    });
                    break;
                case 'query':
                    if (args[1]) {
                        const result = await monitor.executeQuery(args[1]);
                        console.table(result);
                    } else {
                        console.log('❌ Укажите SQL запрос после команды query');
                    }
                    break;
                default:
                    console.log('Доступные команды:');
                    console.log('  stats - показать статистику');
                    console.log('  monitor [секунды] - запустить мониторинг');
                    console.log('  pools - показать все пулы');
                    console.log('  query "SQL запрос" - выполнить произвольный запрос');
            }
        } else {
            // По умолчанию запускаем мониторинг
            await monitor.startMonitoring();
        }
        
    } catch (error) {
        console.error('❌ Критическая ошибка:', error.message);
    } finally {
        await monitor.disconnect();
    }
}

if (require.main === module) {
    main();
}

module.exports = DatabaseMonitor; 