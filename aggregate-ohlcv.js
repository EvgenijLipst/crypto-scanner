require('dotenv').config();
const { Database } = require('./src/database');

async function main() {
  try {
    const db = new Database(process.env.DATABASE_URL);
    await db.initialize();
    await db.aggregateOhlcvTo1h(7); // агрегировать 1m в 1h для данных старше 7 дней
    await db.cleanupOldOhlcv(30);   // удалить 1m свечи старше 30 дней
    await db.close();
    console.log('✅ OHLCV aggregation and cleanup complete!');
  } catch (e) {
    console.error('❌ Error in OHLCV aggregation/cleanup:', e);
    process.exit(1);
  }
}

main(); 