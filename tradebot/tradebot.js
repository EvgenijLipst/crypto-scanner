const { Connection, Keypair, VersionedTransaction, PublicKey } = require("@solana/web3.js");
const fetch = require("cross-fetch");
const bs58 = require("bs58");

// --- ОСНОВНЫЕ НАСТРОЙКИ ---
const SOLANA_RPC_URL = "https://crimson-falling-sanctuary.solana-mainnet.quiknode.pro/0a9313016dd3d9829cbf8e3f9f7314f14d467d61/";
const WALLET_PRIVATE_KEY = "49uurdQjJzZy1548UWrjvcTCoTLXdJFa9mbgTHzHymkgrwFA2hS6Ydbge42VG1C6gaGmAFJ42fbHqQSQTdZtcUMs";

// На что покупаем (USDC)
const INPUT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const INPUT_DECIMALS = 6;

// Что покупаем 
const OUTPUT_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"; // Пример: JUP

// Сумма покупки в USDC (1.0 = 1 USDC)
const AMOUNT_TO_SWAP_USD = 1.0;

// Настройки Трейлинг Стоп-Лосса
const TRAILING_STOP_PERCENTAGE = 4.5;
const PRICE_CHECK_INTERVAL_MS = 5000;

// --- НАСТРОЙКИ БЕЗОПАСНОСТИ ---
const SAFE_PRICE_IMPACT_PERCENT = 0.02;

// ---------------------------------


// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---
async function getQuote(inputMint, outputMint, amount, slippageBps = 50) {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    const response = await fetch(url);
    if (!response.ok) {
        // console.error("Ошибка при запросе к Jupiter API:", await response.text());
        throw new Error(`Failed to get quote: ${response.statusText}`);
    }
    return response.json();
}

async function getSwapTransaction(quoteResponse, userPublicKey) {
    const response = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quoteResponse,
            userPublicKey,
            wrapAndUnwrapSol: true,
            asLegacyTransaction: false,
            computeUnitPriceMicroLamports: "auto"
        })
    });
    if (!response.ok) throw new Error(`Failed to get swap transaction: ${response.statusText}`);
    return response.json();
}

async function executeTransaction(connection, rawTransaction, wallet) {
    const txBuf = Buffer.from(rawTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(txBuf);
    transaction.sign([wallet]);
    const txid = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true,
        maxRetries: 5
    });
    const confirmation = await connection.confirmTransaction(txid, 'confirmed');
    if (confirmation.value.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
    }
    return txid;
}


// --- ФУНКЦИЯ ПРОВЕРКИ БЕЗОПАСНОСТИ ---
async function runAdvancedSafetyCheck(outputMint, inputMint, inputDecimals) {
    console.log(`\n--- ПРОВЕРКА БЕЗОПАСНОСТИ ДЛЯ ${outputMint} ---`);
    try {
        console.log("Этап А: Определение цены...");
        const amountForPriceCheck = 10 * Math.pow(10, inputDecimals);
        const priceQuote = await getQuote(inputMint, outputMint, amountForPriceCheck);
        const amountOfTokensFor10USD = parseInt(priceQuote.outAmount);
        
        if (amountOfTokensFor10USD === 0) throw new Error("Не удалось определить цену, токен не торгуется.");
        
        const amountToSimulateSell = amountOfTokensFor10USD * 5;
        console.log(`Определили, что ~$50 это примерно ${amountToSimulateSell} единиц токена.`);

        console.log("Этап Б: Симуляция ПРОДАЖИ...");
        const sellQuote = await getQuote(outputMint, inputMint, amountToSimulateSell);
        const priceImpact = parseFloat(sellQuote.priceImpactPct) * 100;

        console.log(`Симуляция ПРОДАЖИ на ~$50. Влияние на цену (Price Impact): ${priceImpact.toFixed(4)}%`);
        if (priceImpact > SAFE_PRICE_IMPACT_PERCENT) {
            console.error(`❌ ОПАСНО: Влияние на цену при ПРОДАЖЕ (${priceImpact.toFixed(4)}%) выше порога в ${SAFE_PRICE_IMPACT_PERCENT}%.`);
            return false;
        }

        console.log(`✅ БЕЗОПАСНО: Токен можно купить и продать. Влияние на цену в норме.`);
        return true;

    } catch (error) {
        console.error(`❌ КРИТИЧЕСКАЯ ОПАСНОСТЬ: Проверка безопасности провалена.`);
        console.error(error.message);
        return false;
    }
}

// --- НОВАЯ ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ ПОИСКА БАЛАНСА ---
async function findTokenBalance(connection, wallet, tokenMint) {
    try {
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
            wallet.publicKey, { mint: new PublicKey(tokenMint) }, 'confirmed'
        );
        if (tokenAccounts.value.length > 0 && tokenAccounts.value[0].account.data.parsed.info.tokenAmount.lamports > 0) {
            return {
                found: true,
                balance: parseInt(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.lamports)
            };
        }
    } catch(e) {
        console.error("Ошибка при поиске баланса:", e.message);
    }
    return { found: false, balance: 0 };
}


