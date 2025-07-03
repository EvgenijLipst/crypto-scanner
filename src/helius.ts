// helius.ts - Работа с Helius WebSocket

import WebSocket from 'ws';
import { SwapEvent, InitPoolEvent } from './types';
import { Database } from './database';
import { passesAge, toUnixSeconds, log } from './utils';

interface HeliusMessage {
  jsonrpc: string;
  method?: string;
  params?: any;
  result?: any;
  id?: number;
}

export class HeliusWebSocket {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private database: Database;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(apiKey: string, database: Database) {
    this.apiKey = apiKey;
    this.database = database;
  }

  /**
   * Подключение к Helius WebSocket
   */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `wss://atlas-mainnet.helius-rpc.com?api-key=${this.apiKey}`;
      
      log('Connecting to Helius WebSocket...');
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        log('Helius WebSocket connected');
        this.startPing();
        this.subscribeToTransactions();
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error) => {
        log(`WebSocket error: ${error.message}`, 'ERROR');
        reject(error);
      });

      this.ws.on('close', () => {
        log('WebSocket connection closed', 'WARN');
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
        // Автоматическое переподключение через 5 секунд
        setTimeout(() => {
          log('Attempting to reconnect...');
          this.connect();
        }, 5000);
      });
    });
  }

  /**
   * Подписка на транзакции (logs для программ swaps и pool initialization)
   */
  private subscribeToTransactions(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log('WebSocket not ready for subscription', 'ERROR');
      return;
    }

    // Подписываемся на логи Raydium, Orca и других AMM
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          mentions: [
            "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM V4
            "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", // Orca Whirlpools
            "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1", // Orca Legacy
            "EhpADiBBAoHZnPb7PZZZy3QJmuggJ3dH6bqBFnM6dqNm", // Meteora
          ]
        },
        {
          commitment: "confirmed"
        }
      ]
    };

    this.sendMessage(request);
    log('Subscribed to AMM transaction logs');
  }

  /**
   * Отправка сообщения в WebSocket
   */
  private sendMessage(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Обработка входящих сообщений
   */
  private async handleMessage(data: Buffer): Promise<void> {
    try {
      const messageStr = data.toString('utf8');
      const message: HeliusMessage = JSON.parse(messageStr);

      // Обрабатываем уведомления о логах
      if (message.method === 'logsNotification') {
        await this.handleLogsNotification(message.params);
      }
    } catch (error) {
      log(`Error parsing WebSocket message: ${error}`, 'ERROR');
    }
  }

  /**
   * Обработка уведомлений о логах транзакций
   */
  private async handleLogsNotification(params: any): Promise<void> {
    try {
      const { result } = params;
      const { logs, signature } = result.value;

      // Анализируем логи для поиска swap-событий и инициализации пулов
      for (const logLine of logs) {
        // Поиск событий создания пула (InitializePool)
        if (logLine.includes('InitializePool') || logLine.includes('initialize')) {
          await this.handlePoolInit(signature, logLine);
        }

        // Поиск событий свапа
        if (logLine.includes('swap') || logLine.includes('Swap')) {
          await this.handleSwap(signature, logLine);
        }
      }
    } catch (error) {
      log(`Error handling logs notification: ${error}`, 'ERROR');
    }
  }

  /**
   * Обработка события инициализации пула
   */
  private async handlePoolInit(signature: string, logLine: string): Promise<void> {
    try {
      // Здесь нужна дополнительная логика для извлечения mint адреса из логов
      // Это упрощенная версия - в реальности нужно парсить transaction details
      
      log(`Pool initialization detected: ${signature}`);
      
      // TODO: Получить детали транзакции через RPC для извлечения mint
      // Пока что пропускаем, так как нужна дополнительная логика
    } catch (error) {
      log(`Error handling pool init: ${error}`, 'ERROR');
    }
  }

  /**
   * Обработка события свапа
   */
  private async handleSwap(signature: string, logLine: string): Promise<void> {
    try {
      // Здесь тоже нужна дополнительная логика для извлечения деталей свапа
      // В упрощенной версии просто логируем
      
      log(`Swap detected: ${signature}`);
      
      // TODO: Парсить логи для получения:
      // - mint адреса токена
      // - цены
      // - объема
      // - временной метки
    } catch (error) {
      log(`Error handling swap: ${error}`, 'ERROR');
    }
  }

  /**
   * Поддержание соединения через ping
   */
  private startPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        log('Ping sent to WebSocket');
      }
    }, 30000); // Ping каждые 30 секунд
  }

  /**
   * Закрытие соединения
   */
  close(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
} 