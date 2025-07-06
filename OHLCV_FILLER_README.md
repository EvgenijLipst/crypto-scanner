# OHLCV Filler - Гибридная схема заполнения OHLCV

Автоматическое заполнение базы OHLCV для всех токенов из таблицы `coin_data` с использованием гибридного подхода.

## 🎯 Что делает OHLCV Filler

1. **Обрабатывает все токены** из таблицы `coin_data`
2. **Создает пустые свечи** для токенов без торговой активности
3. **Использует гибридный подход** для получения цен:
   - Сначала пытается использовать последнюю известную цену из базы
   - Если нет - получает цену с Coingecko API
4. **Запускается по расписанию** (по умолчанию каждую минуту)

## 🚀 Быстрый старт

### 1. Установка зависимостей

```bash
npm install
```

### 2. Настройка переменных окружения

Добавьте в `.env` файл:

```env
DATABASE_URL=postgresql://user:password@host:port/database
COINGECKO_API_KEY=your_api_key_here  # опционально
OHLCV_FILL_INTERVAL_MINUTES=1        # интервал в минутах
```

### 3. Запуск

```bash
node start-ohlcv-filler.js
```

## 📊 Как это работает

### Алгоритм заполнения OHLCV

1. **Получение токенов**: Загружает все токены из таблицы `coin_data`
2. **Проверка свечей**: Для каждого токена проверяет, есть ли свеча за текущий период
3. **Создание пустых свечей**: Если свечи нет - создает "пустую" свечу:
   - `open = high = low = close = price`
   - `volume = 0`
4. **Получение цен**: Использует приоритетную схему:
   - **Приоритет 1**: Последняя известная цена из базы OHLCV
   - **Приоритет 2**: Цена с Coingecko API (если доступна)

### Пример пустой свечи

```sql
INSERT INTO ohlcv (mint, ts, o, h, l, c, v)
VALUES ('token_mint', 1640995200, 0.001234, 0.001234, 0.001234, 0.001234, 0);
```

## 🔧 Конфигурация

### Переменные окружения

| Переменная                    | Описание                                    | По умолчанию    |
| ----------------------------- | ------------------------------------------- | --------------- |
| `DATABASE_URL`                | Строка подключения к PostgreSQL             | **обязательно** |
| `COINGECKO_API_KEY`           | API ключ Coingecko (для увеличения лимитов) | `null`          |
| `OHLCV_FILL_INTERVAL_MINUTES` | Интервал запуска в минутах                  | `1`             |

### Настройка интервалов

- **1 минута**: Для активных токенов с частыми сделками
- **5 минут**: Для малоликвидных токенов
- **15 минут**: Для очень редких токенов

## 📈 Интеграция с существующей системой

### WebSocket Helius + OHLCV Filler

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   WebSocket     │    │   OHLCV Filler  │    │   Database      │
│   Helius        │    │                 │    │                 │
│                 │    │                 │    │                 │
│ • Real-time     │───▶│ • Fill gaps     │───▶│ • coin_data     │
│   swap events   │    │ • Get prices    │    │ • ohlcv         │
│ • Active tokens │    │ • Empty candles │    │ • signals       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Приоритет данных

1. **WebSocket Helius**: Реальные swap события → точные OHLCV
2. **OHLCV Filler**: Пустые свечи → заполнение пробелов
3. **Coingecko API**: Резервные цены → для токенов без истории

## 🛠️ Использование в коде

### Инициализация

```javascript
const { Database } = require("./src/database");
const { OHLCVFiller } = require("./src/fill-empty-ohlcv");

const database = new Database(process.env.DATABASE_URL);
await database.initialize();

const ohlcvFiller = new OHLCVFiller(database, process.env.COINGECKO_API_KEY);
```

### Запуск

```javascript
// Запуск с интервалом 1 минута
ohlcvFiller.start(1);

// Остановка
ohlcvFiller.stop();

// Получение статистики
const stats = ohlcvFiller.getStats();
console.log(stats.isRunning); // true/false
```

### Интеграция с основным ботом

```javascript
// В основном файле бота
const ohlcvFiller = new OHLCVFiller(database, coingeckoApiKey);

// Запускаем вместе с WebSocket
heliusWebSocket.connect();
ohlcvFiller.start(1);

// Graceful shutdown
process.on("SIGINT", async () => {
  heliusWebSocket.disconnect();
  ohlcvFiller.stop();
  await database.close();
});
```

## 📊 Мониторинг и логи

### Логи OHLCV Filler

```
🚀 Starting OHLCV filler with 1 minute interval
🔄 Starting OHLCV fill cycle...
📊 Processing 1250 tokens from coin_data
🌐 Fetching Coingecko prices for batch 1/5 (250 tokens)
📈 Using last known price for SOL: $98.45
📊 Created empty candle for SOL at 1640995200 with price 98.45
✅ OHLCV fill cycle completed:
   • Processed: 1250 tokens
   • Empty candles created: 847
   • Prices fetched from Coingecko: 156
```

### Статистика работы

- **Processed**: Количество обработанных токенов
- **Empty candles created**: Количество созданных пустых свечей
- **Prices fetched from Coingecko**: Количество цен, полученных с Coingecko

## 🔍 Диагностика

### Проверка работы

```sql
-- Проверить количество свечей в OHLCV
SELECT COUNT(*) FROM ohlcv;

-- Проверить свечи за последний час
SELECT mint, COUNT(*) as candle_count
FROM ohlcv
WHERE ts >= EXTRACT(EPOCH FROM NOW() - INTERVAL '1 hour')
GROUP BY mint
ORDER BY candle_count DESC;

-- Проверить токены без свечей
SELECT cd.mint, cd.symbol
FROM coin_data cd
LEFT JOIN ohlcv o ON cd.mint = o.mint
WHERE o.mint IS NULL;
```

### Частые проблемы

1. **Нет свечей создается**

   - Проверьте подключение к базе данных
   - Убедитесь, что в `coin_data` есть токены
   - Проверьте логи на ошибки

2. **Много запросов к Coingecko**

   - Получите API ключ Coingecko для увеличения лимитов
   - Увеличьте интервал запуска

3. **Высокое потребление ресурсов**
   - Уменьшите частоту запуска
   - Ограничьте количество токенов в `coin_data`

## 🚀 Развертывание

### Локальный запуск

```bash
node start-ohlcv-filler.js
```

### PM2 (рекомендуется)

```bash
pm2 start start-ohlcv-filler.js --name "ohlcv-filler"
pm2 save
pm2 startup
```

### Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "start-ohlcv-filler.js"]
```

## 📝 Лицензия

MIT License
