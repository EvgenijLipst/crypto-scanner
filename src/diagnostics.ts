// diagnostics.ts - Автодиагностика и самоисправление системы

import fs from 'fs';
import path from 'path';
import { Database } from './database';
import { TelegramBot } from './telegram';
import { log } from './utils';
import { AutoRepairSystem } from './auto-repair';

interface DiagnosticResult {
  issue: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  autoFix?: () => Promise<boolean>;
  solution: string;
}

interface SystemHealth {
  overallStatus: 'HEALTHY' | 'WARNING' | 'CRITICAL';
  issues: DiagnosticResult[];
  lastCheck: Date;
  metrics: {
    errorRate: number;
    dbConnections: number;
    telegramErrors: number;
    uptime: number;
  };
}

export class DiagnosticsSystem {
  private database: Database;
  private telegram: TelegramBot;
  private autoRepair: AutoRepairSystem;
  private logFilePath: string;
  private diagnosticsLogPath: string;
  private errorPatterns: Map<string, DiagnosticResult> = new Map();

  constructor(database: Database, telegram: TelegramBot) {
    this.database = database;
    this.telegram = telegram;
    this.autoRepair = new AutoRepairSystem(database, telegram);
    this.logFilePath = path.join(process.cwd(), 'telegram.log');
    this.diagnosticsLogPath = path.join(process.cwd(), 'diagnostics.log');
    
    this.initializeErrorPatterns();
    log('🔧 Diagnostics system initialized with auto-repair capabilities');
  }

  private initializeErrorPatterns(): void {
    // Ошибки сигнального бота
    this.errorPatterns.set('token_mint', {
      issue: 'TOKEN_MINT_COLUMN_ERROR',
      severity: 'CRITICAL',
      description: 'Database query using deprecated "token_mint" column',
      autoFix: this.fixTokenMintIssue.bind(this),
      solution: 'Rename token_mint column to mint in database'
    });

    this.errorPatterns.set('Connection terminated', {
      issue: 'DATABASE_CONNECTION_ERROR',
      severity: 'HIGH',
      description: 'Database connection terminated unexpectedly',
      autoFix: this.fixDatabaseConnection.bind(this),
      solution: 'Restart database connection pool'
    });

    this.errorPatterns.set('timeout', {
      issue: 'TELEGRAM_TIMEOUT',
      severity: 'MEDIUM',
      description: 'Telegram API timeout errors',
      solution: 'Check network connectivity and Telegram API status'
    });

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
  }

  /**
   * Основная функция диагностики системы
   */
  async runDiagnostics(): Promise<SystemHealth> {
    const startTime = Date.now();
    const issues: DiagnosticResult[] = [];

    log('🔍 Running system diagnostics...');

    try {
      // 1. Анализ Telegram логов
      log('📋 Analyzing Telegram logs...');
      const telegramIssues = await this.analyzeTelegramLogs();
      log(`📋 Found ${telegramIssues.length} Telegram issues`);
      issues.push(...telegramIssues);

      // 2. Проверка базы данных
      log('🗄️ Checking database health...');
      const dbIssues = await this.checkDatabaseHealth();
      log(`🗄️ Found ${dbIssues.length} database issues`);
      issues.push(...dbIssues);

      // 3. Анализ частоты ошибок
      log('📊 Analyzing error patterns...');
      const errorRateIssues = await this.analyzeErrorPatterns();
      log(`📊 Found ${errorRateIssues.length} error pattern issues`);
      issues.push(...errorRateIssues);

      // 4. Проверка системных ресурсов
      log('💻 Checking system resources...');
      const systemIssues = await this.checkSystemResources();
      log(`💻 Found ${systemIssues.length} system issues`);
      issues.push(...systemIssues);

    } catch (error) {
      log(`❌ Diagnostics error: ${error}`, 'ERROR');
      issues.push({
        issue: 'DIAGNOSTICS_ERROR',
        severity: 'HIGH',
        description: `Diagnostics system error: ${error}`,
        solution: 'Check diagnostics system logs and restart if needed'
      });
    }

    const health: SystemHealth = {
      overallStatus: this.calculateOverallStatus(issues),
      issues,
      lastCheck: new Date(),
      metrics: {
        errorRate: await this.calculateErrorRate(),
        dbConnections: await this.checkDbConnections(),
        telegramErrors: await this.countTelegramErrors(),
        uptime: (Date.now() - startTime) / 1000
      }
    };

    // Записываем результаты диагностики
    log('💾 Logging diagnostics results...');
    await this.logDiagnostics(health);

    // Автономные исправления через AutoRepairSystem
    if (issues.length > 0) {
      log(`🔧 Attempting autonomous auto-repairs for ${issues.length} issues...`);
      await this.performAutonomousRepairs(issues);
    }

    log(`🔍 Diagnostics completed in ${health.metrics.uptime}s, found ${issues.length} issues`);
    
    return health;
  }

