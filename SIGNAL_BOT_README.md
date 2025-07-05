# 🤖 Advanced Solana Signal Bot

Продвинутый сигнальный бот для торговли токенами Solana с техническим анализом и WebSocket мониторингом через Helius.

## 🎯 Особенности

### ✅ **Что реализовано:**

- **Helius WebSocket** - реального времени мониторинг всех swap и pool init событий
- **Фильтрация по возрасту** - только токены старше 14 дней
- **Технический анализ:**
  - EMA 9/21 пересечение (bullish cross)
  - Volume spike (3x+ против среднего)
  - RSI выход из oversold зоны (<35)
- **Risk-фильтры:**
  - Минимальная ликвидность $10,000
  - Максимальный FDV $5,000,000
  - Price impact через Jupiter ≤3%
- **Telegram уведомления** с детальной информацией
- **Автоматическая очистка** старых данных
- **Статистика работы** каждый час

### 🔧 **Архитектура:**

1. **Helius WebSocket** → отслеживает все AMM транзакции
2. **PostgreSQL** → хранение OHLCV данных и пулов
3. **Technical Analysis** → собственная реализация EMA, RSI, Volume Spike
4. **Jupiter API** → проверка price impact
5. **Telegram Bot** → уведомления о сигналах

## 🚀 Установка и настройка

### 1. Клонирование и установка зависимостей:

```bash
git clone <repository>
cd crypto-scanner
npm install
```

### 2. Настройка переменных окружения:

Скопируйте `env.example` в `.env` и заполните:

```bash
# Database Configuration
DATABASE_URL=postgres://username:password@host:port/database?ssl=true

# Helius API Configuration
HELIUS_API_KEY=your_helius_api_key_here

# Telegram Bot Configuration
TELEGRAM_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here
```

### 3. Получение API ключей:

#### **Helius API Key:**

1. Зарегистрируйтесь на [helius.dev](https://www.helius.dev/)
2. Создайте новый проект
3. Скопируйте API ключ

#### **Telegram Bot:**

1. Найдите [@BotFather](https://t.me/botfather) в Telegram
2. Создайте нового бота: `/newbot`
3. Получите токен
4. Для получения Chat ID отправьте сообщение боту и используйте:

```bash
curl https://api.telegram.org/bot<TOKEN>/getUpdates
```

#### **PostgreSQL Database:**

- **Railway:** [railway.app](https://railway.app/) - бесплатная PostgreSQL
- **Supabase:** [supabase.com](https://supabase.com/) - бесплатный tier
- **ElephantSQL:** [elephantsql.com](https://elephantsql.com/) - бесплатный план

### 4. Запуск:

#### Разработка:

```bash
npm run signal-bot:dev
```

#### Продакшн:

```bash
npm run signal-bot
```

## 📊 Логика сигналов

### **Критерии токена:**

- ✅ Возраст ≥ 14 дней
- ✅ Ликвидность ≥ $10,000
- ✅ FDV ≤ $5,000,000
- ✅ Price Impact ≤ 3% (Jupiter)

### **Технические условия:**

- ✅ **EMA Cross:** EMA9 пересекает EMA21 вверх
- ✅ **Volume Spike:** Последние 5 минут ≥ 3x среднего (30 мин)
- ✅ **RSI:** < 35 (выход из oversold)

### **Пример сигнала:**

```
📈 BUY SIGNAL 📈

🪙 Token: A1B2C3...

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

## 🔧 Конфигурация

Все пороговые значения настраиваются через константы в `src/types.ts`:

```typescript
export const MIN_TOKEN_AGE_DAYS = 14;
export const MIN_LIQUIDITY_USD = 10_000;
export const MAX_FDV_USD = 5_000_000;
export const MIN_VOLUME_SPIKE = 3;
export const MAX_RSI_OVERSOLD = 35;
export const MAX_PRICE_IMPACT_PERCENT = 3;
```

## 📈 Мониторинг

### **Логи:**

Все события логируются с временными метками:

```
[2025-01-03T13:40:00.000Z] [INFO] Signal Bot started successfully
[2025-01-03T13:41:00.000Z] [INFO] Buy signal generated for A1B2C3...
[2025-01-03T13:42:00.000Z] [INFO] Signal sent successfully for A1B2C3...
```

### **Статистика (каждый час):**

```
📊 Signal Bot Stats 📊

🔄 Processing:
• Signals Processed: 15
• Signals Sent: 3
• Tokens Analyzed: 1,247

⏱️ Uptime: 2.5 hours
```

## 🏗️ Структура проекта

```
src/
├── types.ts          # Типы и константы
├── utils.ts          # Утилиты (время, форматирование)
├── database.ts       # PostgreSQL операции
├── helius.ts         # WebSocket подключение
├── indicators.ts     # Технический анализ (EMA, RSI)
├── jupiter.ts        # Price impact проверки
├── telegram.ts       # Уведомления
└── index.ts          # Главный файл

schema.sql            # SQL схема БД
start-signal-bot.js   # Скрипт запуска
```

## 🔄 Deployment на Railway

### 1. Подготовка:

```bash
# Установить Railway CLI
npm install -g @railway/cli

# Логин
railway login
```

### 2. Деплой:

```bash
# Создать проект
railway init

# Добавить PostgreSQL
railway add postgresql

# Установить переменные окружения
railway variables set HELIUS_KEY=your_key
railway variables set TELEGRAM_TOKEN=your_token
railway variables set TELEGRAM_CHAT_ID=your_chat_id

# Деплой
railway deploy
```

### 3. Настройка автозапуска:

В Railway Dashboard установите Start Command:

```bash
npm run signal-bot
```

## ⚠️ Важные замечания

### **Лимиты Helius:**

- Бесплатный план: ограниченное количество WebSocket подключений
- Проверьте лимиты в [dashboard](https://dashboard.helius.dev/)

### **PostgreSQL:**

- Регулярно очищаются данные старше 24 часов
- Рекомендуется периодический бэкап

### **Производительность:**

- Анализ токенов: каждую минуту
- Отправка сигналов: каждые 20 секунд
- RAM usage: ~50-100MB

## 🛠️ Дополнительные функции

### **Бэктестинг (будущее):**

```typescript
// Планируется добавить:
// - Загрузка исторических данных через Helius
// - Симуляция сигналов на исторических данных
// - Анализ прибыльности стратегии
```

### **Дополнительные индикаторы:**

```typescript
// Возможные добавления:
// - MACD дивергенция
// - On-Balance Volume (OBV)
// - Bollinger Bands
// - Fibonacci retracements
```

## 📞 Поддержка

При возникновении проблем:

1. **Проверьте логи** - все ошибки логируются с деталями
2. **Telegram уведомления** - бот сам сообщит о критических ошибках
3. **PostgreSQL подключение** - убедитесь в валидности DATABASE_URL
4. **API ключи** - проверьте правильность всех токенов

## 📝 Changelog

### v1.0.0 (Текущая версия)

- ✅ Базовая архитектура с Helius WebSocket
- ✅ Технический анализ (EMA, RSI, Volume)
- ✅ Risk-фильтры через Jupiter API
- ✅ Telegram уведомления
- ✅ Автоматическая очистка данных

### Планы v1.1.0:

- 🔄 Улучшенный парсинг transaction logs
- 🔄 Дополнительные AMM протоколы
- 🔄 Веб-интерфейс для мониторинга
- 🔄 Бэктестинг функционал

---

_Создано с ❤️ для Solana DeFi трейдинга_
