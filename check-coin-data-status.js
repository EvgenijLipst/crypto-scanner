#!/usr/bin/env node

// Скрипт для проверки состояния таблицы coin_data
require('ts-node').register({
  project: './tsconfig.json'
});

const { Database } = require('./src/database');

async function checkCoinDataStatus() {
  try {
    console.log('🔍 Checking coin_data table status...');
    
    // Проверяем переменные окружения
    if (!process.env.DATABASE_URL) {
      console.error('❌ DATABASE_URL environment variable is missing');
      process.exit(1);
    }
    
    // Инициализируем базу данных
    const db = new Database(process.env.DATABASE_URL);
    await db.initialize();
    console.log('✅ Database connected');
    
    // 1. Общее количество записей
    console.log('\n📊 General Statistics:');
    const totalCount = await db.pool.query('SELECT COUNT(*) as count FROM coin_data');
    console.log(`• Total records: ${totalCount.rows[0].count}`);
    
    // 2. Записи за последние 24 часа
    const recentCount = await db.pool.query(`
      SELECT COUNT(*) as count 
      FROM coin_data 
      WHERE timestamp > NOW() - INTERVAL '24 hours'
    `);
    console.log(`• Records in last 24h: ${recentCount.rows[0].count}`);
    
    // 3. Записи за последний час
    const hourlyCount = await db.pool.query(`
      SELECT COUNT(*) as count 
      FROM coin_data 
      WHERE timestamp > NOW() - INTERVAL '1 hour'
    `);
    console.log(`• Records in last 1h: ${hourlyCount.rows[0].count}`);
    
    // 4. Последние 10 записей
    console.log('\n📋 Latest 10 records:');
    const latestRecords = await db.pool.query(`
      SELECT coin_id, symbol, name, mint, price, volume, market_cap, timestamp 
      FROM coin_data 
      ORDER BY timestamp DESC 
      LIMIT 10
    `);
    
    latestRecords.rows.forEach((record, i) => {
      const timeAgo = new Date(record.timestamp).toLocaleString();
      console.log(`${i + 1}. ${record.symbol} (${record.coin_id})`);
      console.log(`   Mint: ${record.mint}`);
      console.log(`   Price: $${record.price}`);
      console.log(`   Volume: $${record.volume?.toLocaleString() || 'N/A'}`);
      console.log(`   Market Cap: $${record.market_cap?.toLocaleString() || 'N/A'}`);
      console.log(`   Time: ${timeAgo}`);
      console.log('');
    });
    
    // 5. Проверка дубликатов
    console.log('🔍 Duplicate Check:');
    const duplicates = await db.pool.query(`
      SELECT coin_id, network, COUNT(*) as count
      FROM coin_data 
      GROUP BY coin_id, network 
      HAVING COUNT(*) > 1
      ORDER BY count DESC
      LIMIT 5
    `);
    
    if (duplicates.rows.length > 0) {
      console.log('⚠️ Found duplicate records:');
      duplicates.rows.forEach(row => {
        console.log(`• ${row.coin_id} (${row.network}): ${row.count} records`);
      });
    } else {
      console.log('✅ No duplicate records found');
    }
    
    // 6. Статистика по сетям
    console.log('\n🌐 Network Statistics:');
    const networkStats = await db.pool.query(`
      SELECT network, COUNT(*) as count
      FROM coin_data 
      GROUP BY network
      ORDER BY count DESC
    `);
    
    networkStats.rows.forEach(row => {
      console.log(`• ${row.network}: ${row.count} records`);
    });
    
    // 7. Статистика по времени
    console.log('\n⏰ Time Distribution:');
    const timeStats = await db.pool.query(`
      SELECT 
        DATE(timestamp) as date,
        COUNT(*) as count
      FROM coin_data 
      WHERE timestamp > NOW() - INTERVAL '7 days'
      GROUP BY DATE(timestamp)
      ORDER BY date DESC
      LIMIT 7
    `);
    
    timeStats.rows.forEach(row => {
      console.log(`• ${row.date}: ${row.count} records`);
    });
    
    // 8. Проверка структуры таблицы
    console.log('\n🏗️ Table Structure:');
    const tableInfo = await db.pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_name = 'coin_data'
      ORDER BY ordinal_position
    `);
    
    tableInfo.rows.forEach(row => {
      console.log(`• ${row.column_name}: ${row.data_type} (${row.is_nullable === 'YES' ? 'nullable' : 'not null'})`);
    });
    
    // 9. Проверка индексов
    console.log('\n📈 Indexes:');
    const indexes = await db.pool.query(`
      SELECT indexname, indexdef
      FROM pg_indexes 
      WHERE tablename = 'coin_data'
    `);
    
    indexes.rows.forEach(row => {
      console.log(`• ${row.indexname}`);
    });
    
    // 10. Проверка ограничений
    console.log('\n🔒 Constraints:');
    const constraints = await db.pool.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) as definition
      FROM pg_constraint 
      WHERE conrelid = 'coin_data'::regclass
    `);
    
    constraints.rows.forEach(row => {
      console.log(`• ${row.conname} (${row.contype}): ${row.definition}`);
    });
    
    console.log('\n✅ Status check completed!');
    
  } catch (error) {
    console.error('❌ Status check failed:', error);
    if (error instanceof Error) {
      console.error('❌ Error details:', error.message);
      console.error('❌ Error stack:', error.stack);
    }
  } finally {
    process.exit(0);
  }
}

// Запускаем проверку статуса
checkCoinDataStatus(); 