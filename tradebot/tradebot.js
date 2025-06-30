const {
    Connection,
    Keypair,
    PublicKey,
    VersionedTransaction,
    TransactionMessage
} = require("@solana/web3.js");
const {
    createApproveInstruction,
    createRevokeInstruction,
    getAssociatedTokenAddress
} = require("@solana/spl-token");
const fetch = require("cross-fetch");
const { AbortController } = require("abort-controller");
const bs58 = require("bs58");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");


// Генерируем уникальный ID для этого запуска бота


let isHalted = false;
let haltedMintAddress = null;
let haltedTradeId = null;
let manualSellConfirmations = 0;

// — Переменные окружения (Railway Variables) —
const SOLANA_RPC_URL                = process.env.SOLANA_RPC_URL;
const WALLET_PRIVATE_KEY            = process.env.WALLET_PRIVATE_KEY;
const DATABASE_URL                  = process.env.DATABASE_URL;
const TELEGRAM_TOKEN                = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID              = process.env.TELEGRAM_CHAT_ID;

const AMOUNT_TO_SWAP_USD            = parseFloat(process.env.AMOUNT_TO_SWAP_USD);
const TRAILING_STOP_PERCENTAGE      = parseFloat(process.env.TRAILING_STOP_PERCENTAGE);
const SAFE_PRICE_IMPACT_PERCENT     = parseFloat(process.env.SAFE_PRICE_IMPACT_PERCENT);
const PRICE_CHECK_INTERVAL_MS       = parseInt(process.env.PRICE_CHECK_INTERVAL_MS, 10) || 5000;
const SIGNAL_CHECK_INTERVAL_MS      = parseInt(process.env.SIGNAL_CHECK_INTERVAL_MS, 10) || 5000;
const SLIPPAGE_BPS                  = parseInt(process.env.SLIPPAGE_BPS, 10) || 50; 
const MAX_HOLDING_TIME_HOURS        = parseFloat(process.env.MAX_HOLDING_TIME_HOURS) || 24;
const TIMEOUT_SELL_PL_THRESHOLD     = parseFloat(process.env.TIMEOUT_SELL_PL_THRESHOLD) || -0.01;
const TSL_CONFIRMATIONS             = parseInt(process.env.TSL_CONFIRMATIONS, 10) || 3;
const MANUAL_SELL_CONFIRMATIONS     = parseInt(process.env.MANUAL_SELL_CONFIRMATIONS, 10) || 3;




// — Жёстко зашитые константы —
const USDC_MINT             = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DECIMALS         = 6;
const SWAP_PROGRAM_ID       = new PublicKey("JUP4Fb2cFoZz7n6RzbA7gHq9jz6yJ3zyZhftyPS87ya");
const COOLDOWN_HOURS        = 1.0;
const MIN_QUOTE_USDC_FOR_MONITOR = 10;
const MIN_DUST_AMOUNT = 0.0001;


// — Инициализация —
const bot = new Telegraf(TELEGRAM_TOKEN);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

let isPoolActive = true;

async function safeQuery(...args) {
    if (!isPoolActive) throw new Error("Attempted query after pool closed");
    return pool.query(...args);
}

// — Утилита: достать следующий сигнал из таблицы — 
async function fetchAllPendingSignals() {
    const ONE_MINUTE_AGO = new Date(Date.now() - 60 * 1000).toISOString();
    const res = await safeQuery(
      `SELECT id, token_mint
         FROM signals
        WHERE processed = false
          AND created_at > $1
        ORDER BY created_at;`,
      [ONE_MINUTE_AGO]
    );
    return res.rows.map(row => ({ id: row.id, mint: new PublicKey(row.token_mint) }));
}

  

// — Основные вспомогательные функции —

async function cleanupOldSignals() {
    // Удаляем сигналы старше 1 часа (processed=true или false — неважно)
    const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await safeQuery(
      `DELETE FROM signals WHERE created_at < $1 RETURNING id;`,
      [ONE_HOUR_AGO]
    );
    if (res.rowCount > 0) {
      console.log(`[Cleanup] Deleted ${res.rowCount} old signals`);
    }
  }

async function getQuote(inputMint, outputMint, amount, maxRetries = 3) {
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint.toBase58()}&outputMint=${outputMint.toBase58()}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[Quote] Attempt ${attempt}/${maxRetries}`);
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) throw new Error("Quote error: " + await res.text());
            const data = await res.json();
            return data;
        } catch (e) {
            lastErr = e;
            console.warn(`[Quote] Failed attempt ${attempt}/${maxRetries}: ${e.message}`);
            await new Promise(r => setTimeout(r, 2000));
            if (attempt === maxRetries) {
                throw lastErr;
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }
}




async function getSwapTransaction(quoteResponse, userPubKey, maxRetries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[SwapTx] Attempt ${attempt}/${maxRetries}`);
        const res = await fetch("https://quote-api.jup.ag/v6/swap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quoteResponse,
            userPublicKey: userPubKey,
            wrapAndUnwrapSol: true,
            asLegacyTransaction: false,
            computeUnitPriceMicroLamports: "auto"
          })
        });
        if (!res.ok) throw new Error("Swap tx error: " + await res.text());
        const data = await res.json();
        return { 
          swapTransaction: data.swapTransaction, 
          lastValidBlockHeight: data.lastValidBlockHeight 
        };
      } catch (e) {
        lastErr = e;
        console.warn(`[SwapTx] Failed attempt ${attempt}/${maxRetries}: ${e.message}`);
        await new Promise(r => setTimeout(r, 2000));
        if (attempt === maxRetries) throw lastErr;
      }
    }
  }
  

async function executeTransaction(connection, rawTx, wallet, lastValidBlockHeight) {
    console.log("[Execute] Sending transaction to network");
    const buf = Buffer.from(rawTx, "base64");
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([wallet]);
    const txid = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 5
    });
    console.log(`[Execute] tx sent: ${txid}, awaiting confirmation until block ${lastValidBlockHeight}`);

    try {
        // Пытаемся подтвердить как обычно
        const confirmation = await connection.confirmTransaction({
            signature: txid,
            blockhash: tx.message.recentBlockhash,
            lastValidBlockHeight: lastValidBlockHeight
        }, "confirmed");
    
        if (confirmation.value.err) {
            throw new Error(JSON.stringify(confirmation.value.err));
        }
    
    } catch (e) {
        console.warn(`[Confirm V1] Primary confirmation failed for ${txid}: ${e.message}`);
    
        if (e.message.includes("block height exceeded")) {
            console.log(`[Confirm V2] Starting fallback confirmation check for ${txid}...`);
            let found = false;
            for (let attempt = 1; attempt <= 5; attempt++) {
                const delayMs = attempt * 10000; // 10s, 20s, 30s, 40s, 50s
                await new Promise(resolve => setTimeout(resolve, delayMs));
                const txInfo = await connection.getTransaction(txid, { maxSupportedTransactionVersion: 0 });
                if (txInfo) {
                    console.log(`[Confirm V2] Fallback check successful on attempt ${attempt}! Transaction ${txid} is confirmed.`);
                    found = true;
                    break;
                }
                console.log(`[Confirm V2] Retry ${attempt}: Transaction ${txid} still not found. Retrying...`);
            }
            if (!found) {
                throw new Error(`[Confirm V2] Fallback check failed after 5 attempts. Transaction ${txid} not found.`);
            }
        } else {
            throw e;
        }
    }
    

    console.log(`[Execute] tx confirmed: ${txid}`);
    return txid;
}

