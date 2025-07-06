const { spawn } = require('child_process');

class SimpleRailwayMonitor {
    constructor() {
        this.services = [
            { name: 'signal-bot', id: 'signal-bot' },
            { name: 'tradebot', id: 'tradebot' },
            { name: 'postgres', id: 'postgres' }
        ];
        this.processes = new Map();
    }

    // Запуск мониторинга логов для конкретного сервиса
    startServiceLogs(serviceName) {
        console.log(`🚀 Запуск мониторинга логов для ${serviceName}...`);
        
        // Используем railway logs с указанием сервиса
        const railway = spawn('railway', ['logs', '--service', serviceName, '--follow'], {
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        railway.stdout.on('data', (data) => {
            const logs = data.toString();
            this.processLogs(serviceName, logs);
        });
        
        railway.stderr.on('data', (data) => {
            const error = data.toString();
            if (!error.includes('Connecting to')) {
                console.error(`❌ [${serviceName}] Ошибка: ${error}`);
            }
        });
        
        railway.on('close', (code) => {
            console.log(`🔌 Логи ${serviceName} завершены с кодом ${code}`);
            this.processes.delete(serviceName);
        });
        
        railway.on('error', (error) => {
            console.error(`❌ Ошибка запуска логов ${serviceName}:`, error.message);
        });
        
        this.processes.set(serviceName, railway);
        return railway;
    }

    // Обработка логов с фильтрацией
    processLogs(serviceName, logs) {
        const lines = logs.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
            const timestamp = new Date().toLocaleString('ru-RU');
            
            // Фильтруем по важности
            if (this.isPoolRelated(line)) {
                console.log(`🏊 [${serviceName}] ${timestamp}: ${line}`);
            } else if (this.isError(line)) {
                console.log(`❌ [${serviceName}] ${timestamp}: ${line}`);
            } else if (this.isOHLCVRelated(line)) {
                console.log(`📈 [${serviceName}] ${timestamp}: ${line}`);
            } else if (this.isWebSocketRelated(line)) {
                console.log(`🔌 [${serviceName}] ${timestamp}: ${line}`);
            } else if (this.isImportant(line)) {
                console.log(`🔥 [${serviceName}] ${timestamp}: ${line}`);
            }
            // Обычные логи не показываем чтобы не засорять вывод
        }
    }

    isPoolRelated(line) {
        return line.toLowerCase().includes('pool') || 
               line.includes('[WS POOL') || 
               line.includes('Pool') ||
               line.includes('initialize');
    }

    isError(line) {
        return line.toLowerCase().includes('error') || 
               line.toLowerCase().includes('ошибка') ||
               line.toLowerCase().includes('failed') ||
               line.toLowerCase().includes('exception');
    }

    isOHLCVRelated(line) {
        return line.includes('OHLCV') || 
               line.includes('candle') || 
               line.includes('свеча') ||
               line.includes('заполнение');
    }

    isWebSocketRelated(line) {
        return line.includes('WebSocket') || 
               line.includes('WS') ||
               line.includes('подключен') ||
               line.includes('connected');
    }

    isImportant(line) {
        const keywords = ['запуск', 'start', 'остановка', 'stop', 'новый', 'new'];
        return keywords.some(keyword => line.toLowerCase().includes(keyword));
    }

    // Запуск мониторинга всех сервисов
    async startMonitoring() {
        console.log('🚀 Запуск мониторинга Railway логов...');
        console.log('Нажмите Ctrl+C для остановки\n');
        
        // Запускаем мониторинг для каждого сервиса
        for (const service of this.services) {
            this.startServiceLogs(service.name);
            // Небольшая задержка между запусками
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Обработка завершения
        process.on('SIGINT', () => {
            this.stopMonitoring();
        });
        
        console.log(`✅ Мониторинг запущен для ${this.services.length} сервисов`);
    }

    // Остановка мониторинга
    stopMonitoring() {
        console.log('\n🛑 Остановка мониторинга логов...');
        
        for (const [serviceName, process] of this.processes) {
            console.log(`🔌 Остановка ${serviceName}...`);
            process.kill();
        }
        
        this.processes.clear();
        console.log('✅ Мониторинг остановлен');
        process.exit(0);
    }

    // Мониторинг только одного сервиса
    async monitorService(serviceName) {
        console.log(`🚀 Мониторинг логов ${serviceName}...`);
        console.log('Нажмите Ctrl+C для остановки\n');
        
        this.startServiceLogs(serviceName);
        
        process.on('SIGINT', () => {
            this.stopMonitoring();
        });
    }
}

// Использование
async function main() {
    const args = process.argv.slice(2);
    const monitor = new SimpleRailwayMonitor();
    
    if (args.length > 0) {
        const serviceName = args[0];
        await monitor.monitorService(serviceName);
    } else {
        await monitor.startMonitoring();
    }
}

if (require.main === module) {
    main();
}

module.exports = SimpleRailwayMonitor; 