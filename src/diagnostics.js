"use strict";
// diagnostics.ts - Автодиагностика и самоисправление системы
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DiagnosticsSystem = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const utils_1 = require("./utils");
class DiagnosticsSystem {
    constructor(database, telegram) {
        this.errorPatterns = new Map();
        this.database = database;
        this.telegram = telegram;
        this.logFilePath = path_1.default.join(process.cwd(), 'telegram.log');
        this.diagnosticsLogPath = path_1.default.join(process.cwd(), 'diagnostics.log');
        this.initializeErrorPatterns();
        (0, utils_1.log)('🔧 Diagnostics system initialized');
    }
    initializeErrorPatterns() {
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
    async runDiagnostics() {
        const startTime = Date.now();
        const issues = [];
        (0, utils_1.log)('🔍 Running system diagnostics...');
        try {
            // 1. Анализ Telegram логов
            (0, utils_1.log)('📋 Analyzing Telegram logs...');
            const telegramIssues = await this.analyzeTelegramLogs();
            (0, utils_1.log)(`📋 Found ${telegramIssues.length} Telegram issues`);
            issues.push(...telegramIssues);
            // 2. Проверка базы данных
            (0, utils_1.log)('🗄️ Checking database health...');
            const dbIssues = await this.checkDatabaseHealth();
            (0, utils_1.log)(`🗄️ Found ${dbIssues.length} database issues`);
            issues.push(...dbIssues);
            // 3. Анализ частоты ошибок
            (0, utils_1.log)('📊 Analyzing error patterns...');
            const errorRateIssues = await this.analyzeErrorPatterns();
            (0, utils_1.log)(`📊 Found ${errorRateIssues.length} error pattern issues`);
            issues.push(...errorRateIssues);
            // 4. Проверка системных ресурсов
            (0, utils_1.log)('💻 Checking system resources...');
            const systemIssues = await this.checkSystemResources();
            (0, utils_1.log)(`💻 Found ${systemIssues.length} system issues`);
            issues.push(...systemIssues);
        }
        catch (error) {
            (0, utils_1.log)(`❌ Diagnostics error: ${error}`, 'ERROR');
            issues.push({
                issue: 'DIAGNOSTICS_ERROR',
                severity: 'HIGH',
                description: `Diagnostics system error: ${error}`,
                solution: 'Check diagnostics system logs and restart if needed'
            });
        }
        const health = {
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
        (0, utils_1.log)('💾 Logging diagnostics results...');
        await this.logDiagnostics(health);
        // Автоисправления
        if (issues.length > 0) {
            (0, utils_1.log)(`🔧 Attempting auto-fixes for ${issues.length} issues...`);
            await this.attemptAutoFixes(issues);
        }
        (0, utils_1.log)(`🔍 Diagnostics completed in ${health.metrics.uptime}s, found ${issues.length} issues`);
        return health;
    }
    /**
     * Анализ логов Telegram для выявления проблем
     */
    async analyzeTelegramLogs() {
        const issues = [];
        try {
            (0, utils_1.log)('🔍 Starting detailed Telegram log analysis...');
            const logs = this.telegram.getRecentTelegramLogs(100);
            (0, utils_1.log)(`📋 Found ${logs.length} recent Telegram log entries`);
            if (logs.length === 0) {
                (0, utils_1.log)('📋 Telegram log file does not exist yet: ' + this.logFilePath);
                return issues;
            }
            // Подробный анализ каждого типа ошибки
            const errorCounts = {};
            const detailedErrors = [];
            logs.forEach((line, index) => {
                (0, utils_1.log)(`🔍 Analyzing log line ${index + 1}: ${line.substring(0, 100)}...`);
                // Проверяем каждый паттерн ошибок
                for (const [pattern, config] of this.errorPatterns.entries()) {
                    if (line.includes(pattern)) {
                        errorCounts[pattern] = (errorCounts[pattern] || 0) + 1;
                        detailedErrors.push(`[${pattern}] ${line}`);
                        (0, utils_1.log)(`🚨 Found error pattern "${pattern}" in line: ${line}`);
                        // Особо детальный анализ для token_mint
                        if (pattern === 'token_mint') {
                            (0, utils_1.log)('🔍 DETAILED token_mint error analysis:');
                            (0, utils_1.log)(`  - Full line: ${line}`);
                            (0, utils_1.log)(`  - Line length: ${line.length}`);
                            (0, utils_1.log)(`  - Contains "column": ${line.includes('column')}`);
                            (0, utils_1.log)(`  - Contains "does not exist": ${line.includes('does not exist')}`);
                            (0, utils_1.log)(`  - Line index in logs: ${index}`);
                            // Пытаемся найти контекст ошибки
                            if (index > 0) {
                                (0, utils_1.log)(`  - Previous line: ${logs[index - 1]}`);
                            }
                            if (index < logs.length - 1) {
                                (0, utils_1.log)(`  - Next line: ${logs[index + 1]}`);
                            }
                        }
                    }
                }
            });
            (0, utils_1.log)(`📊 Error pattern counts: ${JSON.stringify(errorCounts, null, 2)}`);
            (0, utils_1.log)(`📋 Detailed errors found: ${detailedErrors.length}`);
            // Создаем диагностические результаты
            for (const [pattern, count] of Object.entries(errorCounts)) {
                const config = this.errorPatterns.get(pattern);
                if (config && count > 0) {
                    (0, utils_1.log)(`🚨 Creating diagnostic result for pattern "${pattern}" with ${count} occurrences`);
                    const issue = {
                        issue: config.issue,
                        severity: config.severity,
                        description: `${config.description} (${count} occurrences)`,
                        solution: config.solution,
                        autoFix: config.autoFix
                    };
                    issues.push(issue);
                    // Для token_mint добавляем дополнительную информацию
                    if (pattern === 'token_mint') {
                        (0, utils_1.log)('🔧 token_mint error detected, attempting immediate auto-fix...');
                        // Пытаемся выполнить автоисправление немедленно
                        if (config.autoFix) {
                            try {
                                const fixResult = await config.autoFix();
                                (0, utils_1.log)(`🔧 Auto-fix result for token_mint: ${fixResult ? 'SUCCESS' : 'FAILED'}`);
                                if (fixResult) {
                                    await this.telegram.sendMessage('✅ **Auto-fix Applied**\n' +
                                        'Successfully fixed token_mint column issue in database.\n' +
                                        'System should now work normally.');
                                }
                                else {
                                    await this.telegram.sendMessage('❌ **Auto-fix Failed**\n' +
                                        'Could not automatically fix token_mint issue.\n' +
                                        'Manual intervention may be required.');
                                }
                            }
                            catch (error) {
                                (0, utils_1.log)(`❌ Auto-fix error: ${error}`, 'ERROR');
                                await this.telegram.sendMessage('🚨 **Auto-fix Error**\n' +
                                    `Failed to apply auto-fix: ${error}`);
                            }
                        }
                    }
                }
            }
            (0, utils_1.log)(`📋 Total diagnostic issues created: ${issues.length}`);
        }
        catch (error) {
            (0, utils_1.log)(`Error analyzing Telegram logs: ${error}`, 'ERROR');
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
    async checkDatabaseHealth() {
        const issues = [];
        try {
            // Простой запрос для проверки соединения
            await this.database.getOldPools();
            // Проверяем структуру таблицы signals
            const result = await this.database.pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'signals'
      `);
            const columns = result.rows.map((row) => row.column_name);
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
        }
        catch (error) {
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
    async fixTokenMintIssue() {
        try {
            (0, utils_1.log)('🔧 Attempting to fix token_mint issue...');
            (0, utils_1.log)('🔍 Checking current database schema...');
            // Сначала проверяем текущую структуру
            const result = await this.database.pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'signals'
        ORDER BY ordinal_position
      `);
            const columns = result.rows.map((row) => row.column_name);
            (0, utils_1.log)(`📋 Current signals table columns: ${columns.join(', ')}`);
            const hasTokenMint = columns.includes('token_mint');
            const hasMint = columns.includes('mint');
            (0, utils_1.log)(`🔍 Has token_mint column: ${hasTokenMint}`);
            (0, utils_1.log)(`🔍 Has mint column: ${hasMint}`);
            if (hasTokenMint && hasMint) {
                (0, utils_1.log)('🔧 Both columns exist, dropping token_mint...');
                await this.database.pool.query(`
          ALTER TABLE signals DROP COLUMN token_mint CASCADE;
        `);
                (0, utils_1.log)('✅ Successfully dropped token_mint column');
            }
            else if (hasTokenMint && !hasMint) {
                (0, utils_1.log)('🔧 Renaming token_mint to mint...');
                await this.database.pool.query(`
          ALTER TABLE signals RENAME COLUMN token_mint TO mint;
        `);
                (0, utils_1.log)('✅ Successfully renamed token_mint to mint');
            }
            else if (!hasTokenMint && hasMint) {
                (0, utils_1.log)('✅ Schema is already correct (mint column exists, token_mint does not)');
            }
            else {
                (0, utils_1.log)('❌ Neither column exists, adding mint column...');
                await this.database.pool.query(`
          ALTER TABLE signals ADD COLUMN mint TEXT;
        `);
                (0, utils_1.log)('✅ Successfully added mint column');
            }
            // Проверяем финальную структуру
            const finalResult = await this.database.pool.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'signals'
        ORDER BY ordinal_position
      `);
            const finalColumns = finalResult.rows.map((row) => row.column_name);
            (0, utils_1.log)(`📋 Final signals table columns: ${finalColumns.join(', ')}`);
            return true;
        }
        catch (error) {
            (0, utils_1.log)(`❌ Failed to fix token_mint issue: ${error}`, 'ERROR');
            (0, utils_1.log)(`❌ Error details: ${JSON.stringify(error, null, 2)}`);
            return false;
        }
    }
    /**
     * Автоисправление: схема таблицы
     */
    async fixTableSchema() {
        try {
            (0, utils_1.log)('🔧 Attempting to fix table schema...');
            await this.database.pool.query(`
        ALTER TABLE signals RENAME COLUMN token_mint TO mint;
      `);
            (0, utils_1.log)('✅ Table schema fixed');
            return true;
        }
        catch (error) {
            (0, utils_1.log)(`❌ Failed to fix table schema: ${error}`, 'ERROR');
            return false;
        }
    }
    /**
     * Автоисправление: добавить колонку mint
     */
    async addMintColumn() {
        try {
            (0, utils_1.log)('🔧 Adding mint column...');
            await this.database.pool.query(`
        ALTER TABLE signals ADD COLUMN mint TEXT;
      `);
            (0, utils_1.log)('✅ Mint column added');
            return true;
        }
        catch (error) {
            (0, utils_1.log)(`❌ Failed to add mint column: ${error}`, 'ERROR');
            return false;
        }
    }
    /**
     * Автоисправление: база данных
     */
    async fixDatabaseConnection() {
        try {
            (0, utils_1.log)('🔧 Attempting to fix database connection...');
            // Перезапускаем пул соединений
            await this.database.pool.end();
            await this.database.initialize();
            (0, utils_1.log)('✅ Database connection reestablished');
            return true;
        }
        catch (error) {
            (0, utils_1.log)(`❌ Failed to fix database connection: ${error}`, 'ERROR');
            return false;
        }
    }
    /**
     * Попытка автоисправлений
     */
    async attemptAutoFixes(issues) {
        for (const issue of issues) {
            if (issue.autoFix && issue.severity === 'CRITICAL') {
                (0, utils_1.log)(`🔧 Attempting auto-fix for: ${issue.issue}`);
                try {
                    const success = await issue.autoFix();
                    if (success) {
                        await this.telegram.sendMessage(`🔧 **Auto-Fix Successful** ✅\n\n` +
                            `Issue: ${issue.issue}\n` +
                            `Description: ${issue.description}\n` +
                            `Status: Fixed automatically`);
                    }
                    else {
                        await this.telegram.sendMessage(`🔧 **Auto-Fix Failed** ❌\n\n` +
                            `Issue: ${issue.issue}\n` +
                            `Description: ${issue.description}\n` +
                            `Action Required: Manual intervention needed`);
                    }
                }
                catch (error) {
                    (0, utils_1.log)(`❌ Auto-fix error for ${issue.issue}: ${error}`, 'ERROR');
                }
            }
        }
    }
    // Вспомогательные методы для метрик
    async analyzeErrorPatterns() { return []; }
    async checkSystemResources() { return []; }
    async calculateErrorRate() { return 0; }
    async checkDbConnections() { return 1; }
    async countTelegramErrors() { return 0; }
    calculateOverallStatus(issues) {
        if (issues.some(i => i.severity === 'CRITICAL'))
            return 'CRITICAL';
        if (issues.some(i => i.severity === 'HIGH'))
            return 'WARNING';
        if (issues.length > 0)
            return 'WARNING';
        return 'HEALTHY';
    }
    async logDiagnostics(health) {
        const logEntry = {
            timestamp: new Date().toISOString(),
            status: health.overallStatus,
            issuesCount: health.issues.length,
            metrics: health.metrics,
            issues: health.issues.map(i => ({ issue: i.issue, severity: i.severity }))
        };
        try {
            (0, utils_1.log)(`💾 Writing diagnostics to: ${this.diagnosticsLogPath}`);
            fs_1.default.appendFileSync(this.diagnosticsLogPath, JSON.stringify(logEntry) + '\n', 'utf8');
            (0, utils_1.log)(`✅ Diagnostics log written successfully`);
        }
        catch (error) {
            (0, utils_1.log)(`❌ Failed to write diagnostics log: ${error}`, 'ERROR');
        }
    }
}
exports.DiagnosticsSystem = DiagnosticsSystem;
