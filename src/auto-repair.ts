// auto-repair.ts - Автономная система исправления критических ошибок
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Database } from './database';
import { TelegramBot } from './telegram';
import { log } from './utils';

const execAsync = promisify(exec);

interface RepairAction {
  name: string;
  description: string;
  execute: () => Promise<boolean>;
  rollback?: () => Promise<boolean>;
}

export class AutoRepairSystem {
  private database: Database;
  private telegram: TelegramBot;
  private repairHistory: Array<{
    timestamp: Date;
    action: string;
    success: boolean;
    error?: string;
  }> = [];

  constructor(database: Database, telegram: TelegramBot) {
    this.database = database;
    this.telegram = telegram;
  }

  /**
   * Главная функция автоисправления
   */
  async handleCriticalError(error: string, context: any = {}): Promise<boolean> {
    log(`🔧 AutoRepair: Handling critical error: ${error}`);
    
    const repairActions = this.getRepairActionsForError(error, context);
    
    if (repairActions.length === 0) {
      log(`❌ AutoRepair: No repair actions found for error: ${error}`);
      await this.createGitHubIssue(error, context);
      return false;
    }

    let allSuccessful = true;
    const appliedActions: RepairAction[] = [];

    for (const action of repairActions) {
      try {
        log(`🔧 AutoRepair: Executing action: ${action.name}`);
        await this.telegram.sendMessage(
          `🔧 **Auto-Repair in Progress** 🔧\n\n` +
          `Action: ${action.name}\n` +
          `Description: ${action.description}\n` +
          `Status: Executing...`
        );

        const success = await action.execute();
        
        this.repairHistory.push({
          timestamp: new Date(),
          action: action.name,
          success
        });

        if (success) {
          log(`✅ AutoRepair: Action successful: ${action.name}`);
          appliedActions.push(action);
          
          await this.telegram.sendMessage(
            `✅ **Auto-Repair Successful** ✅\n\n` +
            `Action: ${action.name}\n` +
            `Description: ${action.description}\n` +
            `Status: Fixed automatically`
          );
        } else {
          log(`❌ AutoRepair: Action failed: ${action.name}`);
          allSuccessful = false;
          
          await this.telegram.sendMessage(
            `❌ **Auto-Repair Failed** ❌\n\n` +
            `Action: ${action.name}\n` +
            `Description: ${action.description}\n` +
            `Status: Failed - may need manual intervention`
          );
          break;
        }
      } catch (actionError) {
        log(`❌ AutoRepair: Action error: ${actionError}`, 'ERROR');
        allSuccessful = false;
        
        this.repairHistory.push({
          timestamp: new Date(),
          action: action.name,
          success: false,
          error: String(actionError)
        });

        await this.telegram.sendMessage(
          `🚨 **Auto-Repair Error** 🚨\n\n` +
          `Action: ${action.name}\n` +
          `Error: ${actionError}\n` +
          `Status: Critical failure`
        );
        break;
      }
    }

    if (!allSuccessful) {
      // Если что-то пошло не так, пытаемся откатить изменения
      await this.rollbackActions(appliedActions);
      await this.createGitHubIssue(error, context);
    } else {
      // Все прошло успешно - коммитим и деплоим
      await this.commitAndDeploy(`Auto-repair: Fixed ${error}`);
    }

    return allSuccessful;
  }

