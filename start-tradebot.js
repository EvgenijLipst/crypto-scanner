const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting Tradebot...');

const tradebotPath = path.join(__dirname, 'tradebot', 'tradebot.js');
const tradebot = spawn('node', [tradebotPath], {
  stdio: 'inherit',
  cwd: __dirname
});

tradebot.on('error', (error) => {
  console.error('❌ Failed to start tradebot:', error);
  process.exit(1);
});

tradebot.on('close', (code) => {
  console.log(`🛑 Tradebot exited with code ${code}`);
  process.exit(code);
});

// Обработка сигналов завершения
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, stopping tradebot...');
  tradebot.kill('SIGINT');
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM, stopping tradebot...');
  tradebot.kill('SIGTERM');
}); 