console.log('=== TESTING DATABASE CONNECTION ===');

const { Pool } = require('pg');
require('dotenv').config();

async function testDatabaseConnection() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    console.log('🔄 Attempting to connect to database...');
    console.log('📋 Connection string:', process.env.DATABASE_URL ? 'Present' : 'Missing');
    
    const client = await pool.connect();
    console.log('✅ Database connection successful!');
    
    // Test a simple query
    const result = await client.query('SELECT NOW() as current_time');
    console.log('📊 Current database time:', result.rows[0].current_time);
    
    // Check if coin_data table exists
    const tableResult = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'coin_data'
      );
    `);
    
    console.log('📋 coin_data table exists:', tableResult.rows[0].exists);
    
    if (tableResult.rows[0].exists) {
      // Count rows in coin_data
      const countResult = await client.query('SELECT COUNT(*) as count FROM coin_data');
      console.log('📊 Total rows in coin_data:', countResult.rows[0].count);
      
      // Show table structure
      const structureResult = await client.query(`
        SELECT column_name, data_type, is_nullable 
        FROM information_schema.columns 
        WHERE table_name = 'coin_data' 
        ORDER BY ordinal_position;
      `);
      
      console.log('📋 coin_data table structure:');
      structureResult.rows.forEach(row => {
        console.log(`  • ${row.column_name}: ${row.data_type} (nullable: ${row.is_nullable})`);
      });
    }
    
    client.release();
    console.log('✅ Database test completed successfully!');
    
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    console.error('❌ Error details:', error);
  } finally {
    await pool.end();
  }
}

testDatabaseConnection().then(() => {
  console.log('\n=== DATABASE TEST COMPLETED ===');
  process.exit(0);
}).catch(error => {
  console.error('\n=== DATABASE TEST FAILED ===');
  console.error(error);
  process.exit(1);
}); 