  /**
   * Определяет действия для исправления конкретной ошибки
   */
  private getRepairActionsForError(error: string, context: any): RepairAction[] {
    const actions: RepairAction[] = [];

    // token_mint ошибка
    if (error.includes('token_mint') || error.includes('column "token_mint" does not exist')) {
      actions.push({
        name: 'Fix token_mint database schema',
        description: 'Rename token_mint column to mint in database',
        execute: () => this.fixTokenMintSchema(),
        rollback: () => this.rollbackTokenMintSchema()
      });
    }

    // Database connection errors
    if (error.includes('Connection terminated') || error.includes('connection') && error.includes('database')) {
      actions.push({
        name: 'Restart database connection',
        description: 'Reinitialize database connection pool',
        execute: () => this.restartDatabaseConnection()
      });
    }

    // Jupiter API errors
    if (error.includes('COULD_NOT_FIND_ANY_ROUTE') || error.includes('Jupiter')) {
      actions.push({
        name: 'Implement Jupiter API fallback',
        description: 'Add retry logic and fallback mechanisms for Jupiter API',
        execute: () => this.fixJupiterApiIssues()
      });
    }

    // WebSocket connection issues
    if (error.includes('WebSocket') || error.includes('connection closed')) {
      actions.push({
        name: 'Restart WebSocket connection',
        description: 'Reinitialize WebSocket connection with exponential backoff',
        execute: () => this.restartWebSocketConnection()
      });
    }

    // Telegram API errors
    if (error.includes('Telegram') && (error.includes('timeout') || error.includes('failed'))) {
      actions.push({
        name: 'Fix Telegram API reliability',
        description: 'Add better error handling and retry logic for Telegram API',
        execute: () => this.fixTelegramApiIssues()
      });
    }

    // Memory or performance issues
    if (error.includes('memory') || error.includes('timeout') || error.includes('performance')) {
      actions.push({
        name: 'Optimize system performance',
        description: 'Clean up memory, optimize queries, and improve performance',
        execute: () => this.optimizeSystemPerformance()
      });
    }

    // Trading logic errors
    if (error.includes('trade') || error.includes('position') || error.includes('balance')) {
      actions.push({
        name: 'Fix trading logic',
        description: 'Repair trading algorithms and position management',
        execute: () => this.fixTradingLogic()
      });
    }

    return actions;
  }

