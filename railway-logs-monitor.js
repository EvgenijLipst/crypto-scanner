const { spawn } = require('child_process');
const fs = require('fs');

class RailwayLogsMonitor {
    constructor() {
        this.processes = new Map();
        this.isRunning = false;
    }

    // Проверяем установлен ли Railway CLI
    async checkRailwayCLI() {
        return new Promise((resolve) => {
            const check = spawn('railway', ['--version']);
            check.on('close', (code) => {
                resolve(code === 0);
            });
            check.on('error', () => {
                resolve(false);
            });
        });
    }

    // Получаем список всех сервисов
    async getServices() {
        return new Promise((resolve, reject) => {
            const railway = spawn('railway', ['service', 'list']);
            let output = '';
            
            railway.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            railway.on('close', (code) => {
                if (code === 0) {
                    // Парсим вывод для получения списка сервисов
                    const services = this.parseServices(output);
                    resolve(services);
                } else {
                    reject(new Error('Не удалось получить список сервисов'));
                }
            });
            
            railway.on('error', (error) => {
                reject(error);
            });
        });
    }

    parseServices(output) {
        const lines = output.split('\n');
        const services = [];
        
        for (const line of lines) {
            // Ищем строки с сервисами (обычно содержат ID)
            if (line.includes('│') && line.length > 10) {
                const parts = line.split('│').map(p => p.trim()).filter(p => p);
                if (parts.length >= 2) {
                    services.push({
                        id: parts[0],
                        name: parts[1] || parts[0]
                    });
                }
            }
        }
        
        return services;
    }

    // Запускаем мониторинг логов для конкретного сервиса
    startServiceLogs(service) {
        console.log(`🚀 Запуск мониторинга логов для ${service.name} (${service.id})`);
        
        const railway = spawn('railway', ['logs', '--service', service.id, '--follow']);
        
        railway.stdout.on('data', (data) => {
            const logs = data.toString();
            this.processLogs(service, logs);
        });
        
        railway.stderr.on('data', (data) => {
            console.error(`❌ Ошибка ${service.name}: ${data}`);
        });
        
        railway.on('close', (code) => {
            console.log(`🔌 Логи ${service.name} завершены с кодом ${code}`);
            this.processes.delete(service.id);
        });
        
        railway.on('error', (error) => {
            console.error(`❌ Ошибка запуска логов ${service.name}:`, error.message);
        });
        
        this.processes.set(service.id, railway);
    }

    // Обработка логов с фильтрацией важных событий
    processLogs(service, logs) {
        const lines = logs.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
            const timestamp = new Date().toLocaleString('ru-RU');
            
            // Фильтруем важные события
            if (this.isImportantLog(line)) {
                console.log(`🔥 [${service.name}] ${timestamp}: ${line}`);
            }
            
            // Специальная обработка для WebSocket событий
            if (line.includes('[WS POOL') || line.includes('pool') || line.includes('Pool')) {
                console.log(`🏊 [${service.name} POOL] ${timestamp}: ${line}`);
            }
            
            // Ошибки
            if (line.toLowerCase().includes('error') || line.toLowerCase().includes('ошибка')) {
                console.log(`❌ [${service.name} ERROR] ${timestamp}: ${line}`);
            }
            
            // OHLCV события
            if (line.includes('OHLCV') || line.includes('candle') || line.includes('свеча')) {
                console.log(`📈 [${service.name} OHLCV] ${timestamp}: ${line}`);
            }
            
            // Обычные логи (можно отключить если много)
            // console.log(`📋 [${service.name}] ${timestamp}: ${line}`);
        }
    }

    // Определяем важные логи
    isImportantLog(line) {
        const importantKeywords = [
            'pool', 'Pool', 'POOL',
            'initialize', 'init', 'создан',
            'WebSocket', 'WS',
            'новый', 'new',
            'подключен', 'connected',
            'отключен', 'disconnected',
            'запуск', 'start',
            'остановка', 'stop'
        ];
        
        return importantKeywords.some(keyword => 
            line.toLowerCase().includes(keyword.toLowerCase())
        );
    }

    // Запускаем мониторинг всех сервисов
    async startMonitoring() {
        console.log('🔍 Проверка Railway CLI...');
        
        const hasRailway = await this.checkRailwayCLI();
        if (!hasRailway) {
            console.error('❌ Railway CLI не установлен или не настроен');
            console.log('Установите: npm install -g @railway/cli');
            console.log('Авторизуйтесь: railway login');
            return;
        }
        
        console.log('✅ Railway CLI найден');
        console.log('🔍 Получение списка сервисов...');
        
        try {
            const services = await this.getServices();
            
            if (services.length === 0) {
                console.log('❌ Сервисы не найдены');
                return;
            }
            
            console.log(`✅ Найдено ${services.length} сервисов:`);
            services.forEach(service => {
                console.log(`  - ${service.name} (${service.id})`);
            });
            
            console.log('\n🚀 Запуск мониторинга логов...');
            console.log('Нажмите Ctrl+C для остановки\n');
            
            // Запускаем мониторинг для каждого сервиса
            for (const service of services) {
                this.startServiceLogs(service);
            }
            
            this.isRunning = true;
            
            // Обработка завершения
            process.on('SIGINT', () => {
                this.stopMonitoring();
            });
            
        } catch (error) {
            console.error('❌ Ошибка:', error.message);
        }
    }

    // Остановка мониторинга
    stopMonitoring() {
        console.log('\n🛑 Остановка мониторинга логов...');
        
        for (const [serviceId, process] of this.processes) {
            console.log(`🔌 Остановка ${serviceId}...`);
            process.kill();
        }
        
        this.processes.clear();
        this.isRunning = false;
        
        console.log('✅ Мониторинг остановлен');
        process.exit(0);
    }
}

// Альтернативный метод через Railway API (если есть токен)
class RailwayAPIMonitor {
    constructor(token) {
        this.token = token;
        this.baseURL = 'https://backboard.railway.app/graphql';
    }

    async getProjects() {
        // Здесь будет код для работы с Railway GraphQL API
        // Нужен токен доступа
        console.log('🔍 Railway API мониторинг (требует токен)');
    }
}

// Использование
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length > 0 && args[0] === 'api') {
        const token = args[1];
        if (!token) {
            console.log('❌ Укажите токен Railway API');
            console.log('Использование: node railway-logs-monitor.js api YOUR_TOKEN');
            return;
        }
        
        const apiMonitor = new RailwayAPIMonitor(token);
        await apiMonitor.getProjects();
    } else {
        const monitor = new RailwayLogsMonitor();
        await monitor.startMonitoring();
    }
}

if (require.main === module) {
    main();
}

module.exports = { RailwayLogsMonitor, RailwayAPIMonitor }; 