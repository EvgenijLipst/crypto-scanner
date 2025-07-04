"use strict";
// helius.ts - Работа с Helius WebSocket (только logsSubscribe, swap/init)
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HeliusWebSocket = void 0;
const ws_1 = __importDefault(require("ws"));
const cross_fetch_1 = __importDefault(require("cross-fetch"));
const utils_1 = require("./utils");
const RAYDIUM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const ORCA_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
class HeliusWebSocket {
    constructor(apiKey, database) {
        this.ws = null;
        this.isConnected = false;
        this.reconnectTimeout = null;
        this.pingInterval = null;
        // Статистика активности
        this.stats = {
            startTime: Date.now(),
            lastActivity: Date.now(),
            messagesReceived: 0,
            programNotifications: 0,
            swapEventsProcessed: 0,
            poolEventsProcessed: 0,
            otherMessages: 0,
            errorsEncountered: 0
        };
        this.apiKey = apiKey;
        this.database = database;
    }
    connect() {
        return new Promise((resolve, reject) => {
            const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
            (0, utils_1.log)('Connecting to Helius WebSocket...');
            this.ws = new ws_1.default(wsUrl);
            this.ws.on('open', () => {
                (0, utils_1.log)('Helius WebSocket connected');
                this.isConnected = true;
                this.stats.startTime = Date.now();
                this.startPing();
                this.subscribeToLogs();
                resolve();
            });
            this.ws.on('message', (data) => {
                this.handleMessage(data);
            });
            this.ws.on('error', (error) => {
                (0, utils_1.log)(`WebSocket error: ${error.message}`, 'ERROR');
                this.isConnected = false;
                this.stats.errorsEncountered++;
                reject(error);
            });
            this.ws.on('close', () => {
                (0, utils_1.log)('WebSocket connection closed', 'WARN');
                this.isConnected = false;
                if (this.pingInterval) {
                    clearInterval(this.pingInterval);
                    this.pingInterval = null;
                }
                setTimeout(() => {
                    (0, utils_1.log)('Attempting to reconnect...');
                    this.connect();
                }, 5000);
            });
        });
    }
    subscribeToLogs() {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
            (0, utils_1.log)('WebSocket not ready for subscription', 'ERROR');
            return;
        }
        // Raydium
        this.ws.send(JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
            params: [{ mentions: [RAYDIUM_PROGRAM] }, { commitment: 'confirmed' }]
        }));
        (0, utils_1.log)('✅ Subscribed to Raydium logs');
        // Orca
        this.ws.send(JSON.stringify({
            jsonrpc: '2.0', id: 2, method: 'logsSubscribe',
            params: [{ mentions: [ORCA_PROGRAM] }, { commitment: 'confirmed' }]
        }));
        (0, utils_1.log)('✅ Subscribed to Orca logs');
    }
    async handleMessage(data) {
        try {
            this.stats.messagesReceived++;
            this.stats.lastActivity = Date.now();
            const msg = JSON.parse(data.toString('utf8'));
            if (msg.method === 'logsNotification') {
                this.stats.programNotifications++;
                (0, utils_1.log)(`📨 Received programNotification, total program notifications: ${this.stats.programNotifications}`);
                await this.handleLogsNotification(msg.params);
            }
            else if (msg.method === 'accountNotification') {
                this.stats.otherMessages++;
                (0, utils_1.log)(`📈 Received accountNotification (SOL account update), total other: ${this.stats.otherMessages}`);
            }
            else {
                this.stats.otherMessages++;
                (0, utils_1.log)(`📊 Received other message type: ${msg.method || 'unknown'}, total other: ${this.stats.otherMessages}`);
            }
        }
        catch (error) {
            (0, utils_1.log)(`Error parsing WebSocket message: ${error}`, 'ERROR');
            this.stats.errorsEncountered++;
        }
    }
    async handleLogsNotification(params) {
        try {
            const { result } = params;
            const { logs, signature } = result.value;
            let isSwap = false;
            let isInit = false;
            for (const logLine of logs) {
                if (logLine.includes('InitializePool') || logLine.includes('initialize'))
                    isInit = true;
                if (logLine.toLowerCase().includes('swap'))
                    isSwap = true;
            }
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
    startPing() {
        if (this.pingInterval)
            clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === ws_1.default.OPEN) {
                this.ws.ping();
                (0, utils_1.log)('Ping sent to WebSocket');
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
    close() {
        if (this.pingInterval)
            clearInterval(this.pingInterval);
        if (this.ws)
            this.ws.close();
        this.ws = null;
    }
}
exports.HeliusWebSocket = HeliusWebSocket;