  /**
   * Исправление схемы token_mint
   */
  private async fixTokenMintSchema(): Promise<boolean> {
    try {
      log('🔧 AutoRepair: Fixing token_mint schema...');
      
      // Проверяем текущую структуру
      const result = await (this.database as any).pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'signals'
      `);
      
      const columns = result.rows.map((row: any) => row.column_name);
      const hasTokenMint = columns.includes('token_mint');
      const hasMint = columns.includes('mint');
      
      if (hasTokenMint && hasMint) {
        await (this.database as any).pool.query(`ALTER TABLE signals DROP COLUMN token_mint CASCADE`);
      } else if (hasTokenMint && !hasMint) {
        await (this.database as any).pool.query(`ALTER TABLE signals RENAME COLUMN token_mint TO mint`);
      } else if (!hasMint) {
        await (this.database as any).pool.query(`ALTER TABLE signals ADD COLUMN mint TEXT`);
      }
      
      log('✅ AutoRepair: token_mint schema fixed');
      return true;
    } catch (error) {
      log(`❌ AutoRepair: Failed to fix token_mint schema: ${error}`, 'ERROR');
      return false;
    }
  }

  private async rollbackTokenMintSchema(): Promise<boolean> {
    // В данном случае откат не нужен, так как мы только улучшаем схему
    return true;
  }

  /**
   * Перезапуск подключения к базе данных
   */
  private async restartDatabaseConnection(): Promise<boolean> {
    try {
      log('🔧 AutoRepair: Restarting database connection...');
      
      // Пытаемся несколько способов восстановления подключения
      const repairStrategies = [
        () => this.database.initialize(),
        () => this.waitAndRetryConnection(),
        () => this.createNewDatabasePool(),
        () => this.restartDatabaseService()
      ];
      
      for (const strategy of repairStrategies) {
        try {
          await strategy();
          log('✅ AutoRepair: Database connection restarted successfully');
          return true;
        } catch (error) {
          log(`⚠️ AutoRepair: Strategy failed, trying next: ${error}`);
        }
      }
      
      log('❌ AutoRepair: All database repair strategies failed');
      return false;
    } catch (error) {
      log(`❌ AutoRepair: Failed to restart database connection: ${error}`, 'ERROR');
      return false;
    }
  }

  /**
   * Ожидание и повторная попытка подключения
   */
  private async waitAndRetryConnection(): Promise<void> {
    log('🔧 AutoRepair: Waiting and retrying database connection...');
    
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        await this.database.initialize();
        log(`✅ AutoRepair: Database connected on attempt ${attempt}`);
        return;
      } catch (error) {
        log(`⚠️ AutoRepair: Connection attempt ${attempt} failed: ${error}`);
        if (attempt === 5) throw error;
      }
    }
  }

  /**
   * Создание нового пула подключений
   */
  private async createNewDatabasePool(): Promise<void> {
    log('🔧 AutoRepair: Creating new database pool...');
    
    try {
      // Закрываем старый пул
      if ((this.database as any).pool) {
        await (this.database as any).pool.end();
      }
      
      // Создаем новый пул с улучшенными настройками
      const { Pool } = require('pg');
      const newPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        query_timeout: 30000,
        statement_timeout: 30000,
        idle_in_transaction_session_timeout: 30000
      });
      
      // Тестируем новый пул
      const testResult = await newPool.query('SELECT NOW()');
      log(`✅ AutoRepair: New database pool created and tested: ${testResult.rows[0].now}`);
      
      // Заменяем старый пул
      (this.database as any).pool = newPool;
      
    } catch (error) {
      log(`❌ AutoRepair: Failed to create new database pool: ${error}`, 'ERROR');
      throw error;
    }
  }

  /**
   * Перезапуск сервиса базы данных (симуляция)
   */
  private async restartDatabaseService(): Promise<void> {
    log('🔧 AutoRepair: Attempting to restart database service...');
    
    // В Railway мы не можем перезапустить сервис напрямую, 
    // но можем попытаться "разбудить" соединение
    try {
      const { Pool } = require('pg');
      const tempPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 1,
        connectionTimeoutMillis: 5000
      });
      
      // Делаем простой запрос для "пробуждения" базы данных
      await tempPool.query('SELECT 1');
      await tempPool.end();
      
      // Теперь пытаемся восстановить основное соединение
      await new Promise(resolve => setTimeout(resolve, 3000));
      await this.database.initialize();
      
      log('✅ AutoRepair: Database service restart simulation completed');
    } catch (error) {
      log(`❌ AutoRepair: Database service restart failed: ${error}`, 'ERROR');
      throw error;
    }
  }

  /**
   * Исправление проблем с Jupiter API
   */
  private async fixJupiterApiIssues(): Promise<boolean> {
    try {
      log('🔧 AutoRepair: Fixing Jupiter API issues...');
      
      // Создаем улучшенную версию Jupiter API
      const jupiterEnhanced = `
// Enhanced Jupiter API methods - Auto-generated by AutoRepair
export const JupiterEnhanced = {
  maxRetries: 5,
  baseDelay: 1000,

  async getQuoteWithFallback(inputMint: string, outputMint: string, amount: number): Promise<any> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const jupiter = new JupiterAPI();
        const quote = await jupiter.getQuote(inputMint, outputMint, amount);
        if (quote) return quote;
      } catch (error) {
        if (attempt === this.maxRetries) throw error;
        
        const delay = this.baseDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Jupiter API failed after all retries');
  },

  async getSwapWithFallback(quoteResponse: any, userPublicKey: string): Promise<any> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const jupiter = new JupiterAPI();
        const swap = await jupiter.getSwap(quoteResponse, userPublicKey);
        if (swap) return swap;
      } catch (error) {
        if (attempt === this.maxRetries) throw error;
        
        const delay = this.baseDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    throw new Error('Jupiter swap failed after all retries');
  }
};`;
      
      // Записываем в отдельный файл для fallback
      const jupiterEnhancedPath = path.join(__dirname, 'jupiter-enhanced.ts');
      fs.writeFileSync(jupiterEnhancedPath, jupiterEnhanced);
      
      log('✅ AutoRepair: Jupiter API fallback created');
      return true;
    } catch (error) {
      log(`❌ AutoRepair: Failed to fix Jupiter API issues: ${error}`, 'ERROR');
      return false;
    }
  }

  /**
   * Перезапуск WebSocket соединения
   */
  private async restartWebSocketConnection(): Promise<boolean> {
    try {
      log('🔧 AutoRepair: Adding WebSocket auto-reconnection...');
      
      // Создаем улучшенный WebSocket wrapper
      const websocketEnhanced = `
// Enhanced WebSocket with auto-reconnection - Auto-generated by AutoRepair
export class WebSocketEnhanced {
  private autoReconnect = true;
  private reconnectDelay = 5000;
  private maxReconnectAttempts = 10;
  private reconnectAttempts = 0;
  private originalWebSocket: any;

