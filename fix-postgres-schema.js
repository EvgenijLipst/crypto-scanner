const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Загружаем переменные окружения
require('dotenv').config();

async function fixPostgresSchema() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
  });

  try {
    console.log('🔄 Connecting to database...');
    await pool.connect();
    console.log('✅ Database connected');

    // Читаем обновленную схему
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    console.log('🔄 Applying schema updates...');
    
    // Применяем схему (IF NOT EXISTS предотвратит ошибки)
    await pool.query(schema);
    
    console.log('✅ Schema applied successfully');

    // Проверяем существование всех таблиц
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log('📊 Existing tables:');
    result.rows.forEach(row => {
      console.log(`  - ${row.table_name}`);
    });

    // Проверяем coin_data таблицу специально
    const coinDataCheck = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'coin_data' 
      ORDER BY ordinal_position;
    `);

    if (coinDataCheck.rows.length > 0) {
      console.log('✅ coin_data table structure:');
      coinDataCheck.rows.forEach(row => {
        console.log(`  - ${row.column_name}: ${row.data_type}`);
      });
    } else {
      console.log('❌ coin_data table not found');
    }

    // Очищаем старые данные если есть
    console.log('🧹 Cleaning up old data...');
    await pool.query(`DELETE FROM coin_data WHERE updated_at < NOW() - INTERVAL '2 days';`);
    
    console.log('✅ Database schema fix completed successfully');

  } catch (error) {
    console.error('❌ Error fixing database schema:', error);
    
    // Дополнительная диагностика
    if (error.message.includes('already exists')) {
      console.log('ℹ️  This error is expected if constraints already exist');
      console.log('✅ Schema is likely already up to date');
    }
  } finally {
    await pool.end();
  }
}

// Запускаем исправление
fixPostgresSchema().catch(console.error); 