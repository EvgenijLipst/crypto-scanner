#!/usr/bin/env node

// Утилита для чтения логов Telegram сообщений
// Использование: node read-telegram-logs.js [количество_строк]

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'telegram.log');
const DEFAULT_LINES = 20;

function readTelegramLogs(limit = DEFAULT_LINES) {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      console.log('❌ Лог файл telegram.log не найден');
      return;
    }
    
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    
    if (lines.length === 0) {
      console.log('📝 Лог файл пустой');
      return;
    }
    
    console.log(`📋 Показываю последние ${Math.min(limit, lines.length)} записей из ${lines.length} всего:\n`);
    
    const recentLines = lines.slice(-limit);
    recentLines.forEach((line, index) => {
      // Форматируем вывод для лучшей читаемости
      const parts = line.match(/^\[([^\]]+)\] \[([^\]]+)\] (.+)$/);
      if (parts) {
        const [, timestamp, status, message] = parts;
        const statusIcon = status === 'SENT' ? '✅' : '❌';
        const time = new Date(timestamp).toLocaleTimeString();
        
        console.log(`${statusIcon} [${time}] ${status}`);
        console.log(`   ${message.substring(0, 200)}${message.length > 200 ? '...' : ''}`);
        console.log('');
      } else {
        console.log(line);
      }
    });
    
  } catch (error) {
    console.error('❌ Ошибка чтения лог файла:', error.message);
  }
}

// Параметры командной строки
const args = process.argv.slice(2);
const lines = args[0] ? parseInt(args[0]) : DEFAULT_LINES;

if (isNaN(lines) || lines <= 0) {
  console.error('❌ Неверное количество строк. Используйте положительное число.');
  process.exit(1);
}

readTelegramLogs(lines); 