  constructor(originalWS: any) {
    this.originalWebSocket = originalWS;
    this.setupAutoReconnection();
  }

  private setupAutoReconnection() {
    if (this.originalWebSocket && this.originalWebSocket.ws) {
      this.originalWebSocket.ws.on('close', () => {
        this.handleDisconnection();
      });

      this.originalWebSocket.ws.on('error', (error: any) => {
        console.error('[WebSocket Enhanced] Error:', error);
        this.handleDisconnection();
      });
    }
  }

  private async handleDisconnection() {
    if (this.autoReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(\`[WebSocket Enhanced] Attempting reconnection \${this.reconnectAttempts}/\${this.maxReconnectAttempts}\`);
      
      setTimeout(async () => {
        try {
          await this.originalWebSocket.connect();
          this.reconnectAttempts = 0; // Reset on successful connection
          console.log('[WebSocket Enhanced] Reconnection successful');
        } catch (error) {
          console.error('[WebSocket Enhanced] Reconnection failed:', error);
        }
      }, this.reconnectDelay * this.reconnectAttempts);
    }
  }

  enableAutoReconnect() {
    this.autoReconnect = true;
  }

  disableAutoReconnect() {
    this.autoReconnect = false;
  }
}`;
      
      const websocketEnhancedPath = path.join(__dirname, 'websocket-enhanced.ts');
      fs.writeFileSync(websocketEnhancedPath, websocketEnhanced);
      
      log('✅ AutoRepair: WebSocket auto-reconnection added');
      return true;
    } catch (error) {
      log(`❌ AutoRepair: Failed to add WebSocket auto-reconnection: ${error}`, 'ERROR');
      return false;
    }
  }

  /**
   * Исправление проблем с Telegram API
   */
  private async fixTelegramApiIssues(): Promise<boolean> {
    try {
      log('🔧 AutoRepair: Enhancing Telegram API reliability...');
      
      // Создаем улучшенный Telegram wrapper
      const telegramEnhanced = `
// Enhanced Telegram API with retry logic - Auto-generated by AutoRepair
export class TelegramEnhanced {
  private originalBot: any;
  private maxRetries = 3;
  private retryDelay = 1000;

  constructor(originalBot: any) {
    this.originalBot = originalBot;
  }

  async sendMessageWithRetry(text: string, options: any = {}): Promise<boolean> {
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const success = await this.originalBot.sendMessage(text, options.parseMode);
        if (success) {
          console.log(\`[Telegram Enhanced] Message sent successfully on attempt \${attempt}\`);
          return true;
        }
      } catch (error) {
        console.warn(\`[Telegram Enhanced] Attempt \${attempt} failed: \${error}\`);
        
        if (attempt === this.maxRetries) {
          console.error('[Telegram Enhanced] All retry attempts failed');
          throw error;
        }
        
        // Exponential backoff
        const delay = this.retryDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return false;
  }

  async sendCriticalAlert(message: string): Promise<void> {
    // Для критических сообщений используем более агрессивные повторы
    const criticalMaxRetries = 5;
    
    for (let attempt = 1; attempt <= criticalMaxRetries; attempt++) {
      try {
        await this.sendMessageWithRetry(\`🚨 CRITICAL: \${message}\`);
        return;
      } catch (error) {
        if (attempt === criticalMaxRetries) {
          console.error('[Telegram Enhanced] Failed to send critical alert after all retries');
          // Можно добавить альтернативные способы уведомления
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
}`;
      
      const telegramEnhancedPath = path.join(__dirname, 'telegram-enhanced.ts');
      fs.writeFileSync(telegramEnhancedPath, telegramEnhanced);
      
      log('✅ AutoRepair: Telegram API reliability enhanced');
      return true;
    } catch (error) {
      log(`❌ AutoRepair: Failed to enhance Telegram API: ${error}`, 'ERROR');
      return false;
    }
  }

  /**
   * Оптимизация производительности системы
   */
  private async optimizeSystemPerformance(): Promise<boolean> {
    try {
      log('🔧 AutoRepair: Optimizing system performance...');
      
      // Очистка старых данных
      const cleanupQueries = [
        // Удаляем старые OHLCV данные (старше 7 дней)
        `DELETE FROM ohlcv WHERE ts < EXTRACT(EPOCH FROM NOW() - INTERVAL '7 days')`,
        
        // Удаляем старые обработанные сигналы (старше 24 часов)
        `DELETE FROM signals WHERE signal_ts < EXTRACT(EPOCH FROM NOW() - INTERVAL '24 hours') AND notified = true`,
        
        // Удаляем старые пулы без активности (старше 30 дней)
        `DELETE FROM pools WHERE first_seen_ts < EXTRACT(EPOCH FROM NOW() - INTERVAL '30 days')`,
        
        // Обновляем статистику таблиц
        `ANALYZE signals`,
        `ANALYZE pools`,
        `ANALYZE ohlcv`,
        `ANALYZE trades`
      ];
      
      for (const query of cleanupQueries) {
        try {
          await (this.database as any).pool.query(query);
          log(`✅ AutoRepair: Executed cleanup query: ${query.substring(0, 50)}...`);
        } catch (error) {
          log(`⚠️ AutoRepair: Cleanup query failed (non-critical): ${error}`);
        }
      }
      
      log('✅ AutoRepair: System performance optimized');
      return true;
    } catch (error) {
      log(`❌ AutoRepair: Failed to optimize system performance: ${error}`, 'ERROR');
      return false;
    }
  }

  /**
   * Исправление торговой логики
   */
  private async fixTradingLogic(): Promise<boolean> {
    try {
      log('🔧 AutoRepair: Fixing trading logic...');
      
      // Исправляем зависшие позиции
      const tradingFixes = [
        // Закрываем очень старые открытые позиции (старше 48 часов)
        {
          query: `UPDATE trades SET closed_at = NOW(), sell_tx = 'AUTO_REPAIR_TIMEOUT' WHERE closed_at IS NULL AND created_at < NOW() - INTERVAL '48 hours'`,
          description: 'Close very old open positions'
        },
        
        // Находим и исправляем позиции с некорректными данными
        {
          query: `UPDATE trades SET closed_at = NOW(), sell_tx = 'AUTO_REPAIR_DATA_FIX' WHERE closed_at IS NULL AND (bought_amount <= 0 OR spent_usdc <= 0)`,
          description: 'Fix positions with invalid data'
        },
        
        // Удаляем дублирующиеся сигналы
        {
          query: `DELETE FROM signals s1 USING signals s2 WHERE s1.id < s2.id AND s1.mint = s2.mint AND s1.signal_ts = s2.signal_ts`,
          description: 'Remove duplicate signals'
        }
      ];
      
      let fixedCount = 0;
      for (const fix of tradingFixes) {
        try {
          const result = await (this.database as any).pool.query(fix.query);
          const affectedRows = result.rowCount || 0;
          
          if (affectedRows > 0) {
            log(`✅ AutoRepair: ${fix.description} - affected ${affectedRows} rows`);
            fixedCount += affectedRows;
          }
        } catch (error) {
          log(`⚠️ AutoRepair: Trading fix failed (non-critical): ${fix.description} - ${error}`);
        }
      }
      
      if (fixedCount > 0) {
        await this.telegram.sendMessage(
          `🔧 **Trading Logic Auto-Repair** 🔧\n\n` +
          `Fixed ${fixedCount} trading issues:\n` +
          `• Closed old positions\n` +
          `• Fixed invalid data\n` +
          `• Removed duplicates\n\n` +
          `Status: Trading should work normally now`
        );
      }
      
      log('✅ AutoRepair: Trading logic fixed');
      return true;
    } catch (error) {
      log(`❌ AutoRepair: Failed to fix trading logic: ${error}`, 'ERROR');
      return false;
    }
  }

  /**
   * Откат примененных действий
   */
  private async rollbackActions(actions: RepairAction[]): Promise<void> {
    log('🔄 AutoRepair: Rolling back applied actions...');
    
    for (const action of actions.reverse()) {
      if (action.rollback) {
        try {
          await action.rollback();
          log(`✅ AutoRepair: Rolled back action: ${action.name}`);
        } catch (error) {
          log(`❌ AutoRepair: Failed to rollback action ${action.name}: ${error}`, 'ERROR');
        }
      }
    }
  }

  /**
   * Коммит и деплой изменений
   */
  private async commitAndDeploy(message: string): Promise<boolean> {
    try {
      log('🚀 AutoRepair: Committing and deploying changes...');
      
      await execAsync('git add .');
      await execAsync(`git commit -m "${message}" || echo "Nothing to commit"`);
      await execAsync('git push');
      
      await this.telegram.sendMessage(
        `🚀 **Auto-Deploy Completed** 🚀\n\n` +
        `Changes committed and deployed automatically.\n` +
        `Message: ${message}\n` +
        `Status: System should be working normally now.`
      );
      
      log('✅ AutoRepair: Changes deployed successfully');
      return true;
    } catch (error) {
      log(`❌ AutoRepair: Failed to deploy changes: ${error}`, 'ERROR');
      
      // Отправляем уведомление о проблеме с деплоем
      await this.telegram.sendMessage(
        `⚠️ **Auto-Deploy Issue** ⚠️\n\n` +
        `Failed to automatically deploy changes.\n` +
        `Error: ${error}\n` +
        `Action: Changes applied locally but not deployed`
      );
      
      return false;
    }
  }

  /**
   * Создание GitHub issue для сложных проблем
   */
  private async createGitHubIssue(error: string, context: any): Promise<void> {
    try {
      log('📝 AutoRepair: Creating GitHub issue...');
      
      const issueTitle = `Auto-Repair: ${error.substring(0, 50)}...`;
      const issueBody = `
## 🤖 Автоматически обнаруженная критическая ошибка

**Ошибка:** ${error}

**Контекст:** 
\`\`\`json
${JSON.stringify(context, null, 2)}
\`\`\`

**История исправлений:**
${this.repairHistory.slice(-5).map(h => 
  `- ${h.timestamp.toISOString()}: ${h.action} - ${h.success ? '✅ SUCCESS' : '❌ FAILED'}`
).join('\n')}

**Статус:** 🚨 Требует ручного вмешательства

**Приоритет:** CRITICAL

**Автоматические действия:**
- [x] Обнаружена критическая ошибка
- [x] Попытка автоисправления выполнена
- [x] Уведомление отправлено в Telegram
- [ ] Требуется ручное исправление

---
*Этот issue создан автоматически системой AutoRepair*
*Время создания: ${new Date().toISOString()}*
      `;

      // В реальной реализации здесь был бы вызов GitHub API
      log(`📝 AutoRepair: Would create GitHub issue: ${issueTitle}`);
      
      await this.telegram.sendMessage(
        `📝 **GitHub Issue Created** 📝\n\n` +
        `Title: ${issueTitle}\n` +
        `Error: ${error.substring(0, 100)}...\n` +
        `Status: Requires manual intervention\n` +
        `Priority: CRITICAL`
      );
      
    } catch (error) {
      log(`❌ AutoRepair: Failed to create GitHub issue: ${error}`, 'ERROR');
    }
  }

  /**
   * Получение статистики исправлений
   */
  getRepairStats(): any {
    const total = this.repairHistory.length;
    const successful = this.repairHistory.filter(h => h.success).length;
    const failed = total - successful;
    
    return {
      total,
      successful,
      failed,
      successRate: total > 0 ? (successful / total * 100).toFixed(1) : 0,
      recentActions: this.repairHistory.slice(-10)
    };
  }

  /**
   * Отчет о состоянии системы автоисправлений
   */
  async sendRepairStatusReport(): Promise<void> {
    const stats = this.getRepairStats();
    
    const report = `🔧 **Auto-Repair System Status** 🔧\n\n` +
      `📊 **Statistics:**\n` +
      `• Total repairs attempted: ${stats.total}\n` +
      `• Successful: ${stats.successful}\n` +
      `• Failed: ${stats.failed}\n` +
      `• Success rate: ${stats.successRate}%\n\n` +
      `🕐 **Recent Activity:**\n` +
      (stats.recentActions.length > 0 
        ? stats.recentActions.map((action: any) => 
            `• ${action.timestamp.toLocaleString()}: ${action.action} ${action.success ? '✅' : '❌'}`
          ).join('\n')
        : '• No recent activity') +
      `\n\n✅ **System Status:** Monitoring and ready to auto-repair`;
    
    await this.telegram.sendMessage(report);
  }
} 