  /**
   * Анализ логов Telegram для выявления проблем
   */
  private async analyzeTelegramLogs(): Promise<DiagnosticResult[]> {
    const issues: DiagnosticResult[] = [];

    try {
      log('🔍 Starting detailed Telegram log analysis...');
      
      const logs = this.telegram.getRecentTelegramLogs(100);
      log(`📋 Found ${logs.length} recent Telegram log entries`);

      if (logs.length === 0) {
        log('📋 Telegram log file does not exist yet: ' + this.logFilePath);
        return issues;
      }

      // Подробный анализ каждого типа ошибки
      const errorCounts: { [key: string]: number } = {};
      const detailedErrors: string[] = [];

      logs.forEach((line, index) => {
        log(`🔍 Analyzing log line ${index + 1}: ${line.substring(0, 100)}...`);
        
        // Проверяем каждый паттерн ошибок
        for (const [pattern, config] of this.errorPatterns.entries()) {
          if (line.includes(pattern)) {
            errorCounts[pattern] = (errorCounts[pattern] || 0) + 1;
            detailedErrors.push(`[${pattern}] ${line}`);
            
            log(`🚨 Found error pattern "${pattern}" in line: ${line}`);
            
            // Особо детальный анализ для token_mint
            if (pattern === 'token_mint') {
              log('🔍 DETAILED token_mint error analysis:');
              log(`  - Full line: ${line}`);
              log(`  - Line length: ${line.length}`);
              log(`  - Contains "column": ${line.includes('column')}`);
              log(`  - Contains "does not exist": ${line.includes('does not exist')}`);
              log(`  - Line index in logs: ${index}`);
              
              // Пытаемся найти контекст ошибки
              if (index > 0) {
                log(`  - Previous line: ${logs[index - 1]}`);
              }
              if (index < logs.length - 1) {
                log(`  - Next line: ${logs[index + 1]}`);
              }
            }
          }
        }
      });

             log(`📊 Error pattern counts: ${JSON.stringify(errorCounts, null, 2)}`);
      log(`📋 Detailed errors found: ${detailedErrors.length}`);

      // Создаем диагностические результаты
      for (const [pattern, count] of Object.entries(errorCounts)) {
        const config = this.errorPatterns.get(pattern);
        if (config && count > 0) {
          log(`🚨 Creating diagnostic result for pattern "${pattern}" with ${count} occurrences`);
          
          const issue: DiagnosticResult = {
            issue: config.issue,
            severity: config.severity,
            description: `${config.description} (${count} occurrences)`,
            solution: config.solution,
            autoFix: config.autoFix
          };

          issues.push(issue);
          
          // Для token_mint добавляем дополнительную информацию
          if (pattern === 'token_mint') {
            log('🔧 token_mint error detected, attempting immediate auto-fix...');
            
            // Пытаемся выполнить автоисправление немедленно
            if (config.autoFix) {
              try {
                const fixResult = await config.autoFix();
                log(`🔧 Auto-fix result for token_mint: ${fixResult ? 'SUCCESS' : 'FAILED'}`);
                
                if (fixResult) {
                  await this.telegram.sendMessage(
                    '✅ **Auto-fix Applied**\n' +
                    'Successfully fixed token_mint column issue in database.\n' +
                    'System should now work normally.'
                  );
                } else {
                  await this.telegram.sendMessage(
                    '❌ **Auto-fix Failed**\n' +
                    'Could not automatically fix token_mint issue.\n' +
                    'Manual intervention may be required.'
                  );
                }
              } catch (error) {
                log(`❌ Auto-fix error: ${error}`, 'ERROR');
                await this.telegram.sendMessage(
                  '🚨 **Auto-fix Error**\n' +
                  `Failed to apply auto-fix: ${error}`
                );
              }
            }
          }
        }
      }

      log(`📋 Total diagnostic issues created: ${issues.length}`);

    } catch (error) {
      log(`Error analyzing Telegram logs: ${error}`, 'ERROR');
      issues.push({
        issue: 'LOG_ANALYSIS_ERROR',
        severity: 'MEDIUM',
        description: `Failed to analyze Telegram logs: ${error}`,
        solution: 'Check log file permissions and format'
      });
    }

    return issues;
  }

