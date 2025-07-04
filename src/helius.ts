// helius.ts - Работа с Helius WebSocket (только logsSubscribe, swap/init)

import WebSocket from 'ws';
import fetch from 'cross-fetch';
import { Database } from './database';
import { passesAge, log } from './utils';
import { PoolRow } from './types';

const RAYDIUM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const ORCA_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

export class HeliusWebSocket {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private database: Database;
  private isConnected = false;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  
  // Статистика активности
  private stats = {
    startTime: Date.now(),
    lastActivity: Date.now(),
    messagesReceived: 0,
    programNotifications: 0,
    swapEventsProcessed: 0,
    poolEventsProcessed: 0,
    otherMessages: 0,
    errorsEncountered: 0
  };

  constructor(apiKey: string, database: Database) {
    this.apiKey = apiKey;
    this.database = database;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
      log('Connecting to Helius WebSocket...');
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        log('Helius WebSocket connected');
        this.isConnected = true;
        this.stats.startTime = Date.now();
        this.startPing();
        this.subscribeToLogs();
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error) => {
        log(`WebSocket error: ${error.message}`, 'ERROR');
        this.isConnected = false;
        this.stats.errorsEncountered++;
        reject(error);
      });

      this.ws.on('close', () => {
        log('WebSocket connection closed', 'WARN');
        this.isConnected = false;
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        setTimeout(() => {
          log('Attempting to reconnect...');
          this.connect();
        }, 5000);
      });
    });
  }

  private subscribeToLogs(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log('WebSocket not ready for subscription', 'ERROR');
      return;
    }
    // Raydium
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
      params: [{ mentions: [RAYDIUM_PROGRAM] }, { commitment: 'confirmed' }]
    }));
    log('✅ Subscribed to Raydium logs');
    // Orca
    this.ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'logsSubscribe',
      params: [{ mentions: [ORCA_PROGRAM] }, { commitment: 'confirmed' }]
    }));
    log('✅ Subscribed to Orca logs');
  }

  private async handleMessage(data: Buffer): Promise<void> {
    try {
      this.stats.messagesReceived++;
      this.stats.lastActivity = Date.now();
      
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.method === 'logsNotification') {
        this.stats.programNotifications++;
        log(`📨 Received programNotification, total program notifications: ${this.stats.programNotifications}`);
        await this.handleLogsNotification(msg.params);
      } else if (msg.method === 'accountNotification') {
        this.stats.otherMessages++;
        log(`📈 Received accountNotification (SOL account update), total other: ${this.stats.otherMessages}`);
      } else {
        this.stats.otherMessages++;
        log(`📊 Received other message type: ${msg.method || 'unknown'}, total other: ${this.stats.otherMessages}`);
      }
    } catch (error) {
      log(`Error parsing WebSocket message: ${error}`, 'ERROR');
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

  private startPing(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        log('Ping sent to WebSocket');
      }
    }, 30000);
  }

  /**
   * Получить статистику WebSocket активности
   */
  getActivityStats() {
    const now = Date.now();
    const uptimeMs = now - this.stats.startTime;
    const lastActivityMs = now - this.stats.lastActivity;
    
    return {
      messagesReceived: this.stats.messagesReceived,
      programNotifications: this.stats.programNotifications,
      logsNotifications: this.stats.programNotifications, // Для совместимости со старым API
      swapEventsProcessed: this.stats.swapEventsProcessed,
      poolEventsProcessed: this.stats.poolEventsProcessed,
      otherMessages: this.stats.otherMessages,
      errorsEncountered: this.stats.errorsEncountered,
      uptimeMinutes: Math.floor(uptimeMs / 60000),
      lastActivityMinutes: Math.floor(lastActivityMs / 60000),
      isConnected: this.isConnected,
      messagesPerMinute: uptimeMs > 0 ? (this.stats.messagesReceived / (uptimeMs / 60000)).toFixed(1) : '0.0'
    };
  }

  close(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) this.ws.close();
    this.ws = null;
  }
} 