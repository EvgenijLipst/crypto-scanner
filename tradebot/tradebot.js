const { Client: PgClient } = require("pg");

// Убедитесь, что эта переменная установлена на Railway
const DATABASE_URL = process.env.DATABASE_URL;

const db  = new PgClient({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function cleanupDatabase() {
    console.log("--- ЗАПУСК СКРИПТА-ЧИСТИЛЬЩИКА ---");
    try {
        await db.connect();
        console.log("Подключились к базе данных...");

        console.log("Удаляем старую таблицу 'positions', если она существует...");
        await db.query("DROP TABLE IF EXISTS positions;");
        console.log("✅ Таблица 'positions' удалена.");

        console.log("Удаляем старую таблицу 'trades', если она существует...");
        await db.query("DROP TABLE IF EXISTS trades;");
        console.log("✅ Таблица 'trades' удалена.");

        console.log("\n--- ОЧИСТКА ЗАВЕРШЕНА УСПЕШНО! ---");
        console.log("Теперь вы можете вставлять финальную версию торгового бота.");

    } catch (e) {
        console.error("❌ ПРОИЗОШЛА ОШИБКА ПРИ ОЧИСТКЕ:", e);
    } finally {
        await db.end();
        console.log("Отключились от базы данных.");
    }
}

cleanupDatabase();