"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HeliusWebSocket = void 0;
// helius.ts - WebSocket подключение к Helius для мониторинга транзакций
const ws_1 = __importDefault(require("ws"));
const cross_fetch_1 = __importDefault(require("cross-fetch"));
const utils_1 = require("./utils");
class HeliusWebSocket {
    constructor(apiKey, database, telegram) {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000;
        this.isConnected = false;
        this.shouldReconnect = true;
        // Callback для обработки свапов
        this.onSwap = null;
        // Статистика
        this.stats = {
            messagesReceived: 0,
            poolEventsProcessed: 0,
            swapEventsProcessed: 0,
            errorsEncountered: 0,
            lastActivityTime: Date.now()
        };
        this.apiKey = apiKey;
        this.database = database;
        this.telegram = telegram;
    }
    async connect() {
        try {
            (0, utils_1.log)('🔌 Connecting to Helius WebSocket...');
            if (this.ws) {
                this.ws.close();
            }
            this.ws = new ws_1.default(`wss://atlas-mainnet.helius-rpc.com/?api-key=${this.apiKey}`);
            this.ws.on('open', () => {
                (0, utils_1.log)('✅ Helius WebSocket connected');
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.subscribeToLogs();
            });
            this.ws.on('message', (data) => {
                this.handleMessage(data.toString());
            });
            this.ws.on('close', (code, reason) => {
                (0, utils_1.log)(`❌ Helius WebSocket closed: ${code} ${reason}`);
                this.isConnected = false;
                if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
                    this.scheduleReconnect();
                }
            });
            this.ws.on('error', (error) => {
                (0, utils_1.log)(`❌ Helius WebSocket error: ${error}`, 'ERROR');
                this.stats.errorsEncountered++;
            });
        }
        catch (error) {
            (0, utils_1.log)(`❌ Failed to connect to Helius: ${error}`, 'ERROR');
            throw error;
        }
    }
    async disconnect() {
        (0, utils_1.log)('🔌 Disconnecting from Helius WebSocket...');
        this.shouldReconnect = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
        (0, utils_1.log)('✅ Helius WebSocket disconnected');
    }
    scheduleReconnect() {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        (0, utils_1.log)(`🔄 Scheduling reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
        setTimeout(() => {
            if (this.shouldReconnect) {
                this.connect().catch(error => {
                    (0, utils_1.log)(`❌ Reconnect failed: ${error}`, 'ERROR');
                });
            }
        }, delay);
    }
    subscribeToLogs() {
        if (!this.ws)
            return;
        const subscription = {
            jsonrpc: '2.0',
            id: 1,
            method: 'logsSubscribe',
            params: [
                {}, // подписка на все логи для диагностики
                {
                    commitment: 'confirmed'
                }
            ]
        };
        this.ws.send(JSON.stringify(subscription));
        (0, utils_1.log)('📡 Subscribed to ALL transaction logs (diagnostic mode)');
    }
    handleMessage(message) {
        try {
            this.stats.messagesReceived++;
            this.stats.lastActivityTime = Date.now();
            const data = JSON.parse(message);
            if (data.method === 'logsNotification') {
                (0, utils_1.log)(`[WS LOGS NOTIFICATION] Received logs notification for signature: ${data.params?.result?.value?.signature}`);
                this.handleLogsNotification(data.params);
            }
        }
        catch (error) {
            (0, utils_1.log)(`❌ Error handling message: ${error}`, 'ERROR');
            this.stats.errorsEncountered++;
        }
    }
    async handleLogsNotification(params) {
        try {
            const { result } = params;
            const { logs, signature } = result.value;
            (0, utils_1.log)(`[WS PROCESSING LOGS] Processing ${logs.length} log lines for signature: ${signature}`);
            
            let isSwap = false;
            let isInit = false;
            for (const logLine of logs) {
                if (logLine.includes('InitializePool') || logLine.includes('initialize'))
                    isInit = true;
                if (logLine.toLowerCase().includes('swap'))
                    isSwap = true;
            }
            
            (0, utils_1.log)(`[WS LOG ANALYSIS] Signature: ${signature}, isInit: ${isInit}, isSwap: ${isSwap}`);
            
            if (isInit) {
                await this.handlePoolInit(signature, logs);
                this.stats.poolEventsProcessed++;
            }
            if (isSwap) {
                await this.handleSwap(signature, logs);
                this.stats.swapEventsProcessed++;
            }
        }
        catch (error) {
            (0, utils_1.log)(`Error handling logs notification: ${error}`, 'ERROR');
            this.stats.errorsEncountered++;
        }
    }
    async handlePoolInit(signature, logs) {
        try {
            // Получить детали транзакции через Helius Enhanced API
            const tx = await this.fetchTransaction(signature);
            if (!tx)
                return;
            // Найти mint пула (пример: первый найденный mint в tokenTransfers)
            const mint = tx.tokenTransfers?.[0]?.mint;
            if (!mint)
                return;
            // Время
            const ts = tx.timestamp || Math.floor(Date.now() / 1000);
            await this.database.upsertPool(mint, ts);
            (0, utils_1.log)(`🏊 Pool init: ${mint} @ ${ts}`);
        }
        catch (error) {
            (0, utils_1.log)(`Error in handlePoolInit: ${error}`, 'ERROR');
            this.stats.errorsEncountered++;
        }
    }
    async handleSwap(signature, logs) {
        try {
            const tx = await this.fetchTransaction(signature);
            if (!tx)
                return;
            // Найти mint и объём свапа (пример: первый не-USDC/SOL mint)
            const usdcMint = 'EPjFWdd5AufqSSqeM2qA9G4KJ9b9wiG9vG7bG6wGw7bS';
            const solMint = 'So11111111111111111111111111111111111111112';
            let targetMint = null;
            let amount = 0;
            let priceUsd = 0;
            const tokenAmounts = {};
            for (const t of tx.tokenTransfers || []) {
                if (!tokenAmounts[t.mint])
                    tokenAmounts[t.mint] = 0;
                tokenAmounts[t.mint] += t.tokenAmount || 0;
            }
            for (const [mint, amt] of Object.entries(tokenAmounts)) {
                if (mint !== usdcMint && mint !== solMint && amt > 0) {
                    targetMint = mint;
                    amount = amt;
                    const usdcAmount = Math.abs(tokenAmounts[usdcMint] || 0);
                    if (usdcAmount > 0 && amt > 0)
                        priceUsd = usdcAmount / amt;
                    break;
                }
            }
            if (!targetMint || !priceUsd)
                return;
            // Проверить возраст пула
            const pool = await this.database.getPool(targetMint);
            if (!pool || !(0, utils_1.passesAge)(pool))
                return;
            // Записать OHLCV
            const ts = tx.timestamp || Math.floor(Date.now() / 1000);
            await this.database.ingestSwap(targetMint, priceUsd, amount * priceUsd, ts);
            (0, utils_1.log)(`💱 Swap: ${targetMint} $${priceUsd.toFixed(6)} x${amount}`);
            // Вызываем callback для обработки свапа
            if (this.onSwap) {
                this.onSwap(targetMint, {
                    priceUsd,
                    volumeUsd: amount * priceUsd,
                    timestamp: ts
                });
            }
        }
        catch (error) {
            (0, utils_1.log)(`Error in handleSwap: ${error}`, 'ERROR');
            this.stats.errorsEncountered++;
        }
    }
    async fetchTransaction(signature) {
        try {
            const url = `https://api.helius.xyz/v0/transactions?api-key=${this.apiKey}`;
            const resp = await (0, cross_fetch_1.default)(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transactions: [signature] })
            });
            if (!resp.ok)
                return null;
            const arr = await resp.json();
            return arr[0];
        }
        catch (error) {
            (0, utils_1.log)(`Error fetching tx: ${error}`, 'ERROR');
            this.stats.errorsEncountered++;
            return null;
        }
    }
    /**
     * Отправить отчет о активности WebSocket
     */
    async sendWebSocketActivityReport() {
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
        }
        catch (error) {
            (0, utils_1.log)(`Error sending WebSocket activity report: ${error}`, 'ERROR');
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
    isConnectedToHelius() {
        return this.isConnected;
    }
}
exports.HeliusWebSocket = HeliusWebSocket;
