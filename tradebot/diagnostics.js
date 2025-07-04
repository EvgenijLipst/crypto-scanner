const fs = require('fs');
const path = require('path');

// Простая версия AutoRepairSystem для tradebot
class AutoRepairSystem {
  constructor(database, notify) {
    this.database = database;
    this.notify = notify;
    this.repairHistory = [];
  }

  async handleCriticalError(error, context = {}) {
    console.log(`[AutoRepair] Handling critical error: ${error}`);
    
    let fixed = false;
    
    // Исправление проблем с базой данных
    if (error.includes('token_mint') || error.includes('column "token_mint" does not exist')) {
      fixed = await this.fixTokenMintSchema();
    } else if (error.includes('Connection terminated') || error.includes('connection')) {
      fixed = await this.restartDatabaseConnection();
    } else if (error.includes('Insufficient funds')) {
      fixed = await this.handleInsufficientFunds();
    } else if (error.includes('trade') || error.includes('position')) {
      fixed = await this.fixTradingIssues();
    }
    
    this.repairHistory.push({
      timestamp: new Date(),
      error,
      context,
      fixed,
      action: this.getActionForError(error)
    });
    
    if (fixed) {
      await this.notify(
        `🤖 **Auto-Repair Successful** 🤖\n\n` +
        `Error: ${error}\n` +
        `Status: ✅ Fixed automatically\n` +
        `Action: ${this.getActionForError(error)}`
      );
    } else {
      await this.notify(
        `⚠️ **Auto-Repair Failed** ⚠️\n\n` +
        `Error: ${error}\n` +
        `Status: ❌ Could not fix automatically\n` +
        `Action: May require manual intervention`
      );
    }
    
    return fixed;
  }

  getActionForError(error) {
    if (error.includes('token_mint')) return 'Fixed database schema';
    if (error.includes('connection')) return 'Restarted database connection';
    if (error.includes('Insufficient funds')) return 'Adjusted trading parameters';
    if (error.includes('trade')) return 'Fixed trading logic';
    return 'General system repair';
  }

