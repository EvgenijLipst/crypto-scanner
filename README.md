# 🤖 Solana Signal Bot

Продвинутый сигнальный бот для торговли токенами Solana с техническим анализом и WebSocket мониторингом через Helius.

## 🚀 Быстрый старт

### 1. Клонирование проекта:

```bash
git clone https://github.com/EvgenijLipst/crypto-scanner.git
cd crypto-scanner
npm install
```

### 2. Настройка переменных окружения:

Скопируйте `env.example` в `.env` и заполните:

```env
DATABASE_URL=postgres://username:password@host:port/database?ssl=true
HELIUS_KEY=your_helius_api_key_here
TELEGRAM_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here
```

### 3. Запуск:

**Разработка:**

```bash
npm run dev
```

**Продакшн:**

```bash
npm start
```

## 📊 Как работает

### **Критерии сигналов:**

- ✅ Возраст токена ≥ 14 дней
- ✅ Ликвидность ≥ $10,000
- ✅ FDV ≤ $5,000,000
- ✅ Price Impact ≤ 3% (Jupiter)

### **Технические условия:**

- ✅ **EMA Cross:** EMA9 пересекает EMA21 вверх
- ✅ **Volume Spike:** Последние 5 минут ≥ 3x среднего (30 мин)
- ✅ **RSI:** < 35 (выход из oversold)

### **Пример Telegram сигнала:**

```
📈 BUY SIGNAL 📈

🪙 Token: A1B2C3D4E5F6...

📊 Technical Analysis:
• EMA Cross: ✅
• Volume Spike: x4.2 ✅
• RSI: 28.5 ✅

💰 Pool Info:
• Liquidity: $15,450
• FDV: $2,100,000
• Price Impact: 1.8%

🔗 Links:
📊 Birdeye | 📈 DEXScreener
```

## 🏗️ Архитектура

1. **Helius WebSocket** → отслеживает все AMM транзакции
2. **PostgreSQL** → хранение OHLCV данных и пулов
3. **Technical Analysis** → собственная реализация EMA, RSI, Volume Spike
4. **Jupiter API** → проверка price impact
5. **Telegram Bot** → уведомления о сигналах

## 📁 Структура проекта

```
src/
├── types.ts          # Типы и константы
├── utils.ts          # Утилиты
├── database.ts       # PostgreSQL операции
├── helius.ts         # WebSocket подключение
├── indicators.ts     # Технический анализ
├── jupiter.ts        # Price impact проверки
├── telegram.ts       # Уведомления
└── index.ts          # Главный файл

tradebot/             # Торговый бот Jupiter
├── tradebot.js       # Основной файл торгового бота
├── package.json      # Зависимости торгового бота
└── ...

schema.sql            # SQL схема БД
start-signal-bot.js   # Скрипт запуска сигнального бота
env.example          # Пример переменных окружения
railway.json         # Конфигурация Railway деплоя
```

## 🔄 Deployment на Railway

Railway деплоит **торговый бот** из папки `tradebot/`:

1. Подключите GitHub репозиторий к Railway
2. Добавьте PostgreSQL сервис
3. Установите переменные окружения
4. Railway автоматически запустит торговый бот

**Для деплоя сигнального бота** отдельно - измените Root Directory в Railway на корень проекта.

## 📖 Подробная документация

Смотрите [SIGNAL_BOT_README.md](./SIGNAL_BOT_README.md) для:

- Подробных инструкций по настройке
- Получения API ключей
- Примеров конфигурации
- Troubleshooting

## 📈 Мониторинг

Бот автоматически отправляет:

- ✅ **Сигналы покупки** при обнаружении
- ✅ **Статистику работы** каждый час
- ✅ **Уведомления об ошибках** в Telegram

---

_Создано с ❤️ для Solana DeFi трейдинга_