async function executeSimpleTransaction(connection, instructions, wallet) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions,
    }).compileToV0Message();
     
    const tx = new VersionedTransaction(messageV0);
    tx.sign([wallet]);
    const txid = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
     
    try {
        const confirmation = await connection.confirmTransaction({
            signature: txid,
            blockhash: blockhash,
            lastValidBlockHeight: lastValidBlockHeight
        }, 'confirmed');

        if (confirmation.value.err) {
            throw new Error(JSON.stringify(confirmation.value.err));
        }
    } catch (e) {
        console.warn(`[Confirm V1 Simple] Primary confirmation failed for ${txid}: ${e.message}`);

        if (e.message.includes("block height exceeded")) {
            console.log(`[Confirm V2 Simple] Starting fallback confirmation check for ${txid}...`);
            await new Promise(resolve => setTimeout(resolve, 15000)); // Ждем 15 секунд

            const txInfo = await connection.getTransaction(txid, { maxSupportedTransactionVersion: 0 });

            if (txInfo) {
                console.log(`[Confirm V2 Simple] Fallback check successful! Transaction ${txid} is confirmed.`);
            } else {
                throw new Error(`[Confirm V2 Simple] Fallback check failed. Transaction ${txid} not found.`);
            }
        } else {
            throw e;
        }
    }
}

async function approveToken(connection, wallet, mint, amountLamports) {
  console.log(`[Approve] ${amountLamports} lamports of ${mint.toBase58()}`);
  const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
  const ix  = createApproveInstruction(ata, SWAP_PROGRAM_ID, wallet.publicKey, amountLamports);
  await executeSimpleTransaction(connection, [ix], wallet);
  console.log("[Approve] done");
}

async function revokeToken(connection, wallet, mint) {
  console.log(`[Revoke] revoking on ${mint.toBase58()}`);
  const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
  const ix  = createRevokeInstruction(ata, wallet.publicKey, []);
  await executeSimpleTransaction(connection, [ix], wallet);
  console.log("[Revoke] done");
}

async function findTokenBalance(connection, wallet, mint, botInstanceId) {
    const MAX_RETRIES = 3; // Количество попыток
    const RETRY_DELAY_MS = 2000; // Пауза между попытками в миллисекундах (2 секунды)
  
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, { mint }, "finalized");
        // Убираем или комментируем детальный лог, он нам больше не нужен для постоянной работы
        // console.log('[RAW RPC RESPONSE for findTokenBalance]:', JSON.stringify(resp, null, 2));
        const bal = resp.value.length > 0 ? parseInt(resp.value[0].account.data.parsed.info.tokenAmount.amount, 10) : 0;
        console.log(`[Balance] ${mint.toBase58()} balance = ${bal} (Attempt ${attempt}/${MAX_RETRIES})`);
        return bal; // Успех! Возвращаем баланс и выходим из цикла.
      } catch (e) {
        console.error(`[Balance] Failed to find token balance on attempt ${attempt}/${MAX_RETRIES}:`, e.message);
        if (attempt === MAX_RETRIES) {
          // Если это была последняя попытка, сообщаем о полном провале
          await notify(`🚨 **CRITICAL RPC ERROR**\nFailed to get wallet balance after ${MAX_RETRIES} attempts. Skipping signal.`, botInstanceId);
          return 0; // Сдаемся и возвращаем 0
        }
        // Ждем перед следующей попыткой
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    return 0; // На всякий случай, если цикл не сработает
  }

async function runPriceImpactCheck(connection, outputMint, outputDecimals) {
    console.log(`[Safety L1] Running Price Impact Check for ${outputMint.toBase58()}`);
    try {
        
        // Используем реальную сумму сделки для более точной проверки
        const amountForBuyCheckLamports = Math.round(AMOUNT_TO_SWAP_USD * (10 ** USDC_DECIMALS));

        console.log(`[Safety L1] Simulating buy for ${AMOUNT_TO_SWAP_USD} USDC...`);
        const buyQuote = await getQuote(USDC_MINT, outputMint, amountForBuyCheckLamports);
        const amountOfTokensToGet = parseInt(buyQuote.outAmount);
        if (amountOfTokensToGet === 0) throw new Error("Token not tradable for the given amount, outAmount is zero.");
        
        // Теперь симулируем немедленную продажу полученных токенов
        console.log(`[Safety L1] Simulating immediate sell of ${amountOfTokensToGet} lamports...`);
        const sellQuote = await getQuote(outputMint, USDC_MINT, amountOfTokensToGet);
        const impactPct = parseFloat(sellQuote.priceImpactPct) * 100;

        console.log(`[Safety L1] Full-cycle price impact: ${impactPct.toFixed(4)}%`);
        if (impactPct > SAFE_PRICE_IMPACT_PERCENT) {
            return { ok: false, impactPct };
        }
        console.log(`[Safety L1] OK`);
        return { ok: true, impactPct };
    } catch (e) {
        console.error("[Safety L1] Could not get quote for safety check.", e.message);
        return { ok: false, impactPct: Infinity };
    }
}

async function checkRugPullRisk(outputMint) {
    console.log(`[Safety L2] Running Rug Pull Check for ${outputMint.toBase58()}`);
    try {
        const url = `https://api.rugcheck.xyz/v1/tokens/${outputMint.toBase58()}/report`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`rugcheck.xyz API unavailable (status: ${response.status})`);
        
        const data = await response.json();
        const liquidityRisk = data.risks.find(risk => risk.name === "liquidity");
        
        if (liquidityRisk && liquidityRisk.level === "danger") {
            await notify(`⚠️ **Safety L2 Failed**\nToken: \`${outputMint.toBase58()}\`\nReason: \`${liquidityRisk.description}\``);
            return false;
        }
        console.log(`[Safety L2] OK`);
        return true;
    } catch (error) {
        // --- ИЗМЕНЕНИЯ ЗДЕСЬ ---
        console.error(`[Safety L2] CRITICAL: Could not perform rug pull check. SKIPPING TOKEN. Error: ${error.message}`);
        await notify(`🚨 **Safety L2 CRITICAL**\nCould not perform rug pull check for \`${outputMint.toBase58()}\`. **Skipping token as a precaution.**`);
        return false; // <-- "fail-closed"
    }
}


