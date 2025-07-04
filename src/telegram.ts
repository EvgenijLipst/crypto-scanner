// telegram.ts - Уведомления в Telegram

import fetch from 'cross-fetch';
import fs from 'fs';
import path from 'path';
import { SignalRow } from './types';
import { formatNumber, escapeMarkdown, createBirdeyeLink, log } from './utils';

export class TelegramBot {
  private token: string;
  private chatId: number;
  private baseUrl: string;
  private logFilePath: string;

  constructor(token: string, chatId: string) {
    this.token = token;
    
    log(`TelegramBot constructor received chatId: "${chatId}" (type: ${typeof chatId}, length: ${chatId?.length})`);
    
    // Clean and parse chatId more carefully
    const cleanedChatId = chatId.trim().replace(/^[=\s]+/, '');
    log(`Cleaned chatId: "${cleanedChatId}"`);
    
    const parsedChatId = parseInt(cleanedChatId);
    log(`parseInt("${cleanedChatId}") = ${parsedChatId} (isNaN: ${isNaN(parsedChatId)})`);
    
    this.chatId = parsedChatId || 0;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    
    // Настройка файла логов
    this.logFilePath = path.join(process.cwd(), 'telegram.log');
    
    log(`TelegramBot initialized with final chat_id: ${this.chatId}, token: ${token.substring(0, 10)}...`);
    log(`Telegram logs will be saved to: ${this.logFilePath}`);
  }

  /**
   * Логирование сообщения в файл
   */
  private logToFile(message: string, status: 'SENT' | 'ERROR'): void {
    try {
      const timestamp = new Date().toISOString();
      const logEntry = `[${timestamp}] [${status}] ${message}\n`;
      fs.appendFileSync(this.logFilePath, logEntry, 'utf8');
    } catch (error) {
      log(`Failed to write to telegram log file: ${error}`, 'ERROR');
    }
  }

