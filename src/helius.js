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
            const msg = JSON.parse(data.toString('utf8'));
            if (msg.method === 'logsNotification') {
                await this.handleLogsNotification(msg.params);
            }
        }
        catch (error) {
            (0, utils_1.log)(`Error parsing WebSocket message: ${error}`, 'ERROR');
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
            if (isInit)
                await this.handlePoolInit(signature, logs);
            if (isSwap)
                await this.handleSwap(signature, logs);
        }
        catch (error) {
            (0, utils_1.log)(`Error handling logs notification: ${error}`, 'ERROR');
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
    close() {
        if (this.pingInterval)
            clearInterval(this.pingInterval);
        if (this.ws)
            this.ws.close();
        this.ws = null;
    }
}
exports.HeliusWebSocket = HeliusWebSocket;
