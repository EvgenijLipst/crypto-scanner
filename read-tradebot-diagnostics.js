const fs = require('fs');
const path = require('path');

const DIAGNOSTICS_LOG_FILE = 'tradebot-diagnostics.log';

function readTradebotDiagnostics() {
  console.log('🔧 === TRADEBOT DIAGNOSTICS REPORT === 🔧');
  console.log('⏱️  Частота диагностики: каждую минуту\n');

  if (!fs.existsSync(DIAGNOSTICS_LOG_FILE)) {
    console.log('❌ Файл диагностических логов трейдбота не найден');
    return;
  }

  try {
    const content = fs.readFileSync(DIAGNOSTICS_LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    
    if (lines.length === 0) {
      console.log('📋 Файл диагностики пуст');
      return;
    }

    console.log(`📊 Всего записей диагностики: ${lines.length}\n`);

    // Показываем последние 10 записей
    const recentLines = lines.slice(-10);
    
    console.log('📋 === ПОСЛЕДНИЕ 10 ЗАПИСЕЙ ДИАГНОСТИКИ === 📋\n');
    
    recentLines.forEach((line, index) => {
      try {
        const entry = JSON.parse(line);
        const timestamp = new Date(entry.timestamp).toLocaleString();
        const statusIcon = entry.status === 'HEALTHY' ? '✅' : 
                          entry.status === 'WARNING' ? '⚠️' : '🚨';
        
        console.log(`${statusIcon} [${timestamp}] ${entry.status}`);
        console.log(`   📊 Метрики: Ошибок: ${entry.metrics.errorRate}, Позиций: ${entry.metrics.openPositions}`);
        
        if (entry.issuesCount > 0) {
          console.log(`   🔍 Найдено проблем: ${entry.issuesCount}`);
          entry.issues.forEach(issue => {
            const severityIcon = issue.severity === 'CRITICAL' ? '🚨' : 
                               issue.severity === 'HIGH' ? '⚠️' : 
                               issue.severity === 'MEDIUM' ? '🟡' : '🔵';
            console.log(`      ${severityIcon} ${issue.issue} (${issue.severity})`);
          });
        }
        console.log('');
      } catch (error) {
        console.log(`❌ Ошибка парсинга записи ${index + 1}: ${error.message}`);
      }
    });

    // Анализ паттернов
    console.log('📊 === АНАЛИЗ ПАТТЕРНОВ === 📊\n');
    
    const allEntries = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(entry => entry !== null);

    if (allEntries.length === 0) {
      console.log('❌ Нет валидных записей для анализа');
      return;
    }

    // Статистика по статусам
    const statusCounts = {};
    allEntries.forEach(entry => {
      statusCounts[entry.status] = (statusCounts[entry.status] || 0) + 1;
    });

    console.log('📈 Статистика по статусам:');
    Object.entries(statusCounts).forEach(([status, count]) => {
      const percentage = ((count / allEntries.length) * 100).toFixed(1);
      const icon = status === 'HEALTHY' ? '✅' : status === 'WARNING' ? '⚠️' : '🚨';
      console.log(`   ${icon} ${status}: ${count} (${percentage}%)`);
    });

    // Топ проблем
    const issuesCounts = {};
    allEntries.forEach(entry => {
      if (entry.issues && entry.issues.length > 0) {
        entry.issues.forEach(issue => {
          issuesCounts[issue.issue] = (issuesCounts[issue.issue] || 0) + 1;
        });
      }
    });

    if (Object.keys(issuesCounts).length > 0) {
      console.log('\n🔍 Топ проблем:');
      const sortedIssues = Object.entries(issuesCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5);
      
      sortedIssues.forEach(([issue, count]) => {
        console.log(`   🔸 ${issue}: ${count} раз`);
      });
    }

    // Последнее состояние
    const lastEntry = allEntries[allEntries.length - 1];
    const lastCheck = new Date(lastEntry.timestamp);
    const minutesAgo = Math.floor((Date.now() - lastCheck.getTime()) / (1000 * 60));
    
    console.log(`\n🕐 Последняя проверка: ${minutesAgo} минут назад`);
    console.log(`📊 Текущий статус: ${lastEntry.status}`);
    console.log(`💰 Открытых позиций: ${lastEntry.metrics.openPositions}`);

  } catch (error) {
    console.log(`❌ Ошибка чтения файла диагностики: ${error.message}`);
  }
}

// Запускаем анализ
readTradebotDiagnostics(); 