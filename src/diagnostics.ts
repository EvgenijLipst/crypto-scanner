// diagnostics.ts - Автодиагностика и самоисправление системы

import fs from 'fs';
import path from 'path';
import { Database } from './database';
import { TelegramBot } from './telegram';
import { log } from './utils';

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
  private logFilePath: string;
  private diagnosticsLogPath: string;
  private errorPatterns: Map<string, DiagnosticResult> = new Map();

  constructor(database: Database, telegram: TelegramBot) {
    this.database = database;
    this.telegram = telegram;
    this.logFilePath = path.join(process.cwd(), 'telegram.log');
    this.diagnosticsLogPath = path.join(process.cwd(), 'diagnostics.log');
    
    this.initializeErrorPatterns();
    log('🔧 Diagnostics system initialized');
  }

  private initializeErrorPatterns(): void {
    this.errorPatterns.set('token_mint', {
      issue: 'DATABASE_SCHEMA_MISMATCH',
      severity: 'CRITICAL',
      description: 'Code trying to access non-existent column "token_mint" - should be "mint"',
      autoFix: this.fixTokenMintIssue.bind(this),
      solution: 'Update database queries to use "mint" instead of "token_mint"'
    });
    
    this.errorPatterns.set('Connection terminated', {
      issue: 'TELEGRAM_CONNECTION_ERROR',
      severity: 'MEDIUM',
      description: 'Telegram API connection issues',
      solution: 'Retry with exponential backoff, check network connectivity'
    });
    
    this.errorPatterns.set('COULD_NOT_FIND_ANY_ROUTE', {
      issue: 'JUPITER_ROUTING_ERROR',
      severity: 'LOW',
      description: 'Jupiter API cannot find swap route for token',
      solution: 'Skip token or retry later when liquidity improves'
    });
    
        this.errorPatterns.set('Database pool error', {
      issue: 'DATABASE_CONNECTION_ERROR',
      severity: 'HIGH',
      description: 'PostgreSQL connection pool errors',
      autoFix: this.fixDatabaseConnection.bind(this),
      solution: 'Restart database connection pool'
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
      const telegramIssues = await this.analyzeTelegramLogs();
      issues.push(...telegramIssues);

      // 2. Проверка базы данных
      const dbIssues = await this.checkDatabaseHealth();
      issues.push(...dbIssues);

      // 3. Анализ частоты ошибок
      const errorRateIssues = await this.analyzeErrorPatterns();
      issues.push(...errorRateIssues);

      // 4. Проверка системных ресурсов
      const systemIssues = await this.checkSystemResources();
      issues.push(...systemIssues);

    } catch (error) {
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
    await this.logDiagnostics(health);

    // Автоисправления
    await this.attemptAutoFixes(issues);

    log(`🔍 Diagnostics completed in ${health.metrics.uptime}s, found ${issues.length} issues`);
    
    return health;
  }

  /**
   * Анализ логов Telegram на предмет ошибок
   */
  private async analyzeTelegramLogs(): Promise<DiagnosticResult[]> {
    const issues: DiagnosticResult[] = [];

    try {
      if (!fs.existsSync(this.logFilePath)) {
        return issues;
      }

      const content = fs.readFileSync(this.logFilePath, 'utf8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      
      // Анализируем последние 100 записей
      const recentLines = lines.slice(-100);
      const errorLines = recentLines.filter(line => line.includes('[ERROR]'));

      for (const errorLine of errorLines) {
        for (const [pattern, diagnostic] of this.errorPatterns) {
          if (errorLine.includes(pattern)) {
            // Считаем частоту этой ошибки
            const occurrences = errorLines.filter(line => line.includes(pattern)).length;
            
            const issue: DiagnosticResult = {
              ...diagnostic,
              description: `${diagnostic.description} (${occurrences} occurrences in last 100 logs)`
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
      log(`Error analyzing telegram logs: ${error}`, 'ERROR');
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
      
      // Проверяем структуру таблицы и исправляем
      await (this.database as any).pool.query(`
        ALTER TABLE signals RENAME COLUMN token_mint TO mint;
      `);
      
      log('✅ Successfully renamed token_mint to mint');
      return true;
    } catch (error) {
      log(`❌ Failed to fix token_mint issue: ${error}`, 'ERROR');
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
   * Попытка автоисправлений
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
      fs.appendFileSync(
        this.diagnosticsLogPath, 
        JSON.stringify(logEntry) + '\n', 
        'utf8'
      );
    } catch (error) {
      log(`Failed to write diagnostics log: ${error}`, 'ERROR');
    }
  }
} 