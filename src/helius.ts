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
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.method === 'logsNotification') {
        await this.handleLogsNotification(msg.params);
      }
    } catch (error) {
      log(`Error parsing WebSocket message: ${error}`, 'ERROR');
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
      if (isInit) await this.handlePoolInit(signature, logs);
      if (isSwap) await this.handleSwap(signature, logs);
    } catch (error) {
      log(`Error handling logs notification: ${error}`, 'ERROR');
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

  close(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.ws) this.ws.close();
    this.ws = null;
  }
} 