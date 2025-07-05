# Исправление проблемы с сохранением токенов в coin_data

## Проблема

Сигнал бот получает данные о токенах через CoinGecko API, но не сохраняет их в таблицу `coin_data` в PostgreSQL на Railway.

## Причина проблемы

В методе `saveTokensToCoinData` использовался неправильный `coinId` - вместо реального ID токена из CoinGecko API использовался `token.symbol.toLowerCase()`.

## Исправления

### 1. Обновлен интерфейс SolanaToken

В `src/coingecko.ts` добавлено поле `coinId`:

```typescript
export interface SolanaToken {
  coinId: string; // Добавлено поле coinId
  mint: string;
  symbol: string;
  name: string;
  // ... остальные поля
}
```

### 2. Исправлено создание токенов

В методе `getMarketDataForTokens` теперь добавляется правильный `coinId`:

```typescript
const solanaToken = {
  coinId: token.id, // Используем реальный ID из CoinGecko
  mint: token.platforms!.solana!,
  // ... остальные поля
};
```

### 3. Исправлено сохранение в базу данных

В `src/token-analyzer.ts` метод `saveTokensToCoinData` теперь использует правильный `coinId`:

```typescript
const coinDataTokens = tokens.map((token) => ({
  coinId: token.coinId, // Используем правильный coinId из CoinGecko API
  mint: token.mint,
  // ... остальные поля
}));
```

### 4. Исправлена загрузка из базы данных

В методе `loadTokensFromDatabase` добавлено поле `coinId`:

```typescript
const tokens: SolanaToken[] = freshTokens
  .filter((row) => row.mint && !row.mint.includes("placeholder"))
  .map((row) => ({
    coinId: row.coin_id, // Используем coin_id из базы данных
    mint: row.mint,
    // ... остальные поля
  }));
```

## Тестирование исправлений

### Локальное тестирование

```bash
# Установите переменные окружения
export DATABASE_URL="your_railway_database_url"
export COINGECKO_API_KEY="your_coingecko_api_key"

# Запустите тестовый скрипт
node test-coin-data-save.js
```

### Принудительное обновление на Railway

```bash
# Запустите скрипт принудительного обновления
node force-coin-data-update.js
```

## Проверка результатов

### 1. Проверка количества записей

```sql
SELECT COUNT(*) FROM coin_data;
```

### 2. Проверка свежих записей

```sql
SELECT coin_id, symbol, name, mint, price, volume, timestamp
FROM coin_data
WHERE timestamp > NOW() - INTERVAL '1 hour'
ORDER BY timestamp DESC
LIMIT 10;
```

### 3. Проверка уникальности

```sql
SELECT coin_id, network, COUNT(*) as count
FROM coin_data
GROUP BY coin_id, network
HAVING COUNT(*) > 1
ORDER BY count DESC;
```

## Ожидаемые результаты

После исправления:

1. ✅ Токены будут корректно сохраняться в таблицу `coin_data`
2. ✅ `coin_id` будет содержать правильный ID из CoinGecko API
3. ✅ Уникальное ограничение `coin_data_coin_network_uidx` будет работать корректно
4. ✅ Сигнал бот сможет загружать токены из базы данных вместо постоянных запросов к CoinGecko

## Мониторинг

После внедрения исправлений следите за:

- Логами в Telegram о количестве загруженных токенов
- Количеством записей в таблице `coin_data`
- Использованием CoinGecko API (должно уменьшиться)

## Дополнительные улучшения

1. **Кэширование**: Токены теперь кэшируются на 48 часов
2. **Оптимизация API**: Сначала проверяется база данных, потом CoinGecko
3. **Очистка старых данных**: Автоматическая очистка записей старше 72 часов
4. **Обработка ошибок**: Улучшена обработка ошибок при сохранении

## Команды для развертывания

```bash
# Пересборка и развертывание на Railway
npm run build
git add .
git commit -m "Fix coin_data save issue - use proper coinId from CoinGecko API"
git push

# Или принудительное обновление через Railway CLI
railway up
```
