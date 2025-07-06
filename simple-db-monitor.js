const { Client } = require('pg');
require('dotenv').config();

async function getStats() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    });

    try {
        await client.connect();
        
        const poolsResult = await client.query('SELECT COUNT(*) FROM pools');
        const ohlcvResult = await client.query('SELECT COUNT(*) FROM ohlcv');
        const coinDataResult = await client.query('SELECT COUNT(*) FROM coin_data');
        
        const poolsCount = parseInt(poolsResult.rows[0].count);
        const ohlcvCount = parseInt(ohlcvResult.rows[0].count);
        const coinDataCount = parseInt(coinDataResult.rows[0].count);
        
        console.log(`📊 [${new Date().toLocaleString()}] Pools: ${poolsCount}, OHLCV: ${ohlcvCount}, Coin Data: ${coinDataCount}`);
        
        return { poolsCount, ohlcvCount, coinDataCount };
    } catch (error) {
        console.error('❌ Ошибка при получении статистики:', error.message);
        return null;
    } finally {
        await client.end();
    }
}

async function monitorDatabase() {
    console.log('🔍 Запуск мониторинга базы данных...');
    
    // Получаем статистику сразу
    await getStats();
    
    // Затем каждые 30 секунд
    setInterval(async () => {
        await getStats();
    }, 30000);
}

monitorDatabase().catch(console.error); 