  /**
   * Отправить сообщение в Telegram
   */
  async sendMessage(text: string, parseMode: 'Markdown' | 'MarkdownV2' | 'HTML' = 'Markdown'): Promise<boolean> {
    try {
      log(`Attempting to send message to chat_id: ${this.chatId} with token: ${this.token.substring(0, 10)}...`);
      
      const url = `${this.baseUrl}/sendMessage`;
      const payload = {
        chat_id: this.chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      };
      
      log(`Payload: ${JSON.stringify(payload)}`);
      
      // Создаем AbortController для таймаута
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 секунд
      
      const response = await fetch(url, {
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
        log(`Telegram API error: ${response.status} ${error}`, 'ERROR');
        this.logToFile(`ERROR: ${response.status} ${error} | Message: ${text}`, 'ERROR');
        return false;
      }

      log('Telegram message sent successfully');
      this.logToFile(text, 'SENT');
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'Unknown';
      
      if (errorName === 'AbortError' || errorMessage.includes('timeout')) {
        log('Telegram message timeout - network issue, will retry later', 'WARN');
        this.logToFile(`TIMEOUT: ${errorMessage} | Message: ${text}`, 'ERROR');
      } else if (errorMessage.includes('Connection terminated')) {
        log('Telegram connection terminated - network issue, will retry later', 'WARN');
        this.logToFile(`CONNECTION_ERROR: ${errorMessage} | Message: ${text}`, 'ERROR');
      } else {
        log(`Error sending Telegram message: ${errorMessage}`, 'ERROR');
        this.logToFile(`SEND_ERROR: ${errorMessage} | Message: ${text}`, 'ERROR');
      }
      return false;
    }
  }

  /**
   * Отправить сигнал покупки
   */
  async sendBuySignal(
    signal: SignalRow,
    poolInfo: { liq_usd: number; fdv_usd: number },
    priceImpact: number
  ): Promise<boolean> {
    const message = this.formatBuySignal(signal, poolInfo, priceImpact);
    return this.sendMessage(message);
  }

  /**
   * Форматировать сигнал покупки для Telegram
   */
  private formatBuySignal(
    signal: SignalRow,
    poolInfo: { liq_usd: number; fdv_usd: number },
    priceImpact: number
  ): string {
    const birdeyeLink = createBirdeyeLink(signal.mint);
    
    // Объяснение почему этот токен достоин покупки
    const reasons = [];
    if (signal.ema_cross) reasons.push('✅ EMA 9/21 пересечение (бычий сигнал)');
    if (signal.vol_spike >= 3) reasons.push(`✅ Всплеск объема x${formatNumber(signal.vol_spike, 1)} (высокий интерес)`);
    if (signal.rsi < 35) reasons.push(`✅ RSI ${formatNumber(signal.rsi, 1)} (перепроданность)`);
    if (poolInfo.liq_usd >= 10000) reasons.push('✅ Достаточная ликвидность (>$10K)');
    if (poolInfo.fdv_usd <= 5000000) reasons.push('✅ Разумная оценка (<$5M FDV)');
    
    return `🚀 **СИГНАЛ ПОКУПКИ** 🚀

🪙 **Токен:** \`${signal.mint}\`

💡 **Почему стоит покупать:**
${reasons.join('\n')}

📊 **Технический анализ:**
• EMA Cross: ${signal.ema_cross ? '✅' : '❌'}
• Volume Spike: x${formatNumber(signal.vol_spike, 1)} ${signal.vol_spike >= 3 ? '✅' : '❌'}
• RSI: ${formatNumber(signal.rsi, 1)} ${signal.rsi < 35 ? '✅' : '❌'}

💰 **Данные пула:**
• Ликвидность: $${formatNumber(poolInfo.liq_usd)}
• FDV: $${formatNumber(poolInfo.fdv_usd)}
• Прайс-импакт: ${formatNumber(priceImpact, 2)}%

🔗 **Ссылки:**
[📊 Birdeye](${birdeyeLink})
[📈 DEXScreener](https://dexscreener.com/solana/${signal.mint})

⏰ ${new Date(signal.signal_ts * 1000).toLocaleString()}`;
  }

  /**
   * Отправить сообщение об ошибке
   */
  async sendErrorMessage(error: string): Promise<void> {
    const message = `🚨 **Signal Bot Error** 🚨\n\n\`${escapeMarkdown(error)}\``;
    await this.sendMessage(message);
  }

  /**
   * Отправить статистику активности WebSocket
   */
  async sendActivityReport(stats: {
    messagesReceived: number;
    logsNotifications: number;
    programNotifications?: number;
    swapEventsProcessed: number;
    poolEventsProcessed: number;
    otherMessages: number;
    errorsEncountered: number;
    uptimeMinutes: number;
    lastActivityMinutes: number;
    isConnected: boolean;
    messagesPerMinute: string;
  }): Promise<void> {
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
  getRecentTelegramLogs(limit: number = 50): string[] {
    try {
      if (!fs.existsSync(this.logFilePath)) {
        return ['Log file does not exist yet'];
      }
      
      const content = fs.readFileSync(this.logFilePath, 'utf8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      
      // Возвращаем последние N строк
      return lines.slice(-limit);
    } catch (error) {
      return [`Error reading log file: ${error}`];
    }
  }

  /**
   * Очистить лог-файл Telegram (оставить только последние 1000 записей)
   */
  cleanupTelegramLogs(): void {
    try {
      if (!fs.existsSync(this.logFilePath)) {
        return;
      }
      
      const content = fs.readFileSync(this.logFilePath, 'utf8');
      const lines = content.trim().split('\n').filter(line => line.length > 0);
      
      if (lines.length > 1000) {
        const recentLines = lines.slice(-1000);
        fs.writeFileSync(this.logFilePath, recentLines.join('\n') + '\n', 'utf8');
        log(`Cleaned up telegram log file, kept last 1000 entries`);
      }
    } catch (error) {
      log(`Error cleaning up telegram log file: ${error}`, 'ERROR');
    }
  }
} 