async function notify(text, botInstanceId = 'global') {
    try {
      const message = `[${botInstanceId}] ${text}`; // Формируем сообщение с ID
      console.log("[Notify] " + message.replace(/\n/g, " | "));
      await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error("Telegram notification failed:", e.message);
    }
  }

  async function monitorOpenPosition(connection, wallet, trade, botInstanceId) {
    // Получаем параметры из trade
    const mint = new PublicKey(trade.mint);
    const mintAddress = trade.mint;
    const tradeId = trade.id;
    const initialSpent = trade.spent_usdc;
    const boughtAmount = trade.bought_amount;
    let outputDecimals = 9; // по умолчанию

    try {
        const tokenInfo = await connection.getParsedAccountInfo(mint);
        if (tokenInfo.value) {
            outputDecimals = tokenInfo.value.data.parsed.info.decimals;
        }
    } catch (e) {
        await notify(`🚨 **monitorOpenPosition: Не удалось получить decimals** для ${mintAddress}`, botInstanceId);
    }

    // Основные переменные мониторинга
    const purchasePrice = initialSpent / boughtAmount;
    let highestPrice = purchasePrice;
    let stopLossTriggerCount = 0;
    let lastLiquidityCheckTimestamp = Date.now();

    // Дата покупки из trade.created_at (UTC!), переводим в миллисекунды
    const purchaseTimestamp = new Date(trade.created_at).getTime();

    // ── NEW: учитываем DUST ──
const info = await connection.getParsedAccountInfo(mint);
const decimals = info.value.data.parsed.info.decimals;
const dustLamports = Math.ceil(MIN_DUST_AMOUNT * 10 ** decimals);

const initialBal = await findTokenBalance(connection, wallet, mint, botInstanceId);
// если на кошельке 0 или только пыль — считаем позицию закрытой
if (initialBal === 0 || initialBal <= dustLamports) {
  await notify(
    `🔵 **Position Closed (or DUST)** for \`${mintAddress}\`. Balance = ${initialBal} ≤ dust (${dustLamports}).`,
    botInstanceId
  );
  await safeQuery(
    `UPDATE trades
       SET sell_tx = 'MANUAL_OR_EXTERNAL_SELL', closed_at = NOW()
     WHERE id = $1;`,
    [tradeId]
  );
  return;  // выходим до запуска трейлинга
}


    while (true) {
        await new Promise(r => setTimeout(r, PRICE_CHECK_INTERVAL_MS));
        
        const onchainBalance = await findTokenBalance(connection, wallet, mint, botInstanceId);
    if (onchainBalance === 0) {
        await notify(
            `🔵 **Position Closed Manually** for \`${mintAddress}\`. Token balance is zero.`,
            botInstanceId
        );
        await safeQuery(
            `UPDATE trades
                SET sell_tx = 'MANUAL_OR_EXTERNAL_SELL',
                    closed_at = NOW()
              WHERE id = $1;`,
            [tradeId]
        );
        break;
    }
        try {
            const monitorAmountLamports = Math.max(
                Math.round(MIN_QUOTE_USDC_FOR_MONITOR * Math.pow(10, outputDecimals) / purchasePrice),
                1
            );
            const priceQuote = await getQuote(mint, USDC_MINT, monitorAmountLamports);
            if (!priceQuote.outAmount || Number(priceQuote.outAmount) === 0) {
                console.warn("[Trailing] Quote unavailable for monitoring, skipping cycle");
                continue;
            }
            const currentPrice = Number(priceQuote.outAmount) / (monitorAmountLamports / Math.pow(10, outputDecimals));
            highestPrice = Math.max(highestPrice, currentPrice);

            const elapsedHours = (Date.now() - purchaseTimestamp) / (3600 * 1000);
            const currentPL = (currentPrice - purchasePrice) / purchasePrice;
            const stopPrice = highestPrice * (1 - TRAILING_STOP_PERCENTAGE / 100);

            console.log(`[Trailing] price=${currentPrice.toFixed(6)}, P/L=${(currentPL * 100).toFixed(2)}%, stop=${stopPrice.toFixed(6)}, time=${elapsedHours.toFixed(1)}h`);

            let sellReason = null;

            // Часовая проверка ликвидности/цены
            const elapsedHoursSinceLastCheck = (Date.now() - lastLiquidityCheckTimestamp) / (3600 * 1000);
            if (elapsedHoursSinceLastCheck >= 1) {
                console.log(`[Trailing] Hourly safety check...`);
                const { ok } = await runPriceImpactCheck(connection, mint, outputDecimals);
                if (!ok) {
                    console.warn(`[Trailing] HOURLY SAFETY CHECK FAILED! Initiating emergency sale.`);
                    sellReason = "Hourly Safety Check Failed";
                }
                lastLiquidityCheckTimestamp = Date.now();
            }

            // Trailing stop-loss после grace периода
            const GRACE_PERIOD_SECONDS = 90;
            const secondsSincePurchase = (Date.now() - purchaseTimestamp) / 1000;
            if (!sellReason && secondsSincePurchase > GRACE_PERIOD_SECONDS) { 
                if (currentPrice <= stopPrice) {
                    stopLossTriggerCount++;
                    console.log(`[TSL] Stop-loss breached. Confirmation count: ${stopLossTriggerCount}/${TSL_CONFIRMATIONS}`);
                } else {
                    if (stopLossTriggerCount > 0) {
                        console.log('[TSL] Price recovered above stop-loss. Resetting TSL confirmation counter.');
                    }
                    stopLossTriggerCount = 0;
                }
                if (stopLossTriggerCount >= TSL_CONFIRMATIONS) {
                    sellReason = `Trailing Stop-Loss (${TSL_CONFIRMATIONS} confirmations)`;
                }
            }

            // Принудительная продажа по истечении MAX_HOLDING_TIME_HOURS с убытком
            if (!sellReason && elapsedHours >= MAX_HOLDING_TIME_HOURS) {
                if (currentPL <= TIMEOUT_SELL_PL_THRESHOLD) {
                    sellReason = `Max Holding Time (${MAX_HOLDING_TIME_HOURS}h) with Loss`;
                } else {
                    console.log(`[Trailing] Max holding time reached, but position is profitable. TSL remains active.`);
                }
            }

            if (sellReason) {
                console.log(`[Sale] Triggered by: ${sellReason}. Starting cascading sell...`);
                await notify(`🔔 **Sale Triggered** for \`${mintAddress}\`\nReason: ${sellReason}`, botInstanceId);

                let balance = await findTokenBalance(connection, wallet, mint, botInstanceId);
                let soldAmount = 0;
                let wasAnySaleSuccessful = false;
                let totalUSDC = 0;
                let lastSellTx = null;
                let errorLog = [];
                let saleAttempts = 0;
                const PERCENTS = [100, 50, 25];

                while (balance > 0) {
                    let thisAttemptSuccess = false;
                    for (const pct of PERCENTS) {
                        if (balance === 0) break;
                        const amountSell = Math.floor(balance * pct / 100);
                        if (amountSell === 0) continue;
                        for (let sellTry = 1; sellTry <= 3; sellTry++) {
                            try {
                                await approveToken(connection, wallet, mint, amountSell);
                                const sellQuote = await getQuote(mint, USDC_MINT, amountSell);
                                const { swapTransaction: sellTx, lastValidBlockHeight: sellLVBH } = await getSwapTransaction(sellQuote, wallet.publicKey.toBase58());
                                const sellTxid = await executeTransaction(connection, sellTx, wallet, sellLVBH);
                                lastSellTx = sellTxid;

                                const usdcReceived = Number(sellQuote.outAmount) / 10 ** USDC_DECIMALS;
                                totalUSDC += usdcReceived;
                                const tokensSoldInChunk = Number(sellQuote.inAmount) / (10 ** outputDecimals);
                                soldAmount += tokensSoldInChunk;
                                const sellPrice = usdcReceived / tokensSoldInChunk;

                                wasAnySaleSuccessful = true;
                                thisAttemptSuccess = true;

                                await notify(
                                    `🔻 **Sold ${pct}%** of \`${mintAddress}\`\n` +
                                    `Price: \`${sellPrice.toFixed(6)}\` USDC\n` + 
                                    `Received: \`${usdcReceived.toFixed(4)}\` USDC\n` +
                                    `[Tx](https://solscan.io/tx/${sellTxid})`,
                                    botInstanceId
                                );
                                await new Promise(r => setTimeout(r, 5000));
                                balance = await findTokenBalance(connection, wallet, mint, botInstanceId);
                                break;
                            } catch (e) {
                                errorLog.push(`[${new Date().toISOString()}] Sell attempt ${sellTry}/3 for ${pct}% failed: ${e.message}`);
                                await notify(`🚨 **Sale Error (${pct}%, try ${sellTry}/3)** for \`${mintAddress}\`:\n\`${e.message}\``, botInstanceId);
                                if (sellTry < 3) await new Promise(r => setTimeout(r, 3000));
                            }
                        }
                    }

                    if (!thisAttemptSuccess) {
                        saleAttempts++;
                        if (saleAttempts >= 3) {
                            await notify(`🚨 **Критическая ошибка продажи**\n\nТокен \`${mintAddress}\` не удалось продать автоматически после 3 каскадных попыток. Пожалуйста, выполните ручную продажу через кошелек. Бот будет продолжать попытки автоматической продажи каждые 15 секунд и проверять, не был ли продан токен вручную.`, botInstanceId);
                        } else {
                            await notify(`⚠️ **Неудачная попытка ${saleAttempts}/3**. Повторим через 15 секунд...`, botInstanceId);
                        }
                        await new Promise(r => setTimeout(r, 15000));
                        balance = await findTokenBalance(connection, wallet, mint, botInstanceId);
                        if (balance === 0) {
                            await notify(`✅ **Manual sale detected!**\nBot resumes trading.`, botInstanceId);
                            break;
                        }
                    } else {
                        saleAttempts = 0;
                        balance = await findTokenBalance(connection, wallet, mint, botInstanceId);
                    }
                }

                if (await findTokenBalance(connection, wallet, mint, botInstanceId) > 0) {
                    console.log("[Sale] Final revoke for remaining balance");
                    await revokeToken(connection, wallet, mint);
                }

                const pnl = totalUSDC - initialSpent;
                console.log(`[PNL] spent=${initialSpent.toFixed(2)}, received=${totalUSDC.toFixed(2)}, pnl=${pnl.toFixed(2)}`);
                await notify(
                    `💰 **Trade Complete** for \`${mintAddress}\`\n` +
                    `Bought for: \`${initialSpent.toFixed(2)}\` USDC\n` +
                    `Sold for: \`${totalUSDC.toFixed(2)}\` USDC\n` +
                    `**PnL: \`${pnl.toFixed(2)}\` USDC**\n` +
                    `[Final Tx](https://solscan.io/tx/${lastSellTx})`, 
                    botInstanceId
                );

                await safeQuery(
                    `UPDATE trades SET sold_amount=$1, received_usdc=$2, pnl=$3, sell_tx=$4, closed_at=NOW() WHERE id=$5;`,
                    [soldAmount, totalUSDC, pnl, lastSellTx, tradeId]
                );
                console.log(`[DB] Updated trade id=${tradeId} with sale info`);
                break;
            }
        } catch (e) {
            console.error(`[Trailing] Error in trailing loop for ${mintAddress}:`, e.message);

            if (e.message.includes("SELL_EXECUTION_FAILED")) {
                await notify(`🚨 **CRITICAL: SELL FAILED & BOT HALTED** 🚨\n\n` +
                            `Token: \`${mintAddress}\`\n` +
                            `Reason: The bot could not execute the sell order after a sell trigger.\n\n` +
                            `**ACTION REQUIRED: Please sell this token manually.**\n\n`+
                            `The bot will halt all new purchases until it detects that this token's balance is zero.`, botInstanceId);
                isHalted = true;
                haltedMintAddress = mintAddress;
                haltedTradeId = tradeId;
                break;
            }

            await notify(`🟡 **TSL Paused** for \`${mintAddress}\`\nAn error occurred: \`${e.message}\`\nVerifying position status...`, botInstanceId);
            console.log("[Recovery] Verifying token balance to decide next action...");
            const balance = await findTokenBalance(connection, wallet, mint, botInstanceId);

            if (balance > 0) {
                console.log(`[Recovery] Token ${mintAddress} is still in the wallet. Resuming TSL after a delay.`);
                await notify(`✅ **TSL Resuming** for \`${mintAddress}\`. The token is still held. Monitoring continues.`, botInstanceId);
                await new Promise(r => setTimeout(r, 60000));
                continue;
            } else {
                console.log(`[Recovery] Token ${mintAddress} balance is zero. Assuming manual sell. Closing trade.`);
                await notify(`🔵 **Position Closed Manually** for \`${mintAddress}\`. The token is no longer in the wallet. Stopping monitoring.`, botInstanceId);

                await safeQuery(
                    `UPDATE trades SET sell_tx = 'MANUAL_OR_EXTERNAL_SELL', closed_at = NOW() WHERE id = $1;`,
                    [tradeId]
                );
                console.log(`[DB] Marked trade id=${tradeId} as manually closed.`);
                break;
            }
        }
    }
}


  async function processSignal(connection, wallet, signal, botInstanceId) {
    const { id: signalId, mint: outputMint } = signal;
    const mintAddress = outputMint.toBase58();
    console.log(`\n=== Processing ${mintAddress} ===`);
  
    const activePositionRes = await safeQuery(`SELECT id FROM trades WHERE mint = $1 AND closed_at IS NULL LIMIT 1`, [mintAddress]);
    if (activePositionRes.rows.length > 0) {
      console.log(`[Validation] Position for ${mintAddress} is already active (trade id ${activePositionRes.rows[0].id}). Skipping signal.`);
      await safeQuery(`UPDATE signals SET processed = true, error_reason = $2 WHERE id = $1;`,
  [signalId, "ACTIVE_POSITION"]);
      return;
    }
  
    const cooldownCheckRes = await safeQuery(`SELECT closed_at FROM trades WHERE mint = $1 ORDER BY closed_at DESC LIMIT 1`, [mintAddress]);
    if (cooldownCheckRes.rows.length > 0) {
        const lastClosed = new Date(cooldownCheckRes.rows[0].closed_at);
        const hoursSinceClose = (new Date() - lastClosed) / 3600000;
        if (hoursSinceClose < COOLDOWN_HOURS) {
            console.log(`[Validation] Cooldown period for ${mintAddress} is active (last sale ${hoursSinceClose.toFixed(2)}h ago). Skipping signal.`);
            await safeQuery(`UPDATE signals SET processed = true, error_reason = $2 WHERE id = $1;`,
  [signalId, "COOLDOWN_ACTIVE"]);
            return;
        }
    }
  
    const usdcBalance = await findTokenBalance(connection, wallet, USDC_MINT, botInstanceId);
    const requiredUsdcLamports = Math.round(AMOUNT_TO_SWAP_USD * 10 ** USDC_DECIMALS);
    if (usdcBalance < requiredUsdcLamports) {
      console.log(`[Validation] Insufficient USDC balance for ${mintAddress}. Have: ${usdcBalance}, Need: ${requiredUsdcLamports}`);
      const notifyMessage = `⚠️ **Insufficient Balance**\n` + 
                            `Token: \`${mintAddress}\`\n` +
                            `Not enough USDC to perform swap.\n` +
                            `Required: \`${AMOUNT_TO_SWAP_USD}\` USDC.`;
      await notify(notifyMessage, botInstanceId);
      await safeQuery(
        `UPDATE signals SET processed = true, error_reason = $2 WHERE id = $1;`,
        [signalId, "NO_BALANCE"]
      );
      return;
    }
    
    let outputDecimals;
    try {
      const tokenInfo = await connection.getParsedAccountInfo(outputMint);
      if (!tokenInfo || !tokenInfo.value) throw new Error("Could not fetch token info from chain");
      outputDecimals = tokenInfo.value.data.parsed.info.decimals;
      console.log(`[Info] Token decimals for ${mintAddress} is ${outputDecimals}`);
    } catch(e) {
      await notify(`🚨 **Error**\nCould not fetch token info for \`${mintAddress}\`. Skipping.`, botInstanceId);
await safeQuery(
  `UPDATE signals SET processed = true, error_reason = $2 WHERE id = $1;`,
  [signalId, "TOKEN_INFO_FETCH_FAIL"]);
      return;
    }
  
    const { ok, impactPct } = await runPriceImpactCheck(connection, outputMint, outputDecimals);
    if (!ok) {
        await notify(`⚠️ **Safety Check L1 Failed**\nToken: \`${mintAddress}\`\nImpact: \`${impactPct.toFixed(2)}%\` > \`${SAFE_PRICE_IMPACT_PERCENT}%\``, botInstanceId);
        await safeQuery(
          `UPDATE signals SET processed = true, error_reason = $2 WHERE id = $1;`,
          [signalId, "HIGH_PRICE_IMPACT"]
        );
        return;
    }
  
    const isNotRugPull = await checkRugPullRisk(outputMint);
    if (!isNotRugPull) {
      await safeQuery(`UPDATE signals SET processed = true, error_reason = $2 WHERE id = $1;`,
  [signalId, "RUGCHECK_FAIL"]);
      return;
    }
    
    
    await notify(
      `✅ **All safety checks passed for** \`${mintAddress}\`\n` +
      `Impact: \`${impactPct.toFixed(2)}%\` < \`${SAFE_PRICE_IMPACT_PERCENT}%\`\n` +
      `Starting purchase.`,
      botInstanceId
    );
    
    let buyPricePerToken;
    let tradeId, initialSpent;
    try {
      console.log("[Purchase] Starting purchase phase");
      const usdcLamports = Math.round(AMOUNT_TO_SWAP_USD * 10 ** USDC_DECIMALS);
      await approveToken(connection, wallet, USDC_MINT, usdcLamports);
      const buyQuote = await getQuote(USDC_MINT, outputMint, usdcLamports);
      const { swapTransaction, lastValidBlockHeight } = await getSwapTransaction(
        buyQuote,
        wallet.publicKey.toBase58()
      );
      const buyTxid = await executeTransaction(connection, swapTransaction, wallet, lastValidBlockHeight);
      await revokeToken(connection, wallet, USDC_MINT);
  
      const boughtTokens = Number(buyQuote.outAmount) / 10 ** outputDecimals;
      buyPricePerToken = AMOUNT_TO_SWAP_USD / boughtTokens;
      console.log(`[Purchase] Bought ${boughtTokens.toFixed(6)} @ ${buyPricePerToken.toFixed(6)} USDC/token, tx=${buyTxid}`);
      await notify(
        `✅ **Purchased**\nToken: \`${mintAddress}\`\n` +
        `Amount: \`${boughtTokens.toFixed(4)}\`\n` +
        `Price: \`${buyPricePerToken.toFixed(6)}\` USDC\n` +
        `Spent: \`${AMOUNT_TO_SWAP_USD.toFixed(2)}\` USDC\n` +
        `[Tx](https://solscan.io/tx/${buyTxid})`,
        botInstanceId
      );
  
      const res = await safeQuery(
        `INSERT INTO trades(mint,bought_amount,spent_usdc,buy_tx,created_at)
         VALUES($1,$2,$3,$4,NOW()) RETURNING id, spent_usdc;`,
        [mintAddress, boughtTokens, AMOUNT_TO_SWAP_USD, buyTxid]
      );
      ({ id: tradeId, spent_usdc: initialSpent } = res.rows[0]);
      console.log(`[DB] Inserted trade id=${tradeId}`);
    } catch (e) {
        console.error("[Purchase] Purchase phase failed:", e);
        await notify(`🚨 **Purchase Failed** for \`${mintAddress}\`:\n\`${e.message}\``, botInstanceId);
        return; 
    }
  
    // === НАЧАЛО ЦИКЛА МОНИТОРИНГА (ФИНАЛЬНАЯ ВЕРСИЯ) ===
    console.log("[Trailing] Starting position monitoring");
    let highestPrice = buyPricePerToken;
    let stopLossTriggerCount = 0;
    const purchasePrice = buyPricePerToken;
    const purchaseTimestamp = Date.now();
    let lastLiquidityCheckTimestamp = Date.now();
  
    while (true) {
        await new Promise(r => setTimeout(r, PRICE_CHECK_INTERVAL_MS));
        try {
            
        const monitorAmountLamports = Math.max(
            Math.round(MIN_QUOTE_USDC_FOR_MONITOR * Math.pow(10, outputDecimals) / buyPricePerToken),
            1
        );
        const priceQuote = await getQuote(outputMint, USDC_MINT, monitorAmountLamports);
        if (!priceQuote.outAmount || Number(priceQuote.outAmount) === 0) {
            console.warn("[Trailing] Quote unavailable for monitoring, skipping cycle");
            continue; // Не сбрасываем high/low!
        }
        const currentPrice = Number(priceQuote.outAmount) / (monitorAmountLamports / Math.pow(10, outputDecimals));
            highestPrice = Math.max(highestPrice, currentPrice);
  
            const elapsedHours = (Date.now() - purchaseTimestamp) / (3600 * 1000);
            const currentPL = (currentPrice - purchasePrice) / purchasePrice;
            const stopPrice = highestPrice * (1 - TRAILING_STOP_PERCENTAGE / 100);
  
            console.log(`[Trailing] price=${currentPrice.toFixed(6)}, P/L=${(currentPL * 100).toFixed(2)}%, stop=${stopPrice.toFixed(6)}, time=${elapsedHours.toFixed(1)}h`);
  
            let sellReason = null;
  
            const elapsedHoursSinceLastCheck = (Date.now() - lastLiquidityCheckTimestamp) / (3600 * 1000);
            if (elapsedHoursSinceLastCheck >= 1) {
                console.log(`[Trailing] Hourly safety check...`);
                const { ok } = await runPriceImpactCheck(connection, outputMint, outputDecimals);
                if (!ok) {
                    console.warn(`[Trailing] HOURLY SAFETY CHECK FAILED! Initiating emergency sale.`);
                    sellReason = "Hourly Safety Check Failed";
                }
                lastLiquidityCheckTimestamp = Date.now();
            }
  
            // --- НАЧАЛО НОВОЙ ЛОГИКИ ЗАЩИТЫ ОТ "СКВИЗОВ" ---
            const GRACE_PERIOD_SECONDS = 90; // Льготный период в 90 секунд.
            const secondsSincePurchase = (Date.now() - purchaseTimestamp) / 1000;

          // Проверяем TSL, только если еще нет причины для продажи И прошел льготный период
          if (!sellReason && secondsSincePurchase > GRACE_PERIOD_SECONDS) { 
            if (currentPrice <= stopPrice) {
                stopLossTriggerCount++;
                console.log(`[TSL] Stop-loss breached. Confirmation count: ${stopLossTriggerCount}/${TSL_CONFIRMATIONS}`);
            } else {
                if (stopLossTriggerCount > 0) {
                    console.log('[TSL] Price recovered above stop-loss. Resetting TSL confirmation counter.');
                }
                stopLossTriggerCount = 0;
            }

            if (stopLossTriggerCount >= TSL_CONFIRMATIONS) {
                sellReason = `Trailing Stop-Loss (${TSL_CONFIRMATIONS} confirmations)`;
            }
          }
            // --- КОНЕЦ НОВОЙ ЛОГИКИ ЗАЩИТЫ ОТ "СКВИЗОВ" ---
  
            if (!sellReason && elapsedHours >= MAX_HOLDING_TIME_HOURS) {
                if (currentPL <= TIMEOUT_SELL_PL_THRESHOLD) {
                    sellReason = `Max Holding Time (${MAX_HOLDING_TIME_HOURS}h) with Loss`;
                } else {
                    console.log(`[Trailing] Max holding time reached, but position is profitable. TSL remains active.`);
                }
            }
  
            if (sellReason) {
                // Вся логика продажи (if (sellReason) { ... }) остается без изменений
                // Просто скопируйте ее из вашего файла или из моего предыдущего ответа
                // ...
                // Это тот самый большой блок с каскадной продажей, который мы уже исправляли
                // ...
                // В конце этого блока должен быть 'break;'
                console.log(`[Sale] Triggered by: ${sellReason}. Starting cascading sell...`);
                await notify(`🔔 **Sale Triggered** for \`${mintAddress}\`\nReason: ${sellReason}`, botInstanceId);
                
                


let balance = await findTokenBalance(connection, wallet, outputMint, botInstanceId);
let soldAmount = 0;
let wasAnySaleSuccessful = false; 
let totalUSDC = 0;
let lastSellTx = null;
let errorLog = [];
let saleAttempts = 0;

const PERCENTS = [100, 50, 25];

// Новый цикл: продолжает попытки, чередуя автомат и проверку ручной продажи
while (balance > 0) {
    let thisAttemptSuccess = false;
    for (const pct of PERCENTS) {
        if (balance === 0) break;
        const amountSell = Math.floor(balance * pct / 100);
        if (amountSell === 0) continue;

        for (let sellTry = 1; sellTry <= 3; sellTry++) {
            try {
                await approveToken(connection, wallet, outputMint, amountSell);
                const sellQuote = await getQuote(outputMint, USDC_MINT, amountSell);
                const { swapTransaction: sellTx, lastValidBlockHeight: sellLVBH } = await getSwapTransaction(sellQuote, wallet.publicKey.toBase58());
                const sellTxid = await executeTransaction(connection, sellTx, wallet, sellLVBH);
                lastSellTx = sellTxid;

                const usdcReceived = Number(sellQuote.outAmount) / 10 ** USDC_DECIMALS;
                totalUSDC += usdcReceived;
                const tokensSoldInChunk = Number(sellQuote.inAmount) / (10 ** outputDecimals);
                soldAmount += tokensSoldInChunk;
                const sellPrice = usdcReceived / tokensSoldInChunk;

                wasAnySaleSuccessful = true;
                thisAttemptSuccess = true;

                await notify(
                    `🔻 **Sold ${pct}%** of \`${mintAddress}\`\n` +
                    `Price: \`${sellPrice.toFixed(6)}\` USDC\n` + 
                    `Received: \`${usdcReceived.toFixed(4)}\` USDC\n` +
                    `[Tx](https://solscan.io/tx/${sellTxid})`,
                    botInstanceId
                );
                await new Promise(r => setTimeout(r, 5000));
                balance = await findTokenBalance(connection, wallet, outputMint, botInstanceId);
                break;
            } catch (e) {
                errorLog.push(`[${new Date().toISOString()}] Sell attempt ${sellTry}/3 for ${pct}% failed: ${e.message}`);
                await notify(`🚨 **Sale Error (${pct}%, try ${sellTry}/3)** for \`${mintAddress}\`:\n\`${e.message}\``, botInstanceId);
                if (sellTry < 3) await new Promise(r => setTimeout(r, 3000));
            }
        }
    }

    if (!thisAttemptSuccess) {
        saleAttempts++;
        if (saleAttempts >= 3) {
            await notify(`🚨 **Критическая ошибка продажи**\n\nТокен \`${mintAddress}\` не удалось продать автоматически после 3 каскадных попыток. Пожалуйста, выполните ручную продажу через кошелек. Бот будет продолжать попытки автоматической продажи каждые 15 секунд и проверять, не был ли продан токен вручную.`, botInstanceId);
        } else {
            await notify(`⚠️ **Неудачная попытка ${saleAttempts}/3**. Повторим через 15 секунд...`, botInstanceId);
        }
        // Ждем 15 сек, затем снова полный каскад (или выход если вручную продали)
        await new Promise(r => setTimeout(r, 15000));
        balance = await findTokenBalance(connection, wallet, outputMint, botInstanceId);
        if (balance === 0) {
            await notify(`✅ **Manual sale detected!**\nBot resumes trading.`, botInstanceId);
            break;
        }
    } else {
        saleAttempts = 0;
        balance = await findTokenBalance(connection, wallet, outputMint, botInstanceId);
    }
}


  
                if (await findTokenBalance(connection, wallet, outputMint, botInstanceId) > 0) {
                    console.log("[Sale] Final revoke for remaining balance");
                    await revokeToken(connection, wallet, outputMint);
                }
  
                const pnl = totalUSDC - initialSpent;
                console.log(`[PNL] spent=${initialSpent.toFixed(2)}, received=${totalUSDC.toFixed(2)}, pnl=${pnl.toFixed(2)}`);
                await notify(
                    `💰 **Trade Complete** for \`${mintAddress}\`\n` +
                    `Bought for: \`${initialSpent.toFixed(2)}\` USDC\n` +
                    `Sold for: \`${totalUSDC.toFixed(2)}\` USDC\n` +
                    `**PnL: \`${pnl.toFixed(2)}\` USDC**\n` +
                    `[Final Tx](https://solscan.io/tx/${lastSellTx})`, 
                    botInstanceId
                );
  
                await safeQuery(
                    `UPDATE trades SET sold_amount=$1, received_usdc=$2, pnl=$3, sell_tx=$4, closed_at=NOW() WHERE id=$5;`,
                    [soldAmount, totalUSDC, pnl, lastSellTx, tradeId]
                );
                console.log(`[DB] Updated trade id=${tradeId} with sale info`);
                break; 
            }
        } catch (e) {
            console.error(`[Trailing] Error in trailing loop for ${mintAddress}:`, e.message);
  
            if (e.message.includes("SELL_EXECUTION_FAILED")) {
                await notify(`🚨 **CRITICAL: SELL FAILED & BOT HALTED** 🚨\n\n` +
                             `Token: \`${mintAddress}\`\n` +
                             `Reason: The bot could not execute the sell order after a sell trigger.\n\n` +
                             `**ACTION REQUIRED: Please sell this token manually.**\n\n`+
                             `The bot will halt all new purchases until it detects that this token's balance is zero.`, botInstanceId);
                
                isHalted = true;
                haltedMintAddress = mintAddress;
                haltedTradeId = tradeId;
  
                break;
            }
  
            await notify(`🟡 **TSL Paused** for \`${mintAddress}\`\nAn error occurred: \`${e.message}\`\nVerifying position status...`, botInstanceId);
            
            console.log("[Recovery] Verifying token balance to decide next action...");
            const balance = await findTokenBalance(connection, wallet, outputMint, botInstanceId);
  
            if (balance > 0) {
                console.log(`[Recovery] Token ${mintAddress} is still in the wallet. Resuming TSL after a delay.`);
                await notify(`✅ **TSL Resuming** for \`${mintAddress}\`. The token is still held. Monitoring continues.`, botInstanceId);
                await new Promise(r => setTimeout(r, 60000));
                continue; 
            } else {
                console.log(`[Recovery] Token ${mintAddress} balance is zero. Assuming manual sell. Closing trade.`);
                await notify(`🔵 **Position Closed Manually** for \`${mintAddress}\`. The token is no longer in the wallet. Stopping monitoring.`, botInstanceId);
                
                await safeQuery(
                    `UPDATE trades SET sell_tx = 'MANUAL_OR_EXTERNAL_SELL', closed_at = NOW() WHERE id = $1;`,
                    [tradeId]
                );
                console.log(`[DB] Marked trade id=${tradeId} as manually closed.`);
                break;
            }
        }
    }
  }

