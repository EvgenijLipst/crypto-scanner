// fix-database-constraints.js - Исправление ограничений и индексов в базе данных
const { Pool } = require('pg');
require('dotenv').config();

async function fixDatabaseConstraints() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    console.log('🔧 Fixing database constraints and indexes...');
    
    // 1. Добавляем уникальное ограничение (если его нет)
    try {
      await pool.query(`
        ALTER TABLE coin_data 
        ADD CONSTRAINT coin_data_coin_network_uidx 
        UNIQUE (coin_id, network)
      `);
      console.log('✅ Added unique constraint coin_data_coin_network_uidx');
    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('✅ Unique constraint coin_data_coin_network_uidx already exists');
      } else {
        console.log(`⚠️ Error adding unique constraint: ${error.message}`);
      }
    }
    
    // 2. Удаляем неправильный индекс (если существует)
    try {
      await pool.query(`DROP INDEX IF EXISTS idx_coin_data_updated_at`);
      console.log('✅ Removed incorrect index idx_coin_data_updated_at');
    } catch (error) {
      console.log(`⚠️ Error removing index: ${error.message}`);
    }
    
    // 3. Добавляем правильные индексы
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_coin_data_network_timestamp 
        ON coin_data (network, timestamp DESC)
      `);
      console.log('✅ Added index idx_coin_data_network_timestamp');
    } catch (error) {
      console.log(`⚠️ Error adding network+timestamp index: ${error.message}`);
    }
    
    try {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_coin_data_timestamp 
        ON coin_data (timestamp DESC)
      `);
      console.log('✅ Added index idx_coin_data_timestamp');
    } catch (error) {
      console.log(`⚠️ Error adding timestamp index: ${error.message}`);
    }
    
    // 4. Проверяем текущее состояние таблицы
    const countResult = await pool.query(`
      SELECT COUNT(*) as count FROM coin_data WHERE network = 'Solana'
    `);
    console.log(`📊 Current tokens in database: ${countResult.rows[0].count}`);
    
    // 5. Проверяем свежие токены
    const freshResult = await pool.query(`
      SELECT COUNT(*) as count FROM coin_data 
      WHERE network = 'Solana' 
      AND timestamp > NOW() - INTERVAL '48 hours'
    `);
    console.log(`📊 Fresh tokens (last 48h): ${freshResult.rows[0].count}`);
    
    // 6. Показываем последние несколько записей
    const recentResult = await pool.query(`
      SELECT coin_id, symbol, name, timestamp 
      FROM coin_data 
      WHERE network = 'Solana' 
      ORDER BY timestamp DESC 
      LIMIT 5
    `);
    
    console.log('\n📋 Recent tokens:');
    recentResult.rows.forEach((row, i) => {
      console.log(`${i + 1}. ${row.symbol} (${row.coin_id}) - ${row.timestamp}`);
    });
    
    console.log('\n✅ Database constraints and indexes fixed successfully!');
    
  } catch (error) {
    console.error('❌ Error fixing database:', error);
  } finally {
    await pool.end();
  }
}

// Запуск исправления
fixDatabaseConstraints().catch(console.error); 