  /**
   * Проверка здоровья базы данных
   */
  private async checkDatabaseHealth(): Promise<DiagnosticResult[]> {
    const issues: DiagnosticResult[] = [];

    try {
      // Простой запрос для проверки соединения
      await this.database.getOldPools();
      
      // Проверяем структуру таблицы signals
      const result = await (this.database as any).pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'signals'
      `);
      
      const columns = result.rows.map((row: any) => row.column_name);
      
      if (columns.includes('token_mint')) {
        issues.push({
          issue: 'OLD_SCHEMA_DETECTED',
          severity: 'CRITICAL',
          description: 'Table signals still contains old "token_mint" column',
          autoFix: this.fixTableSchema.bind(this),
          solution: 'Migrate token_mint column to mint'
        });
      }

      if (!columns.includes('mint')) {
        issues.push({
          issue: 'MISSING_MINT_COLUMN',
          severity: 'CRITICAL',
          description: 'Table signals missing required "mint" column',
          autoFix: this.addMintColumn.bind(this),
          solution: 'Add mint column to signals table'
        });
      }

    } catch (error) {
      issues.push({
        issue: 'DATABASE_UNREACHABLE',
        severity: 'CRITICAL',
        description: `Cannot connect to database: ${error}`,
        solution: 'Check database connection string and network connectivity'
      });
    }

    return issues;
  }

  /**
   * Автоисправление: проблема с token_mint
   */
  private async fixTokenMintIssue(): Promise<boolean> {
    try {
      log('🔧 Attempting to fix token_mint issue...');
      log('🔍 Checking current database schema...');
      
      // Сначала проверяем текущую структуру
      const result = await (this.database as any).pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'signals'
        ORDER BY ordinal_position
      `);
      
      const columns = result.rows.map((row: any) => row.column_name);
      log(`📋 Current signals table columns: ${columns.join(', ')}`);
      
      const hasTokenMint = columns.includes('token_mint');
      const hasMint = columns.includes('mint');
      
      log(`🔍 Has token_mint column: ${hasTokenMint}`);
      log(`🔍 Has mint column: ${hasMint}`);
      
      if (hasTokenMint && hasMint) {
        log('🔧 Both columns exist, dropping token_mint...');
        await (this.database as any).pool.query(`
          ALTER TABLE signals DROP COLUMN token_mint CASCADE;
        `);
        log('✅ Successfully dropped token_mint column');
      } else if (hasTokenMint && !hasMint) {
        log('🔧 Renaming token_mint to mint...');
        await (this.database as any).pool.query(`
          ALTER TABLE signals RENAME COLUMN token_mint TO mint;
        `);
        log('✅ Successfully renamed token_mint to mint');
      } else if (!hasTokenMint && hasMint) {
        log('✅ Schema is already correct (mint column exists, token_mint does not)');
      } else {
        log('❌ Neither column exists, adding mint column...');
        await (this.database as any).pool.query(`
          ALTER TABLE signals ADD COLUMN mint TEXT;
        `);
        log('✅ Successfully added mint column');
      }
      
      // Проверяем финальную структуру
      const finalResult = await (this.database as any).pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'signals'
        ORDER BY ordinal_position
      `);
      
      const finalColumns = finalResult.rows.map((row: any) => row.column_name);
      log(`📋 Final signals table columns: ${finalColumns.join(', ')}`);
      
      return true;
    } catch (error) {
      log(`❌ Failed to fix token_mint issue: ${error}`, 'ERROR');
      log(`❌ Error details: ${JSON.stringify(error, null, 2)}`);
      return false;
    }
  }

  /**
   * Автоисправление: схема таблицы
   */
  private async fixTableSchema(): Promise<boolean> {
    try {
      log('🔧 Attempting to fix table schema...');
      
      await (this.database as any).pool.query(`
        ALTER TABLE signals RENAME COLUMN token_mint TO mint;
      `);
      
      log('✅ Table schema fixed');
      return true;
    } catch (error) {
      log(`❌ Failed to fix table schema: ${error}`, 'ERROR');
      return false;
    }
  }

  /**
   * Автоисправление: добавить колонку mint
   */
  private async addMintColumn(): Promise<boolean> {
    try {
      log('🔧 Adding mint column...');
      
      await (this.database as any).pool.query(`
        ALTER TABLE signals ADD COLUMN mint TEXT;
      `);
      
      log('✅ Mint column added');
      return true;
    } catch (error) {
      log(`❌ Failed to add mint column: ${error}`, 'ERROR');
      return false;
    }
  }

  /**
   * Автоисправление: база данных
   */
  private async fixDatabaseConnection(): Promise<boolean> {
    try {
      log('🔧 Attempting to fix database connection...');
      
      // Перезапускаем пул соединений
      await (this.database as any).pool.end();
      await this.database.initialize();
      
      log('✅ Database connection reestablished');
      return true;
    } catch (error) {
      log(`❌ Failed to fix database connection: ${error}`, 'ERROR');
      return false;
    }
  }

  /**
   * Автономные исправления через AutoRepairSystem
   */
  private async performAutonomousRepairs(issues: DiagnosticResult[]): Promise<void> {
    let criticalIssues = 0;
    let fixedIssues = 0;
    
    for (const issue of issues) {
      if (issue.severity === 'CRITICAL' || issue.severity === 'HIGH') {
        criticalIssues++;
        
        try {
          // Используем автономную систему исправлений
          const fixed = await this.autoRepair.handleCriticalError(issue.issue, {
            severity: issue.severity,
            description: issue.description,
            solution: issue.solution
          });
          
          if (fixed) {
            fixedIssues++;
            log(`✅ Autonomous repair successful: ${issue.issue}`);
          } else {
            log(`❌ Autonomous repair failed: ${issue.issue}`);
            
            // Fallback на старый метод автоисправления
            if (issue.autoFix) {
              try {
                const legacyFixed = await issue.autoFix();
                if (legacyFixed) {
                  fixedIssues++;
                  log(`✅ Legacy auto-fix successful: ${issue.issue}`);
                }
              } catch (error) {
                log(`❌ Legacy auto-fix error for ${issue.issue}: ${error}`, 'ERROR');
              }
            }
          }
        } catch (error) {
          log(`❌ Autonomous repair error for ${issue.issue}: ${error}`, 'ERROR');
        }
      }
    }
    
    // Отправляем уведомление только если есть критические проблемы
    if (criticalIssues > 3) {
      await this.telegram.sendMessage(
        `🤖 **Autonomous System Repair** 🤖\n\n` +
        `Found ${criticalIssues} critical issues.\n` +
        `Auto-repaired: ${fixedIssues}\n` +
        `Status: ${fixedIssues === criticalIssues ? '✅ All issues resolved automatically' : '⚠️ Some issues may require manual intervention'}\n\n` +
        `System is now self-healing and will continue monitoring.`
      );
    }
  }

  /**
   * Попытка автоисправлений (legacy метод)
   */
  private async attemptAutoFixes(issues: DiagnosticResult[]): Promise<void> {
    for (const issue of issues) {
      if (issue.autoFix && issue.severity === 'CRITICAL') {
        log(`🔧 Attempting auto-fix for: ${issue.issue}`);
        
        try {
          const success = await issue.autoFix();
          
          if (success) {
            await this.telegram.sendMessage(
              `🔧 **Auto-Fix Successful** ✅\n\n` +
              `Issue: ${issue.issue}\n` +
              `Description: ${issue.description}\n` +
              `Status: Fixed automatically`
            );
          } else {
            await this.telegram.sendMessage(
              `🔧 **Auto-Fix Failed** ❌\n\n` +
              `Issue: ${issue.issue}\n` +
              `Description: ${issue.description}\n` +
              `Action Required: Manual intervention needed`
            );
          }
        } catch (error) {
          log(`❌ Auto-fix error for ${issue.issue}: ${error}`, 'ERROR');
        }
      }
    }
  }

  // Вспомогательные методы для метрик
  private async analyzeErrorPatterns(): Promise<DiagnosticResult[]> { return []; }
  private async checkSystemResources(): Promise<DiagnosticResult[]> { return []; }
  private async calculateErrorRate(): Promise<number> { return 0; }
  private async checkDbConnections(): Promise<number> { return 1; }
  private async countTelegramErrors(): Promise<number> { return 0; }

  private calculateOverallStatus(issues: DiagnosticResult[]): 'HEALTHY' | 'WARNING' | 'CRITICAL' {
    if (issues.some(i => i.severity === 'CRITICAL')) return 'CRITICAL';
    if (issues.some(i => i.severity === 'HIGH')) return 'WARNING';
    if (issues.length > 0) return 'WARNING';
    return 'HEALTHY';
  }

  private async logDiagnostics(health: SystemHealth): Promise<void> {
    const logEntry = {
      timestamp: new Date().toISOString(),
      status: health.overallStatus,
      issuesCount: health.issues.length,
      metrics: health.metrics,
      issues: health.issues.map(i => ({ issue: i.issue, severity: i.severity }))
    };

    try {
      log(`💾 Writing diagnostics to: ${this.diagnosticsLogPath}`);
      fs.appendFileSync(
        this.diagnosticsLogPath, 
        JSON.stringify(logEntry) + '\n', 
        'utf8'
      );
      log(`✅ Diagnostics log written successfully`);
    } catch (error) {
      log(`❌ Failed to write diagnostics log: ${error}`, 'ERROR');
    }
  }
} 