async function setupDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS trades (
                id SERIAL PRIMARY KEY,
                mint TEXT NOT NULL,
                bought_amount DOUBLE PRECISION NOT NULL,
                spent_usdc DOUBLE PRECISION NOT NULL,
                buy_tx TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                sold_amount DOUBLE PRECISION,
                received_usdc DOUBLE PRECISION,
                pnl DOUBLE PRECISION,
                sell_tx TEXT,
                closed_at TIMESTAMPTZ,
                UNIQUE(mint, closed_at)
            );
        `);
        const res = await client.query("SELECT to_regclass('public.signals');");
        if (res.rows[0].to_regclass === null) {
            await client.query(`
                CREATE TABLE signals (
                    id SERIAL PRIMARY KEY,
                    token_mint TEXT NOT NULL,
                    processed BOOLEAN DEFAULT false,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
            `);
        }
        console.log("Database and tables are ready.");
    } catch (e) {
        console.error("Database setup failed:", e);
        throw e;
    }
    finally {
        client.release();
    }
}

async function addErrorReasonColumnIfNotExists() {
    try {
        await safeQuery(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name='signals'
                    AND column_name='error_reason'
                ) THEN
                    ALTER TABLE signals ADD COLUMN error_reason TEXT;
                END IF;
            END
            $$;
        `);
        console.log("[DB] Checked/added column error_reason in signals");
    } catch (e) {
        if (!e.message.includes('duplicate column')) {
            console.error("[DB] Could not ensure error_reason column exists:", e.message);
        }
    }
}

