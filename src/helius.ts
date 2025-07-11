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
  private pingInterval: NodeJS.Timeout | null = null;
  
  // Callback для обработки свапов
  public onSwap: ((mint: string, swapData: any) => void) | null = null;
  
  // Список токенов для мониторинга
  private monitoredTokens: Set<string> = new Set();
  
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
        // === Добавляем ручной ping ===
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.ping();
            log('📡 Sent ping to Helius WebSocket');
          }
        }, 30000); // каждые 30 секунд
      });
      this.ws.on('message', (data) => {
        log(`[WS IN] ${data.toString()}`);
        this.handleMessage(data.toString());
      });
      this.ws.on('pong', () => {
        log('[WS PONG] Received pong from Helius WebSocket');
      });

      this.ws.on('close', (code, reason) => {
        log(`❌ Helius WebSocket closed: ${code} ${reason}`);
        this.isConnected = false;
        // === Очищаем ping-интервал ===
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
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
    
    // === Очищаем ping-интервал ===
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
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

    // ВРЕМЕННО: подписка на все логи для диагностики событий создания пулов
    const subscription = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [
        {}, // подписка на все логи
        { commitment: 'confirmed' }
      ]
    };

    this.ws.send(JSON.stringify(subscription));
    log('📡 [DIAG] Subscribed to ALL transaction logs (diagnostic mode)');
  }

  private handleMessage(message: string): void {
    try {
      this.stats.messagesReceived++;
      this.stats.lastActivityTime = Date.now();
      log(`[WS RAW MESSAGE] ${message}`); // Логируем всё, что приходит
      // Новое: логируем структуру JSON
      try {
        const parsed = JSON.parse(message);
        log(`[WS RAW STRUCTURE] ${JSON.stringify(Object.keys(parsed))}`);
        if (parsed.params && parsed.params.result && parsed.params.result.value && parsed.params.result.value.logs) {
          log(`[WS RAW LOGS SAMPLE] ${JSON.stringify(parsed.params.result.value.logs.slice(0,3))}`);
        }
      } catch (e) {
        log(`[WS RAW PARSE ERROR] ${e}`);
      }
      const data = JSON.parse(message);
      
      if (data.method === 'logsNotification') {
        log(`[WS LOGS NOTIFICATION] Received logs notification for signature: ${data.params?.result?.value?.signature}`);
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
      log(`[WS PROCESSING LOGS] Processing ${logs.length} log lines for signature: ${signature}`);
      
      let isSwap = false;
      let isInit = false;
      for (const logLine of logs) {
        const lower = logLine.toLowerCase();
        if (
          lower.includes('pool') ||
          lower.includes('create') ||
          lower.includes('init') ||
          lower.includes('pair')
        ) {
          log(`[WS POOL DIAG] Possible pool logLine: ${logLine} (signature: ${signature})`);
        }
        if (logLine.includes('InitializePool') || logLine.includes('initialize')) {
          isInit = true;
          log(`[WS POOL INIT LOG] Found pool init logLine: ${logLine} (signature: ${signature})`);
        }
        if (lower.includes('swap')) isSwap = true;
      }
      
      log(`[WS LOG ANALYSIS] Signature: ${signature}, isInit: ${isInit}, isSwap: ${isSwap}`);
      
      if (isInit) {
        log(`[WS POOL INIT] Calling handlePoolInit for signature: ${signature}`);
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
      log(`[WS SWAP TX] ${JSON.stringify(tx)}`); // Логируем всю транзакцию свапа
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
      // Проверяем, нужно ли мониторить этот токен
      if (!this.shouldMonitorToken(targetMint)) {
        return; // Пропускаем токены не в мониторинге
      }
      // Проверить возраст пула
      const pool = await this.database.getPool(targetMint);
      if (!pool || !passesAge(pool)) return;
      // === Всегда обновляем OHLCV для monitoredTokens ===
      const ts = tx.timestamp || Math.floor(Date.now()/1000);
      await this.database.ingestSwap(targetMint, priceUsd, amount * priceUsd, ts);
      log(`💱 Swap: ${targetMint} $${priceUsd.toFixed(6)} x${amount} (OHLCV updated)`);
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
• Monitored Tokens: ${this.monitoredTokens.size}

🎯 **Performance:** ${this.stats.messagesReceived > 0 ? 'Active' : 'Waiting for activity'}`;

      await this.telegram.sendMessage(report);
      
    } catch (error) {
      log(`Error sending WebSocket activity report: ${error}`, 'ERROR');
    }
  }

  /**
   * Обновить список токенов для мониторинга
   */
  updateMonitoredTokens(tokens: string[]): void {
    this.monitoredTokens.clear();
    for (const mint of tokens) {
      this.monitoredTokens.add(mint);
    }
    log(`Helius WebSocket: Updated monitored tokens list to ${this.monitoredTokens.size} tokens`);
  }

  /**
   * Проверить, нужно ли мониторить этот токен
   */
  shouldMonitorToken(mint: string): boolean {
    return this.monitoredTokens.has(mint);
  }

  /**
   * Получить количество токенов в мониторинге
   */
  getMonitoredTokensCount(): number {
    return this.monitoredTokens.size;
  }

  /**
   * Получить статистику
   */
  getStats() {
    return { 
      ...this.stats,
      monitoredTokensCount: this.monitoredTokens.size
    };
  }

  /**
   * Проверить статус подключения
   */
  isConnectedToHelius(): boolean {
    return this.isConnected;
  }
} 