// --- ОСНОВНАЯ ЛОГИКА ---
const main = async () => {
    console.log("--- ЗАПУСК ТОРГОВОГО БОТА ---");

    const wallet = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
    const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

    const isSafe = await runAdvancedSafetyCheck(OUTPUT_MINT, INPUT_MINT, INPUT_DECIMALS);
    if (!isSafe) {
        console.log("\n--- Завершение работы из-за провала проверки безопасности. ---");
        return;
    }

    console.log(`\n--- ФАЗА 1: ПОКУПКА ---`);
    console.log(`Используем кошелек: ${wallet.publicKey.toBase58()}`);
    let buyTxid;
    try {
        const amountInSmallestUnit = Math.round(AMOUNT_TO_SWAP_USD * Math.pow(10, INPUT_DECIMALS));
        const buyQuote = await getQuote(INPUT_MINT, OUTPUT_MINT, amountInSmallestUnit);
        const { swapTransaction } = await getSwapTransaction(buyQuote, wallet.publicKey.toBase58());
        buyTxid = await executeTransaction(connection, swapTransaction, wallet);
        console.log(`✅ Покупка успешно выполнена! Транзакция: https://solscan.io/tx/${buyTxid}`);
    } catch (e) {
        console.error("❌ Ошибка при покупке:", e);
        return;
    }

    console.log(`\n--- ФАЗА 2: ТРЕЙЛИНГ СТОП-ЛОСС ---`);
    let highestPrice = 0;
    
    while (true) {
        try {
            await new Promise(resolve => setTimeout(resolve, PRICE_CHECK_INTERVAL_MS));
            
            const tokenInfo = await connection.getParsedAccountInfo(new PublicKey(OUTPUT_MINT));
            if (!tokenInfo || !tokenInfo.value) continue;
            const tokenDecimals = tokenInfo.value.data.parsed.info.decimals;
            const amountForPriceCheck = Math.pow(10, tokenDecimals);
            const priceQuote = await getQuote(OUTPUT_MINT, INPUT_MINT, amountForPriceCheck, 50); 
            const currentPrice = (priceQuote.outAmount / Math.pow(10, INPUT_DECIMALS));

            if (highestPrice === 0) highestPrice = currentPrice;
            if (currentPrice > highestPrice) highestPrice = currentPrice;
            
            const stopPrice = highestPrice * (1 - TRAILING_STOP_PERCENTAGE / 100);
            console.log(`Текущая цена: ${currentPrice.toFixed(8)} | Пик цены: ${highestPrice.toFixed(8)} | Стоп-цена: ${stopPrice.toFixed(8)}`);

            if (currentPrice <= stopPrice && highestPrice > 0) {
                
                // --- НАЧАЛО НОВОГО БЛОКА "УМНОЙ ПРОДАЖИ" ---
                console.log(`\n⚠️ Сработал Трейлинг Стоп-Лосс! Запускаем каскадную продажу...`);
                
                let { found, balance } = await findTokenBalance(connection, wallet, OUTPUT_MINT);

                if (!found || balance === 0) {
                    console.log("Нечего продавать. Баланс токена не найден или равен нулю.");
                    break;
                }

                const sellPortions = [100, 50, 25]; // Пробуем продать 100%, потом 50% остатка, потом 25%
                let soldSuccessfully = false;

                for (const portion of sellPortions) {
                    if (balance === 0) break;

                    const amountToSell = Math.floor(balance * (portion / 100));
                    console.log(`\nПопытка продать ${portion}% остатка (${amountToSell} единиц)...`);

                    try {
                        const sellQuote = await getQuote(OUTPUT_MINT, INPUT_MINT, amountToSell);
                        const { swapTransaction } = await getSwapTransaction(sellQuote, wallet.publicKey.toBase58());
                        const sellTxid = await executeTransaction(connection, swapTransaction, wallet);
                        console.log(`✅ Успешно продано! Транзакция: https://solscan.io/tx/${sellTxid}`);
                        
                        // Короткая пауза для обновления состояния сети
                        await new Promise(resolve => setTimeout(resolve, 8000));
                        const result = await findTokenBalance(connection, wallet, OUTPUT_MINT);
                        balance = result.balance;

                    } catch(e) {
                        console.log(`   ⚠️ Попытка продать ${portion}% не удалась. Уменьшаем размер...`);
                        // Не обновляем баланс, так как сделка не прошла
                    }
                }
                
                if (balance === 0) {
                    console.log("\n✅ Весь баланс токена успешно продан.");
                } else {
                    console.log(`\n❌ Не удалось продать оставшийся баланс (${balance} единиц). Требуется ручное вмешательство.`);
                }
                
                soldSuccessfully = true;
                if(soldSuccessfully) break; // Выходим из основного цикла while
                // --- КОНЕЦ БЛОКА "УМНОЙ ПРОДАЖИ" ---
            }
        } catch (e) {
            console.error("Ошибка в цикле трейлинга:", e);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    console.log("--- Работа бота завершена. ---");
};

main();