function startHealthCheckServer(botInstanceId) {
    // Используем встроенный модуль http, чтобы не добавлять лишних зависимостей
    const http = require('http');
    
    // Railway предоставляет порт в переменной окружения PORT
    const PORT = process.env.PORT || 8080; // Используем порт от Railway или 8080 по умолчанию

    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', timestamp: new Date() }));
    });

    server.listen(PORT, () => {
        console.log(`[HealthCheck] Server listening on port ${PORT}`);
        // Это уведомление только для вас, чтобы вы знали, что все работает
        notify(`✅ Health check server started on port ${PORT}.`, botInstanceId);
    });
}


(async () => {
    const botInstanceId = Math.random().toString(36).substring(2, 8); // <--- ВОТ ЭТА СТРОКА ДОБАВЛЕНА

    await addErrorReasonColumnIfNotExists();
  
    await setupDatabase();
    startHealthCheckServer();
    console.log("--- Tradebot worker started ---");
    // И сразу начинаем использовать ID в уведомлениях
    await notify("🚀 Tradebot worker started!", botInstanceId); 
  
    const wallet     = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
    const connection = new Connection(SOLANA_RPC_URL, "confirmed");

    const gracefulShutdown = async (signal) => {
        console.log(`[Shutdown] Received ${signal}. Shutting down gracefully...`);
        await notify(`🤖 Bot shutting down due to ${signal}...`, botInstanceId); // <-- Теперь ID передается!
        await pool.end();
        console.log("[Shutdown] Database pool closed.");
        isPoolActive = false;
        process.exit(0);
      };
  
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  let lastCleanup = Date.now();

  // При запуске проверяем незакрытые трейды
  // При запуске — мониторим только самую последнюю незакрытую сделку
  console.log("[Startup] ищем последнюю незакрытую сделку…");
    const lastOpen = await safeQuery(`
    SELECT *
      FROM trades
     WHERE closed_at IS NULL
  ORDER BY created_at DESC
     LIMIT 1
  `);
  console.log(
    "[Startup] найдено строк:", 
    lastOpen.rows.length, 
    lastOpen.rows[0] && lastOpen.rows[0].mint
  );
  if (lastOpen.rows.length === 1) {
      await monitorOpenPosition(connection, wallet, lastOpen.rows[0], botInstanceId);
  }
  // После — переходим к сигналам (старые сделки больше не трогаем)
  
  
  while (true) {
    try {

        console.log(`[Main] Polling signals table at ${new Date().toISOString()}`);

        // Очистка сигналов раз в 10 минут
    if (Date.now() - lastCleanup > 10 * 60 * 1000) { // 10 минут
      await cleanupOldSignals();
      lastCleanup = Date.now();
    }

        // --- АВАРИЙНЫЙ РЕЖИМ (halted) ---
        // --- АВАРИЙНЫЙ РЕЖИМ (halted) ---
// --- АВАРИЙНЫЙ РЕЖИМ (halted) с ручным подтверждением ---
if (isHalted) {
    console.log(`[Halted] Bot is halted. Checking balance for stuck token: ${haltedMintAddress}`);
    // 1) Получаем decimals и считаем dust
    const tokenInfo = await connection.getParsedAccountInfo(new PublicKey(haltedMintAddress));
    const outputDecimals = tokenInfo.value.data.parsed.info.decimals;
    const dustLamports = Math.ceil(MIN_DUST_AMOUNT * Math.pow(10, outputDecimals));
  
    // 2) Узнаём баланс «застрявшего» токена
    const balance = await findTokenBalance(
      connection,
      wallet,
      new PublicKey(haltedMintAddress),
      botInstanceId
    );
  
    // 3) Если ещё больше, чем dust — ждём минуту и проверяем снова
    if (balance > dustLamports) {
      console.log(`[Recovery] Token ${haltedMintAddress} still in wallet (${balance}). Re-check in 1m…`);
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }
  
    // 4) Если остаток >0, но ≤ dust — считаем DUST
    if (balance > 0) {
      await notify(
        `ℹ️ Остаток токена \`${haltedMintAddress}\`: ${balance} (≤ dust). Закрываю как DUST.`,
        botInstanceId
      );
      // сразу отмечаем в БД
      await safeQuery(
        `UPDATE trades SET sell_tx = 'MANUAL_OR_EXTERNAL_SELL', closed_at = NOW() WHERE id = $1;`,
        [haltedTradeId]
      );
      console.log(`[DB] Marked trade id=${haltedTradeId} as closed as DUST.`);
      isHalted = false;
      haltedMintAddress = null;
      haltedTradeId   = null;
      manualSellConfirmations = 0;
      continue;
    }
  
    // 5) balance === 0 — фиксируем ручную продажу
    console.log(`[Recovery] Detected balance=0 for ${haltedMintAddress}, manual sale!`);
    manualSellConfirmations++;
    console.log(`[Halted] manualSellConfirmations = ${manualSellConfirmations}/${MANUAL_SELL_CONFIRMATIONS}`);
  
    // 6) Если накопили нужное число подтверждений — выходим из halted
    if (manualSellConfirmations >= MANUAL_SELL_CONFIRMATIONS) {
      await notify(
        `✅ **Operation Resumed!**\nManual sale of \`${haltedMintAddress}\` detected ${manualSellConfirmations} times. Resuming normal operation.`,
        botInstanceId
      );
      await safeQuery(
        `UPDATE trades SET sell_tx = 'MANUAL_SELL_AFTER_FAIL', closed_at = NOW() WHERE id = $1;`,
        [haltedTradeId]
      );
      isHalted = false;
      haltedMintAddress = null;
      haltedTradeId   = null;
      manualSellConfirmations = 0;
      continue;
    } else {
      // иначе ждём ещё одну минуту и вновь проверяем
      console.log(`[Halted] Awaiting next manual-sale confirmation. Next check in 1m…`);
      await new Promise(r => setTimeout(r, 60000));
      continue;
    }
  }
  
  
    
        // --- ШТАТНЫЙ РЕЖИМ ---
        const signals = await fetchAllPendingSignals();
if (signals.length > 0) {
    // обрабатываем только самый первый сигнал
    await processSignal(connection, wallet, signals[0], botInstanceId);
} else {
            await new Promise(r => setTimeout(r, SIGNAL_CHECK_INTERVAL_MS));
        }
    

      }
     catch (err) {
      console.error("[Main] Error in main loop:", err.message);
      await notify(`🚨 **FATAL ERROR** in main loop: \`${err.message}\``, botInstanceId);
      await new Promise(r => setTimeout(r, SIGNAL_CHECK_INTERVAL_MS));
    }
  }
})().catch(async err => {
    console.error("Fatal error, exiting:", err);
    await notify(`💀 **FATAL SHUTDOWN**: \`${err.message}\``);
    try { await pool.end(); } catch (e) {}
    isPoolActive = false;
    process.exit(1); // <-- Гарантируем завершение процесса, чтобы не было повторных обращений к pool
});
