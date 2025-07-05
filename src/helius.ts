// helius.ts - WebSocket подключение к Helius для мониторинга транзакций
import WebSocket from 'ws';
import fetch from 'cross-fetch';
import { Database } from './database';
import { TelegramBot } from './telegram';
import { log, passesAge } from './utils';

export class HeliusWebSocket {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private database: Database;
  private telegram: TelegramBot;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;
  private isConnected = false;
  private shouldReconnect = true;
  
  // Callback для обработки свапов
  public onSwap: ((mint: string, swapData: any) => void) | null = null;
  
  // Статистика
  private stats = {
    messagesReceived: 0,
    poolEventsProcessed: 0,
    swapEventsProcessed: 0,
    errorsEncountered: 0,
    lastActivityTime: Date.now()
  };

  constructor(apiKey: string, database: Database, telegram: TelegramBot) {
    this.apiKey = apiKey;
    this.database = database;
    this.telegram = telegram;
  }

  async connect(): Promise<void> {
    try {
      log('🔌 Connecting to Helius WebSocket...');
      
      if (this.ws) {
        this.ws.close();
      }

      this.ws = new WebSocket(`wss://mainnet.helius-rpc.com/?api-key=${this.apiKey}`);
      
      this.ws.on('open', () => {
        log('✅ Helius WebSocket connected');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.subscribeToLogs();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code, reason) => {
        log(`❌ Helius WebSocket closed: ${code} ${reason}`);
        this.isConnected = false;
        
        if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        log(`❌ Helius WebSocket error: ${error}`, 'ERROR');
        this.stats.errorsEncountered++;
      });

    } catch (error) {
      log(`❌ Failed to connect to Helius: ${error}`, 'ERROR');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    log('🔌 Disconnecting from Helius WebSocket...');
    this.shouldReconnect = false;
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.isConnected = false;
    log('✅ Helius WebSocket disconnected');
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    log(`🔄 Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
    
    setTimeout(() => {
      if (this.shouldReconnect) {
        this.connect().catch(error => {
          log(`❌ Reconnect failed: ${error}`, 'ERROR');
        });
      }
    }, delay);
  }

  private subscribeToLogs(): void {
    if (!this.ws) return;

    const subscription = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        {
          mentions: ['11111111111111111111111111111112'] // System Program for all transactions
        },
        {
          commitment: 'confirmed'
        }
      ]
    };

    this.ws.send(JSON.stringify(subscription));
    log('📡 Subscribed to transaction logs');
  }

  private handleMessage(message: string): void {
    try {
      this.stats.messagesReceived++;
      this.stats.lastActivityTime = Date.now();
      
      const data = JSON.parse(message);
      
      if (data.method === 'logsNotification') {
        this.handleLogsNotification(data.params);
      }
      
    } catch (error) {
      log(`❌ Error handling message: ${error}`, 'ERROR');
      this.stats.errorsEncountered++;
    }
  }

  private async handleLogsNotification(params: any): Promise<void> {
    try {
      const { result } = params;
      const { logs, signature } = result.value;
      let isSwap = false;
      let isInit = false;
      for (const logLine of logs) {
        if (logLine.includes('InitializePool') || logLine.includes('initialize')) isInit = true;
        if (logLine.toLowerCase().includes('swap')) isSwap = true;
      }
      if (isInit) {
        await this.handlePoolInit(signature, logs);
        this.stats.poolEventsProcessed++;
      }
      if (isSwap) {
        await this.handleSwap(signature, logs);
        this.stats.swapEventsProcessed++;
      }
    } catch (error) {
      log(`Error handling logs notification: ${error}`, 'ERROR');
      this.stats.errorsEncountered++;
    }
  }

  private async handlePoolInit(signature: string, logs: string[]): Promise<void> {
    try {
      // Получить детали транзакции через Helius Enhanced API
      const tx = await this.fetchTransaction(signature);
      if (!tx) return;
      // Найти mint пула (пример: первый найденный mint в tokenTransfers)
      const mint = tx.tokenTransfers?.[0]?.mint;
      if (!mint) return;
      // Время
      const ts = tx.timestamp || Math.floor(Date.now()/1000);
      await this.database.upsertPool(mint, ts);
      log(`🏊 Pool init: ${mint} @ ${ts}`);
    } catch (error) {
      log(`Error in handlePoolInit: ${error}`, 'ERROR');
      this.stats.errorsEncountered++;
    }
  }

  private async handleSwap(signature: string, logs: string[]): Promise<void> {
    try {
      const tx = await this.fetchTransaction(signature);
      if (!tx) return;
      // Найти mint и объём свапа (пример: первый не-USDC/SOL mint)
      const usdcMint = 'EPjFWdd5AufqSSqeM2qA9G4KJ9b9wiG9vG7bG6wGw7bS';
      const solMint = 'So11111111111111111111111111111111111111112';
      let targetMint = null;
      let amount = 0;
      let priceUsd = 0;
      const tokenAmounts: { [mint: string]: number } = {};
      for (const t of tx.tokenTransfers || []) {
        if (!tokenAmounts[t.mint]) tokenAmounts[t.mint] = 0;
        tokenAmounts[t.mint] += t.tokenAmount || 0;
      }
      for (const [mint, amt] of Object.entries(tokenAmounts)) {
        if (mint !== usdcMint && mint !== solMint && amt > 0) {
          targetMint = mint;
          amount = amt;
          const usdcAmount = Math.abs(tokenAmounts[usdcMint] || 0);
          if (usdcAmount > 0 && amt > 0) priceUsd = usdcAmount / amt;
          break;
        }
      }
      if (!targetMint || !priceUsd) return;
      // Проверить возраст пула
      const pool = await this.database.getPool(targetMint);
      if (!pool || !passesAge(pool)) return;
      // Записать OHLCV
      const ts = tx.timestamp || Math.floor(Date.now()/1000);
      await this.database.ingestSwap(targetMint, priceUsd, amount * priceUsd, ts);
      log(`💱 Swap: ${targetMint} $${priceUsd.toFixed(6)} x${amount}`);
      
      // Вызываем callback для обработки свапа
      if (this.onSwap) {
        this.onSwap(targetMint, {
          priceUsd,
          volumeUsd: amount * priceUsd,
          timestamp: ts
        });
      }
      
    } catch (error) {
      log(`Error in handleSwap: ${error}`, 'ERROR');
      this.stats.errorsEncountered++;
    }
  }

  private async fetchTransaction(signature: string): Promise<any> {
    try {
      const url = `https://api.helius.xyz/v0/transactions?api-key=${this.apiKey}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: [signature] })
      });
      if (!resp.ok) return null;
      const arr = await resp.json();
      return arr[0];
    } catch (error) {
      log(`Error fetching tx: ${error}`, 'ERROR');
      this.stats.errorsEncountered++;
      return null;
    }
  }

  /**
   * Отправить отчет о активности WebSocket
   */
  async sendWebSocketActivityReport(): Promise<void> {
    try {
      const uptime = Math.floor(process.uptime() / 60);
      const lastActivity = Math.floor((Date.now() - this.stats.lastActivityTime) / 1000);
      
      const report = `📡 **WebSocket Activity Report**

🔌 **Connection Status:** ${this.isConnected ? '🟢 Connected' : '🔴 Disconnected'}
⏱️ **Uptime:** ${uptime} minutes
🔄 **Last Activity:** ${lastActivity} seconds ago

📊 **Statistics:**
• Messages Received: ${this.stats.messagesReceived.toLocaleString()}
• Pool Events: ${this.stats.poolEventsProcessed.toLocaleString()}
• Swap Events: ${this.stats.swapEventsProcessed.toLocaleString()}
• Errors: ${this.stats.errorsEncountered.toLocaleString()}

🎯 **Performance:** ${this.stats.messagesReceived > 0 ? 'Active' : 'Waiting for activity'}`;

      await this.telegram.sendMessage(report);
      
    } catch (error) {
      log(`Error sending WebSocket activity report: ${error}`, 'ERROR');
    }
  }

  /**
   * Получить статистику
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Проверить статус подключения
   */
  isConnectedToHelius(): boolean {
    return this.isConnected;
  }
} 