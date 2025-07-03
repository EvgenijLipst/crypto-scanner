// telegram.ts - Уведомления в Telegram

import fetch from 'cross-fetch';
import { SignalRow } from './types';
import { formatNumber, escapeMarkdown, createBirdeyeLink, log } from './utils';

export class TelegramBot {
  private token: string;
  private chatId: number;
  private baseUrl: string;

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
    
    log(`TelegramBot initialized with final chat_id: ${this.chatId}, token: ${token.substring(0, 10)}...`);
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
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.text();
        log(`Telegram API error: ${response.status} ${error}`, 'ERROR');
        return false;
      }

      log('Telegram message sent successfully');
      return true;
    } catch (error) {
      log(`Error sending Telegram message: ${error}`, 'ERROR');
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
    
    return `📈 **BUY SIGNAL** 📈

🪙 **Token:** \`${signal.mint}\`

📊 **Technical Analysis:**
• EMA Cross: ${signal.ema_cross ? '✅' : '❌'}
• Volume Spike: x${formatNumber(signal.vol_spike, 1)} ${signal.vol_spike >= 3 ? '✅' : '❌'}
• RSI: ${formatNumber(signal.rsi, 1)} ${signal.rsi < 35 ? '✅' : '❌'}

💰 **Pool Info:**
• Liquidity: $${formatNumber(poolInfo.liq_usd)}
• FDV: $${formatNumber(poolInfo.fdv_usd)}
• Price Impact: ${formatNumber(priceImpact, 2)}%

🔗 **Links:**
[📊 Birdeye](${birdeyeLink})
[📈 DEXScreener](https://dexscreener.com/solana/${signal.mint})

⏰ Signal Time: ${signal.created_at.toLocaleString()}`;
  }

  /**
   * Отправить сообщение об ошибке
   */
  async sendErrorMessage(error: string): Promise<void> {
    const message = `🚨 **Signal Bot Error** 🚨\n\n\`${error}\``;
    await this.sendMessage(message);
  }

  /**
   * Отправить статистику работы бота
   */
  async sendStats(stats: {
    signalsProcessed: number;
    signalsSent: number;
    tokensAnalyzed: number;
    uptime: number;
  }): Promise<void> {
    const uptimeHours = (stats.uptime / 3600).toFixed(1);
    
    const message = `📊 **Signal Bot Stats** 📊

🔄 **Processing:**
• Signals Processed: ${stats.signalsProcessed}
• Signals Sent: ${stats.signalsSent}
• Tokens Analyzed: ${stats.tokensAnalyzed}

⏱️ **Uptime:** ${uptimeHours} hours

${new Date().toLocaleString()}`;
    
    await this.sendMessage(message);
  }

  /**
   * Получить информацию о чате (для отладки chat ID)
   */
  async getChatInfo(): Promise<void> {
    try {
      const url = `${this.baseUrl}/getUpdates`;
      const response = await fetch(url);
      
      if (!response.ok) {
        log(`Failed to get chat info: ${response.status}`, 'ERROR');
        return;
      }

      const data = await response.json();
      log(`Chat updates: ${JSON.stringify(data, null, 2)}`);
      
      if (data.result && data.result.length > 0) {
        const lastMessage = data.result[data.result.length - 1];
        if (lastMessage.message && lastMessage.message.chat) {
          log(`Your chat ID: ${lastMessage.message.chat.id}`);
        }
      }
    } catch (error) {
      log(`Error getting chat info: ${error}`, 'ERROR');
    }
  }

  /**
   * Тестовое сообщение для проверки подключения
   */
  async sendTestMessage(): Promise<boolean> {
    const message = `Signal Bot Test - ${new Date().toLocaleString()}`;
    return this.sendMessage(message, 'HTML');
  }
} 