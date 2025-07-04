const fs = require('fs');
const path = require('path');

const LOG_FILES = {
  'signal-bot': 'diagnostics.log',
  'tradebot': 'tradebot-diagnostics.log',
  'telegram': 'telegram.log'
};

function readAllDiagnostics() {
  console.log('🔧 === ПОЛНЫЙ ОТЧЕТ ПО ДИАГНОСТИКЕ СИСТЕМЫ === 🔧\n');

  // Проверяем каждый тип логов
  Object.entries(LOG_FILES).forEach(([component, filename]) => {
    console.log(`📋 === ${component.toUpperCase()} === 📋`);
    
    if (!fs.existsSync(filename)) {
      console.log(`❌ Файл логов ${filename} не найден\n`);
      return;
    }

    try {
      const content = fs.readFileSync(filename, 'utf8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      
      if (lines.length === 0) {
        console.log(`📋 Файл ${filename} пуст\n`);
        return;
      }

      console.log(`📊 Всего записей: ${lines.length}`);

      if (component === 'telegram') {
        // Для Telegram логов - показываем последние сообщения
        const recentLines = lines.slice(-5);
        console.log('📨 Последние 5 сообщений:');
        recentLines.forEach(line => {
          console.log(`   ${line}`);
        });
      } else {
        // Для диагностических логов - парсим JSON
        const recentLines = lines.slice(-3);
        console.log('🔍 Последние 3 проверки:');
        
        recentLines.forEach((line, index) => {
          try {
            const entry = JSON.parse(line);
            const timestamp = new Date(entry.timestamp).toLocaleString();
            const statusIcon = entry.status === 'HEALTHY' ? '✅' : 
                              entry.status === 'WARNING' ? '⚠️' : '🚨';
            
            console.log(`   ${statusIcon} [${timestamp}] ${entry.status} (${entry.issuesCount} проблем)`);
            
            if (entry.issuesCount > 0) {
              entry.issues.slice(0, 2).forEach(issue => {
                const severityIcon = issue.severity === 'CRITICAL' ? '🚨' : 
                                   issue.severity === 'HIGH' ? '⚠️' : 
                                   issue.severity === 'MEDIUM' ? '🟡' : '🔵';
                console.log(`      ${severityIcon} ${issue.issue}`);
              });
            }
          } catch (error) {
            console.log(`   ❌ Ошибка парсинга записи: ${error.message}`);
          }
        });
      }
      
      console.log('');
    } catch (error) {
      console.log(`❌ Ошибка чтения файла ${filename}: ${error.message}\n`);
    }
  });

  // Общая статистика
  console.log('📊 === ОБЩАЯ СТАТИСТИКА === 📊');
  
  let totalHealthyChecks = 0;
  let totalWarningChecks = 0;
  let totalCriticalChecks = 0;
  let totalChecks = 0;

  ['diagnostics.log', 'tradebot-diagnostics.log'].forEach(filename => {
    if (fs.existsSync(filename)) {
      try {
        const content = fs.readFileSync(filename, 'utf8');
        const lines = content.trim().split('\n').filter(line => line.length > 0);
        
        lines.forEach(line => {
          try {
            const entry = JSON.parse(line);
            totalChecks++;
            if (entry.status === 'HEALTHY') totalHealthyChecks++;
            else if (entry.status === 'WARNING') totalWarningChecks++;
            else if (entry.status === 'CRITICAL') totalCriticalChecks++;
          } catch {}
        });
      } catch {}
    }
  });

  if (totalChecks > 0) {
    console.log(`✅ Здоровых проверок: ${totalHealthyChecks} (${((totalHealthyChecks/totalChecks)*100).toFixed(1)}%)`);
    console.log(`⚠️ Предупреждений: ${totalWarningChecks} (${((totalWarningChecks/totalChecks)*100).toFixed(1)}%)`);
    console.log(`🚨 Критических: ${totalCriticalChecks} (${((totalCriticalChecks/totalChecks)*100).toFixed(1)}%)`);
    console.log(`📊 Всего проверок: ${totalChecks}`);
  } else {
    console.log('❌ Нет данных для анализа');
  }

  // Проверяем, когда была последняя активность
  const now = Date.now();
  let lastActivityTime = 0;
  
  Object.values(LOG_FILES).forEach(filename => {
    if (fs.existsSync(filename)) {
      try {
        const stats = fs.statSync(filename);
        lastActivityTime = Math.max(lastActivityTime, stats.mtime.getTime());
      } catch {}
    }
  });

  if (lastActivityTime > 0) {
    const minutesAgo = Math.floor((now - lastActivityTime) / (1000 * 60));
    console.log(`\n🕐 Последняя активность: ${minutesAgo} минут назад`);
    
    if (minutesAgo > 10) {
      console.log('⚠️ Система может быть неактивна - нет обновлений логов более 10 минут');
    }
  }
}

// Запускаем анализ
readAllDiagnostics(); 