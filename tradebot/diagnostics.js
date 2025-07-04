const fs = require('fs');
const path = require('path');

class TradebotDiagnostics {
  constructor(pool, notifyFunction) {
    this.pool = pool;
    this.notify = notifyFunction;
    this.logFilePath = path.join(__dirname, '..', 'telegram.log');
    this.diagnosticsLogPath = path.join(__dirname, '..', 'tradebot-diagnostics.log');
    this.errorPatterns = new Map();
    this.initializeErrorPatterns();
  }

  initializeErrorPatterns() {
    // Ошибки трейдбота
    this.errorPatterns.set('COULD_NOT_FIND_ANY_ROUTE', {
      issue: 'JUPITER_NO_ROUTE',
      severity: 'HIGH',
      description: 'Jupiter API cannot find trading routes',
      solution: 'Check token liquidity and Jupiter API status'
    });

    this.errorPatterns.set('Quote error', {
      issue: 'JUPITER_QUOTE_ERROR',
      severity: 'HIGH',
      description: 'Jupiter quote API errors',
      solution: 'Check Jupiter API status and token validity'
    });

    this.errorPatterns.set('Swap tx error', {
      issue: 'JUPITER_SWAP_ERROR',
      severity: 'HIGH',
      description: 'Jupiter swap transaction errors',
      solution: 'Check wallet balance and token approvals'
    });

    this.errorPatterns.set('Transaction failed', {
      issue: 'SOLANA_TX_FAILED',
      severity: 'HIGH',
      description: 'Solana transaction execution failed',
      solution: 'Check RPC connection and wallet balance'
    });

    this.errorPatterns.set('Insufficient funds', {
      issue: 'WALLET_INSUFFICIENT_FUNDS',
      severity: 'CRITICAL',
      description: 'Wallet has insufficient funds for trading',
      solution: 'Add funds to trading wallet'
    });

    this.errorPatterns.set('Price impact too high', {
      issue: 'HIGH_PRICE_IMPACT',
      severity: 'MEDIUM',
      description: 'Trade rejected due to high price impact',
      solution: 'Reduce trade size or wait for better liquidity'
    });

    this.errorPatterns.set('Telegram notification failed', {
      issue: 'TELEGRAM_NOTIFICATION_FAILED',
      severity: 'MEDIUM',
      description: 'Failed to send Telegram notifications',
      solution: 'Check Telegram bot token and chat ID'
    });

    this.errorPatterns.set('Rug pull risk detected', {
      issue: 'RUG_PULL_DETECTED',
      severity: 'HIGH',
      description: 'Potential rug pull risk detected',
      solution: 'Review token safety checks and filters'
    });

    this.errorPatterns.set('Database query failed', {
      issue: 'DATABASE_QUERY_ERROR',
      severity: 'HIGH',
      description: 'Database query execution failed',
      solution: 'Check database connection and query syntax'
    });

    this.errorPatterns.set('Connection terminated', {
      issue: 'DATABASE_CONNECTION_ERROR',
      severity: 'HIGH',
      description: 'Database connection terminated unexpectedly',
      solution: 'Restart database connection pool'
    });
  }

  async runDiagnostics() {
    const startTime = Date.now();
    const issues = [];

    console.log('🔍 [Tradebot] Running diagnostics...');

    try {
      // 1. Анализ логов
      console.log('📋 [Tradebot] Analyzing logs...');
      const logIssues = await this.analyzeLogs();
      console.log(`📋 [Tradebot] Found ${logIssues.length} log issues`);
      issues.push(...logIssues);

      // 2. Проверка базы данных
      console.log('🗄️ [Tradebot] Checking database health...');
      const dbIssues = await this.checkDatabaseHealth();
      console.log(`🗄️ [Tradebot] Found ${dbIssues.length} database issues`);
      issues.push(...dbIssues);

      // 3. Проверка торговых позиций
      console.log('💰 [Tradebot] Checking trading positions...');
      const tradeIssues = await this.checkTradingHealth();
      console.log(`💰 [Tradebot] Found ${tradeIssues.length} trading issues`);
      issues.push(...tradeIssues);

    } catch (error) {
      console.error(`❌ [Tradebot] Diagnostics error: ${error}`);
      issues.push({
        issue: 'TRADEBOT_DIAGNOSTICS_ERROR',
        severity: 'HIGH',
        description: `Tradebot diagnostics system error: ${error}`,
        solution: 'Check tradebot diagnostics system'
      });
    }

    const health = {
      overallStatus: this.calculateOverallStatus(issues),
      issues,
      lastCheck: new Date(),
      metrics: {
        errorRate: await this.calculateErrorRate(),
        openPositions: await this.countOpenPositions(),
        uptime: (Date.now() - startTime) / 1000
      }
    };

    // Записываем результаты диагностики
    console.log('💾 [Tradebot] Logging diagnostics results...');
    await this.logDiagnostics(health);

    console.log(`🔍 [Tradebot] Diagnostics completed in ${health.metrics.uptime}s, found ${issues.length} issues`);
    
    return health;
  }

