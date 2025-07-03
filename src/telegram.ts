// telegram.ts - Уведомления в Telegram

import fetch from 'cross-fetch';
import { SignalRow } from './types';
import { formatNumber, escapeMarkdown, createBirdeyeLink, log } from './utils';

export class TelegramBot {
  private token: string;
  private chatId: string;
  private baseUrl: string;

  constructor(token: string, chatId: string) {
    this.token = token;
    this.chatId = chatId;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  /**
   * Отправить сообщение в Telegram
   */
  async sendMessage(text: string, parseMode: 'Markdown' | 'MarkdownV2' | 'HTML' = 'Markdown'): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        }),
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
   * Тестовое сообщение для проверки подключения
   */
  async sendTestMessage(): Promise<boolean> {
    const message = `🤖 **Signal Bot Started** 🤖

Bot is now running and monitoring for trading signals.

Settings:
• Min Token Age: 14 days
• Min Liquidity: $10,000
• Max FDV: $5,000,000
• Volume Spike: 3x+
• RSI Oversold: <35

Ready to catch signals! 🎯`;

    return this.sendMessage(message);
  }
} 