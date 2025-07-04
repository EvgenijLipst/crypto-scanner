"use strict";
// telegram.ts - Уведомления в Telegram
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TelegramBot = void 0;
const cross_fetch_1 = __importDefault(require("cross-fetch"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const utils_1 = require("./utils");
class TelegramBot {
    constructor(token, chatId) {
        this.token = token;
        (0, utils_1.log)(`TelegramBot constructor received chatId: "${chatId}" (type: ${typeof chatId}, length: ${chatId?.length})`);
        // Clean and parse chatId more carefully
        const cleanedChatId = chatId.trim().replace(/^[=\s]+/, '');
        (0, utils_1.log)(`Cleaned chatId: "${cleanedChatId}"`);
        const parsedChatId = parseInt(cleanedChatId);
        (0, utils_1.log)(`parseInt("${cleanedChatId}") = ${parsedChatId} (isNaN: ${isNaN(parsedChatId)})`);
        this.chatId = parsedChatId || 0;
        this.baseUrl = `https://api.telegram.org/bot${token}`;
        // Настройка файла логов
        this.logFilePath = path_1.default.join(process.cwd(), 'telegram.log');
        (0, utils_1.log)(`TelegramBot initialized with final chat_id: ${this.chatId}, token: ${token.substring(0, 10)}...`);
        (0, utils_1.log)(`Telegram logs will be saved to: ${this.logFilePath}`);
    }
    /**
     * Логирование сообщения в файл
     */
    logToFile(message, status) {
        try {
            const timestamp = new Date().toISOString();
            const logEntry = `[${timestamp}] [${status}] ${message}\n`;
            fs_1.default.appendFileSync(this.logFilePath, logEntry, 'utf8');
        }
        catch (error) {
            (0, utils_1.log)(`Failed to write to telegram log file: ${error}`, 'ERROR');
        }
    }
    /**
     * Отправить сообщение в Telegram
     */
    async sendMessage(text, parseMode = 'Markdown') {
        try {
            (0, utils_1.log)(`Attempting to send message to chat_id: ${this.chatId} with token: ${this.token.substring(0, 10)}...`);
            const url = `${this.baseUrl}/sendMessage`;
            const payload = {
                chat_id: this.chatId,
                text,
                parse_mode: parseMode,
                disable_web_page_preview: true,
            };
            (0, utils_1.log)(`Payload: ${JSON.stringify(payload)}`);
            // Создаем AbortController для таймаута
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд
            const response = await (0, cross_fetch_1.default)(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                const error = await response.text();
                (0, utils_1.log)(`Telegram API error: ${response.status} ${error}`, 'ERROR');
                this.logToFile(`ERROR: ${response.status} ${error} | Message: ${text}`, 'ERROR');
                return false;
            }
            (0, utils_1.log)('Telegram message sent successfully');
            this.logToFile(text, 'SENT');
            return true;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorName = error instanceof Error ? error.name : 'Unknown';
            if (errorName === 'AbortError' || errorMessage.includes('timeout')) {
                (0, utils_1.log)('Telegram message timeout - network issue, will retry later', 'WARN');
                this.logToFile(`TIMEOUT: ${errorMessage} | Message: ${text}`, 'ERROR');
            }
            else if (errorMessage.includes('Connection terminated')) {
                (0, utils_1.log)('Telegram connection terminated - network issue, will retry later', 'WARN');
                this.logToFile(`CONNECTION_ERROR: ${errorMessage} | Message: ${text}`, 'ERROR');
            }
            else {
                (0, utils_1.log)(`Error sending Telegram message: ${errorMessage}`, 'ERROR');
                this.logToFile(`SEND_ERROR: ${errorMessage} | Message: ${text}`, 'ERROR');
            }
            return false;
        }
    }
    /**
     * Отправить сигнал покупки
     */
    async sendBuySignal(signal, poolInfo, priceImpact) {
        const message = this.formatBuySignal(signal, poolInfo, priceImpact);
        return this.sendMessage(message);
    }
    /**
     * Форматировать сигнал покупки для Telegram
     */
    formatBuySignal(signal, poolInfo, priceImpact) {
        const birdeyeLink = (0, utils_1.createBirdeyeLink)(signal.mint);
        // Объяснение почему этот токен достоин покупки
        const reasons = [];
        if (signal.ema_cross)
            reasons.push('✅ EMA 9/21 пересечение (бычий сигнал)');
        if (signal.vol_spike >= 3)
            reasons.push(`✅ Всплеск объема x${(0, utils_1.formatNumber)(signal.vol_spike, 1)} (высокий интерес)`);
        if (signal.rsi < 35)
            reasons.push(`✅ RSI ${(0, utils_1.formatNumber)(signal.rsi, 1)} (перепроданность)`);
        if (poolInfo.liq_usd >= 10000)
            reasons.push('✅ Достаточная ликвидность (>$10K)');
        if (poolInfo.fdv_usd <= 5000000)
            reasons.push('✅ Разумная оценка (<$5M FDV)');
        return `🚀 **СИГНАЛ ПОКУПКИ** 🚀

🪙 **Токен:** \`${signal.mint}\`

💡 **Почему стоит покупать:**
${reasons.join('\n')}

📊 **Технический анализ:**
• EMA Cross: ${signal.ema_cross ? '✅' : '❌'}
• Volume Spike: x${(0, utils_1.formatNumber)(signal.vol_spike, 1)} ${signal.vol_spike >= 3 ? '✅' : '❌'}
• RSI: ${(0, utils_1.formatNumber)(signal.rsi, 1)} ${signal.rsi < 35 ? '✅' : '❌'}

💰 **Данные пула:**
• Ликвидность: $${(0, utils_1.formatNumber)(poolInfo.liq_usd)}
• FDV: $${(0, utils_1.formatNumber)(poolInfo.fdv_usd)}
• Прайс-импакт: ${(0, utils_1.formatNumber)(priceImpact, 2)}%

🔗 **Ссылки:**
[📊 Birdeye](${birdeyeLink})
[📈 DEXScreener](https://dexscreener.com/solana/${signal.mint})

⏰ ${new Date(signal.signal_ts * 1000).toLocaleString()}`;
    }
    /**
     * Отправить сообщение об ошибке
     */
    async sendErrorMessage(error) {
        const message = `🚨 **Signal Bot Error** 🚨\n\n\`${(0, utils_1.escapeMarkdown)(error)}\``;
        await this.sendMessage(message);
    }
    /**
     * Отправить статистику активности WebSocket
     */
    async sendActivityReport(stats) {
        const statusIcon = stats.isConnected ? '🟢' : '🔴';
        const activityIcon = stats.lastActivityMinutes < 2 ? '🔥' : stats.lastActivityMinutes < 10 ? '⚡' : '⏳';
        const programCount = stats.programNotifications || stats.logsNotifications || 0;
        const message = `${statusIcon} **WebSocket Activity Report** ${activityIcon}

📡 **Connection Status:** ${stats.isConnected ? 'Connected' : 'Disconnected'}
⏱️ **Uptime:** ${stats.uptimeMinutes} минут
🕐 **Last Activity:** ${stats.lastActivityMinutes} минут назад

📊 **Message Details:**
• Total Messages: ${stats.messagesReceived}
• Program Notifications: ${programCount}
• AMM Events Processed: ${stats.swapEventsProcessed}
• Pool Events Found: ${stats.poolEventsProcessed}
• Other Messages: ${stats.otherMessages}
• Errors: ${stats.errorsEncountered}
• Rate: ${stats.messagesPerMinute}/min

${stats.messagesReceived === 0 ? '⚠️ **WARNING**: Нет входящих сообщений!' :
            programCount === 0 ? '⚠️ **WARNING**: Нет program уведомлений!' : '✅ **WebSocket активен**'}

⏰ ${new Date().toLocaleString()}`;
        await this.sendMessage(message);
    }
    /**
     * Получить последние записи из лог-файла Telegram
     */
    getRecentTelegramLogs(limit = 50) {
        try {
            if (!fs_1.default.existsSync(this.logFilePath)) {
                return ['Log file does not exist yet'];
            }
            const content = fs_1.default.readFileSync(this.logFilePath, 'utf8');
            const lines = content.trim().split('\n').filter(line => line.length > 0);
            // Возвращаем последние N строк
            return lines.slice(-limit);
        }
        catch (error) {
            return [`Error reading log file: ${error}`];
        }
    }
    /**
     * Очистить лог-файл Telegram (оставить только последние 1000 записей)
     */
    cleanupTelegramLogs() {
        try {
            if (!fs_1.default.existsSync(this.logFilePath)) {
                return;
            }
            const content = fs_1.default.readFileSync(this.logFilePath, 'utf8');
            const lines = content.trim().split('\n').filter(line => line.length > 0);
            if (lines.length > 1000) {
                const recentLines = lines.slice(-1000);
                fs_1.default.writeFileSync(this.logFilePath, recentLines.join('\n') + '\n', 'utf8');
                (0, utils_1.log)(`Cleaned up telegram log file, kept last 1000 entries`);
            }
        }
        catch (error) {
            (0, utils_1.log)(`Error cleaning up telegram log file: ${error}`, 'ERROR');
        }
    }
}
exports.TelegramBot = TelegramBot;