  async analyzeLogs() {
    const issues = [];

    try {
      console.log(`📋 [Tradebot] Checking log file: ${this.logFilePath}`);
      
      if (!fs.existsSync(this.logFilePath)) {
        console.log(`📋 [Tradebot] Log file does not exist yet: ${this.logFilePath}`);
        return issues;
      }

      const content = fs.readFileSync(this.logFilePath, 'utf8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      
      console.log(`📋 [Tradebot] Analyzing ${lines.length} log lines`);
      
      // Анализируем последние 100 записей
      const recentLines = lines.slice(-100);
      const tradebotLines = recentLines.filter(line => line.includes('[TB-') || line.includes('Tradebot'));
      
      console.log(`📋 [Tradebot] Found ${tradebotLines.length} tradebot-related lines`);

      for (const logLine of tradebotLines) {
        for (const [pattern, diagnostic] of this.errorPatterns) {
          if (logLine.includes(pattern)) {
            // Считаем частоту этой ошибки
            const occurrences = tradebotLines.filter(line => line.includes(pattern)).length;
            
            console.log(`📋 [Tradebot] Found error pattern "${pattern}" with ${occurrences} occurrences`);
            
            const issue = {
              ...diagnostic,
              description: `${diagnostic.description} (${occurrences} occurrences in tradebot logs)`
            };

            // Повышаем severity если ошибка частая
            if (occurrences > 10) {
              issue.severity = 'CRITICAL';
            } else if (occurrences > 5) {
              issue.severity = 'HIGH';
            }

            issues.push(issue);
            break; // Не дублируем одинаковые ошибки
          }
        }
      }

    } catch (error) {
      console.error(`❌ [Tradebot] Error analyzing logs: ${error}`);
    }

    return issues;
  }

  async checkDatabaseHealth() {
    const issues = [];

    try {
      // Проверяем соединение с базой данных
      await this.pool.query('SELECT 1');
      
      // Проверяем структуру таблицы trades
      const result = await this.pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'trades'
      `);
      
      const columns = result.rows.map(row => row.column_name);
      
      if (!columns.includes('mint')) {
        issues.push({
          issue: 'MISSING_MINT_COLUMN_TRADES',
          severity: 'CRITICAL',
          description: 'Table trades missing required "mint" column',
          solution: 'Add mint column to trades table'
        });
      }

      if (!columns.includes('buy_tx')) {
        issues.push({
          issue: 'MISSING_BUY_TX_COLUMN',
          severity: 'HIGH',
          description: 'Table trades missing buy_tx column',
          solution: 'Add buy_tx column to trades table'
        });
      }

    } catch (error) {
      issues.push({
        issue: 'TRADEBOT_DATABASE_UNREACHABLE',
        severity: 'CRITICAL',
        description: `Cannot connect to database: ${error}`,
        solution: 'Check database connection string and network connectivity'
      });
    }

    return issues;
  }

  async checkTradingHealth() {
    const issues = [];

    try {
      // Проверяем количество открытых позиций
      const openPositions = await this.pool.query(`
        SELECT COUNT(*) as count 
        FROM trades 
        WHERE closed_at IS NULL
      `);
      
      const openCount = parseInt(openPositions.rows[0].count);
      
      if (openCount > 5) {
        issues.push({
          issue: 'TOO_MANY_OPEN_POSITIONS',
          severity: 'HIGH',
          description: `Too many open positions: ${openCount}`,
          solution: 'Review trading strategy and position management'
        });
      }

      // Проверяем старые позиции (открыты более 24 часов)
      const oldPositions = await this.pool.query(`
        SELECT COUNT(*) as count 
        FROM trades 
        WHERE closed_at IS NULL 
        AND created_at < NOW() - INTERVAL '24 hours'
      `);
      
      const oldCount = parseInt(oldPositions.rows[0].count);
      
      if (oldCount > 0) {
        issues.push({
          issue: 'OLD_OPEN_POSITIONS',
          severity: 'MEDIUM',
          description: `${oldCount} positions open for more than 24 hours`,
          solution: 'Review position management and stop-loss settings'
        });
      }

    } catch (error) {
      console.error(`❌ [Tradebot] Error checking trading health: ${error}`);
    }

    return issues;
  }

  calculateOverallStatus(issues) {
    if (issues.some(i => i.severity === 'CRITICAL')) return 'CRITICAL';
    if (issues.some(i => i.severity === 'HIGH')) return 'WARNING';
    if (issues.length > 0) return 'WARNING';
    return 'HEALTHY';
  }

  async calculateErrorRate() {
    // Простая реализация - можно улучшить
    return 0;
  }

  async countOpenPositions() {
    try {
      const result = await this.pool.query(`
        SELECT COUNT(*) as count 
        FROM trades 
        WHERE closed_at IS NULL
      `);
      return parseInt(result.rows[0].count);
    } catch (error) {
      return 0;
    }
  }

  async logDiagnostics(health) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      component: 'TRADEBOT',
      status: health.overallStatus,
      issuesCount: health.issues.length,
      metrics: health.metrics,
      issues: health.issues.map(i => ({ issue: i.issue, severity: i.severity }))
    };

    try {
      console.log(`💾 [Tradebot] Writing diagnostics to: ${this.diagnosticsLogPath}`);
      fs.appendFileSync(
        this.diagnosticsLogPath, 
        JSON.stringify(logEntry) + '\n', 
        'utf8'
      );
      console.log(`✅ [Tradebot] Diagnostics log written successfully`);
    } catch (error) {
      console.error(`❌ [Tradebot] Failed to write diagnostics log: ${error}`);
    }
  }
}

module.exports = { TradebotDiagnostics }; 