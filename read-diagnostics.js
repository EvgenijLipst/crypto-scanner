#!/usr/bin/env node

// Утилита для чтения диагностических логов
// Использование: node read-diagnostics.js [количество_записей]

const fs = require('fs');
const path = require('path');

const DIAGNOSTICS_LOG = path.join(__dirname, 'diagnostics.log');
const TELEGRAM_LOG = path.join(__dirname, 'telegram.log');
const DEFAULT_ENTRIES = 10;

function readDiagnosticsLogs(limit = DEFAULT_ENTRIES) {
  console.log('🔧 === SYSTEM DIAGNOSTICS REPORT === 🔧\n');
  
  // Читаем диагностические логи
  if (fs.existsSync(DIAGNOSTICS_LOG)) {
    try {
      const content = fs.readFileSync(DIAGNOSTICS_LOG, 'utf8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      
      if (lines.length > 0) {
        console.log(`📊 Последние ${Math.min(limit, lines.length)} диагностических записей:\n`);
        
        const recentLines = lines.slice(-limit);
        recentLines.forEach((line, index) => {
          try {
            const entry = JSON.parse(line);
            const statusIcon = entry.status === 'HEALTHY' ? '🟢' : 
                             entry.status === 'WARNING' ? '🟡' : '🔴';
            
            console.log(`${statusIcon} [${new Date(entry.timestamp).toLocaleString()}] ${entry.status}`);
            console.log(`   📊 Issues: ${entry.issuesCount} | Errors: ${entry.metrics?.telegramErrors || 0}`);
            
            if (entry.issues && entry.issues.length > 0) {
              console.log('   🔍 Issues:');
              entry.issues.forEach(issue => {
                const severityIcon = issue.severity === 'CRITICAL' ? '🚨' :
                                   issue.severity === 'HIGH' ? '⚠️' :
                                   issue.severity === 'MEDIUM' ? '⚡' : 'ℹ️';
                console.log(`      ${severityIcon} ${issue.issue} (${issue.severity})`);
              });
            }
            console.log('');
          } catch (e) {
            console.log(`❌ Malformed log entry: ${line.substring(0, 100)}...`);
          }
        });
      } else {
        console.log('📝 Диагностические логи пустые');
      }
    } catch (error) {
      console.error('❌ Ошибка чтения диагностических логов:', error.message);
    }
  } else {
    console.log('❌ Файл диагностических логов не найден');
  }
  
  console.log('\n' + '='.repeat(60) + '\n');
  
  // Читаем последние ошибки Telegram
  if (fs.existsSync(TELEGRAM_LOG)) {
    try {
      const content = fs.readFileSync(TELEGRAM_LOG, 'utf8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      const errorLines = lines.filter(line => line.includes('[ERROR]')).slice(-10);
      
      if (errorLines.length > 0) {
        console.log(`📱 Последние ${errorLines.length} ошибок Telegram:\n`);
        
        errorLines.forEach((line, index) => {
          const parts = line.match(/^\[([^\]]+)\] \[([^\]]+)\] (.+)$/);
          if (parts) {
            const [, timestamp, status, message] = parts;
            const time = new Date(timestamp).toLocaleTimeString();
            console.log(`❌ [${time}] ${message.substring(0, 150)}${message.length > 150 ? '...' : ''}`);
          }
        });
        console.log('');
      } else {
        console.log('✅ Нет ошибок в Telegram логах');
      }
    } catch (error) {
      console.error('❌ Ошибка чтения Telegram логов:', error.message);
    }
  } else {
    console.log('❌ Файл Telegram логов не найден');
  }
}

function analyzePatterns() {
  console.log('\n🔍 === PATTERN ANALYSIS === 🔍\n');
  
  if (!fs.existsSync(TELEGRAM_LOG)) {
    console.log('❌ Telegram логи недоступны для анализа');
    return;
  }
  
  try {
    const content = fs.readFileSync(TELEGRAM_LOG, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    const errorLines = lines.filter(line => line.includes('[ERROR]'));
    
    // Анализ паттернов ошибок
    const patterns = {};
    errorLines.forEach(line => {
      if (line.includes('token_mint')) patterns['token_mint'] = (patterns['token_mint'] || 0) + 1;
      if (line.includes('Connection terminated')) patterns['connection'] = (patterns['connection'] || 0) + 1;
      if (line.includes('Database pool error')) patterns['database'] = (patterns['database'] || 0) + 1;
      if (line.includes('timeout')) patterns['timeout'] = (patterns['timeout'] || 0) + 1;
    });
    
    if (Object.keys(patterns).length > 0) {
      console.log('📈 Частота ошибок:');
      Object.entries(patterns).forEach(([pattern, count]) => {
        const icon = count > 10 ? '🚨' : count > 5 ? '⚠️' : 'ℹ️';
        console.log(`   ${icon} ${pattern}: ${count} раз`);
      });
    } else {
      console.log('✅ Паттерны ошибок не обнаружены');
    }
    
  } catch (error) {
    console.error('❌ Ошибка анализа паттернов:', error.message);
  }
}

// Параметры командной строки
const args = process.argv.slice(2);
const command = args[0];
const entries = args[1] ? parseInt(args[1]) : DEFAULT_ENTRIES;

if (command === 'patterns') {
  analyzePatterns();
} else {
  const limit = command ? parseInt(command) : entries;
  if (isNaN(limit) || limit <= 0) {
    console.error('❌ Неверное количество записей. Используйте положительное число.');
    console.log('\nИспользование:');
    console.log('  node read-diagnostics.js [количество]  - показать последние диагностики');
    console.log('  node read-diagnostics.js patterns      - анализ паттернов ошибок');
    process.exit(1);
  }
  readDiagnosticsLogs(limit);
} 