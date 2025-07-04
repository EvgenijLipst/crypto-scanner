const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/crypto_scanner';

const pool = new Pool({ 
  connectionString: DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

async function checkTrades() {
  try {
    console.log('🔍 Checking trade positions...\n');
    
    // Проверяем все позиции
    const allTrades = await pool.query(`
      SELECT id, mint, buy_tx, sell_tx, bought_amount, spent_usdc, received_usdc, created_at, closed_at
      FROM trades 
      ORDER BY created_at DESC
    `);
    
    console.log(`📊 Total trades in database: ${allTrades.rows.length}`);
    
    // Открытые позиции
    const openTrades = await pool.query(`
      SELECT id, mint, buy_tx, bought_amount, spent_usdc, created_at
      FROM trades 
      WHERE closed_at IS NULL 
      ORDER BY created_at ASC
    `);
    
    console.log(`🟢 Open positions: ${openTrades.rows.length}`);
    
    if (openTrades.rows.length > 0) {
      console.log('\n--- OPEN POSITIONS ---');
      openTrades.rows.forEach((trade, index) => {
        const createdAt = new Date(trade.created_at);
        const hoursAgo = ((Date.now() - createdAt.getTime()) / (1000 * 60 * 60)).toFixed(1);
        
        console.log(`${index + 1}. Trade ID: ${trade.id}`);
        console.log(`   Token: ${trade.mint}`);
        console.log(`   Amount: ${trade.bought_amount} tokens`);
        console.log(`   Spent: $${trade.spent_usdc} USDC`);
        console.log(`   Buy TX: ${trade.buy_tx}`);
        console.log(`   Created: ${createdAt.toISOString()} (${hoursAgo}h ago)`);
        console.log('');
      });
    }
    
    // Закрытые позиции
    const closedTrades = await pool.query(`
      SELECT id, mint, buy_tx, sell_tx, bought_amount, spent_usdc, received_usdc, created_at, closed_at
      FROM trades 
      WHERE closed_at IS NOT NULL 
      ORDER BY closed_at DESC
      LIMIT 5
    `);
    
    console.log(`🔴 Closed positions: ${closedTrades.rows.length} (showing last 5)`);
    
    if (closedTrades.rows.length > 0) {
      console.log('\n--- RECENT CLOSED POSITIONS ---');
      closedTrades.rows.forEach((trade, index) => {
        const createdAt = new Date(trade.created_at);
        const closedAt = new Date(trade.closed_at);
        const holdingTime = ((closedAt.getTime() - createdAt.getTime()) / (1000 * 60 * 60)).toFixed(1);
        
        const pnl = trade.received_usdc ? 
          ((trade.received_usdc - trade.spent_usdc) / trade.spent_usdc * 100).toFixed(2) : 
          'N/A';
        
        console.log(`${index + 1}. Trade ID: ${trade.id}`);
        console.log(`   Token: ${trade.mint}`);
        console.log(`   Amount: ${trade.bought_amount} tokens`);
        console.log(`   Spent: $${trade.spent_usdc} USDC`);
        console.log(`   Received: $${trade.received_usdc || 'N/A'} USDC`);
        console.log(`   P&L: ${pnl}%`);
        console.log(`   Holding time: ${holdingTime}h`);
        console.log(`   Buy TX: ${trade.buy_tx}`);
        console.log(`   Sell TX: ${trade.sell_tx || 'N/A'}`);
        console.log(`   Closed: ${closedAt.toISOString()}`);
        console.log('');
      });
    }
    
    // Проверяем последние сигналы
    const recentSignals = await pool.query(`
      SELECT mint, signal_ts, ema_cross, vol_spike, rsi, notified
      FROM signals 
      WHERE signal_ts > ${Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000)}
      ORDER BY signal_ts DESC
      LIMIT 10
    `);
    
    console.log(`📡 Recent signals (last 24h): ${recentSignals.rows.length}`);
    
    if (recentSignals.rows.length > 0) {
      console.log('\n--- RECENT SIGNALS ---');
      recentSignals.rows.forEach((signal, index) => {
        const signalTime = new Date(signal.signal_ts * 1000);
        const hoursAgo = ((Date.now() - signalTime.getTime()) / (1000 * 60 * 60)).toFixed(1);
        
        console.log(`${index + 1}. Token: ${signal.mint}`);
        console.log(`   Time: ${signalTime.toISOString()} (${hoursAgo}h ago)`);
        console.log(`   EMA Cross: ${signal.ema_cross ? '✅' : '❌'}`);
        console.log(`   Volume Spike: ${signal.vol_spike}x`);
        console.log(`   RSI: ${signal.rsi}`);
        console.log(`   Notified: ${signal.notified ? '✅' : '❌'}`);
        console.log('');
      });
    }
    
  } catch (error) {
    console.error('❌ Error checking trades:', error.message);
  } finally {
    await pool.end();
  }
}

checkTrades()
  .then(() => {
    console.log('✅ Trade check completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('💥 Check failed:', error);
    process.exit(1);
  }); 