const DatabaseMonitor = require('./monitor-database');

async function quickTest() {
    console.log('🔍 Быстрая проверка базы данных...\n');
    
    const monitor = new DatabaseMonitor();
    
    try {
        await monitor.connect();
        
        // Проверяем основные таблицы
        const queries = [
            { name: 'Пулы', query: 'SELECT COUNT(*) as count FROM pools' },
            { name: 'OHLCV', query: 'SELECT COUNT(*) as count FROM ohlcv' },
            { name: 'Данные монет', query: 'SELECT COUNT(*) as count FROM coin_data' },
            { name: 'Последняя OHLCV запись', query: 'SELECT mint, ts, v FROM ohlcv ORDER BY ts DESC LIMIT 1' },
        ];
        
        for (const { name, query } of queries) {
            try {
                const result = await monitor.executeQuery(query);
                console.log(`✅ ${name}:`, result);
            } catch (error) {
                console.log(`❌ ${name}: ${error.message}`);
            }
        }
        
        // Проверяем структуру таблиц
        console.log('\n📋 Структура таблицы pools:');
        const poolsStructure = await monitor.executeQuery(`
            SELECT column_name, data_type, is_nullable 
            FROM information_schema.columns 
            WHERE table_name = 'pools'
        `);
        console.table(poolsStructure);
        
    } catch (error) {
        console.error('❌ Ошибка:', error.message);
    } finally {
        await monitor.disconnect();
    }
}

quickTest(); 