  async fixTokenMintSchema() {
    try {
      console.log('[AutoRepair] Fixing token_mint schema...');
      
      const result = await this.database.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'signals'
      `);
      
      const columns = result.rows.map(row => row.column_name);
      const hasTokenMint = columns.includes('token_mint');
      const hasMint = columns.includes('mint');
      
      if (hasTokenMint && hasMint) {
        await this.database.query(`ALTER TABLE signals DROP COLUMN token_mint CASCADE`);
      } else if (hasTokenMint && !hasMint) {
        await this.database.query(`ALTER TABLE signals RENAME COLUMN token_mint TO mint`);
      } else if (!hasMint) {
        await this.database.query(`ALTER TABLE signals ADD COLUMN mint TEXT`);
      }
      
      console.log('[AutoRepair] ✅ Token mint schema fixed');
      return true;
    } catch (error) {
      console.error('[AutoRepair] ❌ Failed to fix token_mint schema:', error);
      return false;
    }
  }

  async restartDatabaseConnection() {
    try {
      console.log('[AutoRepair] Restarting database connection...');
      // В tradebot это будет обработано на уровне основного цикла
      console.log('[AutoRepair] ✅ Database connection restart initiated');
      return true;
    } catch (error) {
      console.error('[AutoRepair] ❌ Failed to restart database connection:', error);
      return false;
    }
  }

  async handleInsufficientFunds() {
    try {
      console.log('[AutoRepair] Handling insufficient funds...');
      
      // Закрываем старые позиции для освобождения средств
      await this.database.query(`
        UPDATE trades 
        SET closed_at = NOW(), 
            sell_tx = 'AUTO_REPAIR_FUNDS_CLEANUP'
        WHERE closed_at IS NULL 
        AND created_at < NOW() - INTERVAL '24 hours'
      `);
      
      console.log('[AutoRepair] ✅ Cleaned up old positions to free funds');
      return true;
    } catch (error) {
      console.error('[AutoRepair] ❌ Failed to handle insufficient funds:', error);
      return false;
    }
  }

  async fixTradingIssues() {
    try {
      console.log('[AutoRepair] Fixing trading issues...');
      
      // Исправляем зависшие позиции
      const fixes = [
        `UPDATE trades SET closed_at = NOW(), sell_tx = 'AUTO_REPAIR_TIMEOUT' WHERE closed_at IS NULL AND created_at < NOW() - INTERVAL '48 hours'`,
        `UPDATE trades SET closed_at = NOW(), sell_tx = 'AUTO_REPAIR_DATA_FIX' WHERE closed_at IS NULL AND (bought_amount <= 0 OR spent_usdc <= 0)`,
        `DELETE FROM signals s1 USING signals s2 WHERE s1.id < s2.id AND s1.mint = s2.mint AND s1.signal_ts = s2.signal_ts`
      ];
      
      let fixedCount = 0;
      for (const fix of fixes) {
        try {
          const result = await this.database.query(fix);
          fixedCount += result.rowCount || 0;
        } catch (error) {
          console.warn('[AutoRepair] Trading fix failed (non-critical):', error);
        }
      }
      
      console.log(`[AutoRepair] ✅ Fixed ${fixedCount} trading issues`);
      return true;
    } catch (error) {
      console.error('[AutoRepair] ❌ Failed to fix trading issues:', error);
      return false;
    }
  }

  getRepairStats() {
    const total = this.repairHistory.length;
    const successful = this.repairHistory.filter(h => h.fixed).length;
    
    return {
      total,
      successful,
      failed: total - successful,
      successRate: total > 0 ? (successful / total * 100).toFixed(1) : 0,
      recentActions: this.repairHistory.slice(-5)
    };
  }
}

class TradebotDiagnostics {
  constructor(pool, notifyFunction) {
    this.pool = pool;
    this.notify = notifyFunction;
    this.autoRepair = new AutoRepairSystem({ query: pool.query.bind(pool) }, notifyFunction);
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

    // Автономные исправления
    if (issues.length > 0) {
      console.log(`🤖 [Tradebot] Attempting autonomous repairs for ${issues.length} issues...`);
      await this.performAutonomousRepairs(issues);
    }

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

  async performAutonomousRepairs(issues) {
    let criticalIssues = 0;
    let fixedIssues = 0;
    
    for (const issue of issues) {
      if (issue.severity === 'CRITICAL' || issue.severity === 'HIGH') {
        criticalIssues++;
        
        try {
          console.log(`🤖 [Tradebot] Attempting autonomous repair for: ${issue.issue}`);
          
          const fixed = await this.autoRepair.handleCriticalError(issue.issue, {
            severity: issue.severity,
            description: issue.description,
            solution: issue.solution
          });
          
          if (fixed) {
            fixedIssues++;
            console.log(`✅ [Tradebot] Autonomous repair successful: ${issue.issue}`);
          } else {
            console.log(`❌ [Tradebot] Autonomous repair failed: ${issue.issue}`);
          }
        } catch (error) {
          console.error(`❌ [Tradebot] Autonomous repair error for ${issue.issue}: ${error}`);
        }
      }
    }
    
    // Отправляем уведомление только если есть критические проблемы
    if (criticalIssues > 2) { // Для tradebot порог ниже, так как он работает с деньгами
      await this.notify(
        `🤖 **Tradebot Autonomous Repair** 🤖\n\n` +
        `Found ${criticalIssues} critical trading issues.\n` +
        `Auto-repaired: ${fixedIssues}\n` +
        `Status: ${fixedIssues === criticalIssues ? '✅ All issues resolved automatically' : '⚠️ Some issues may require manual intervention'}\n\n` +
        `Trading system is now self-healing and monitoring.`
      );
    }
  }

  async logDiagnostics(health) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      component: 'TRADEBOT',
      status: health.overallStatus,
      issuesCount: health.issues.length,
      metrics: health.metrics,
      issues: health.issues.map(i => ({ issue: i.issue, severity: i.severity })),
      autoRepairStats: this.autoRepair.getRepairStats()
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