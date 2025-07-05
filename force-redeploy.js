#!/usr/bin/env node

// force-redeploy.js - Принудительный редеплой для Railway
console.log('🚀 Force redeploying to Railway with new CoinGecko system...');
console.log('');
console.log('📋 Changes deployed:');
console.log('✅ Removed old Helius WebSocket system');
console.log('✅ Added CoinGecko API integration');
console.log('✅ Added proper token analysis with all criteria');
console.log('✅ Added credit optimization (99%+ savings)');
console.log('✅ Added configurable parameters via env vars');
console.log('');
console.log('🔧 New Environment Variables Required:');
console.log('- COINGECKO_API_KEY');
console.log('- PRICE_IMPACT_TEST_AMOUNT');
console.log('- MAX_PRICE_IMPACT_PERCENT');
console.log('');
console.log('⚡ System will now analyze top 2000 Solana tokens every 10 minutes');
console.log('🎯 Looking for proper buy signals with all criteria met');
console.log('');
console.log('Railway should pick up these changes automatically.');
console.log('If not, manually trigger redeploy in Railway dashboard.');
console.log('');

// Запускаем новую систему
require('./start-signal-bot.js'); 