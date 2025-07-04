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

// Константы для обработки ошибок "нет маршрута"
const NO_ROUTE_ERROR_LIMIT = 5;
const NO_ROUTE_FREEZE_MINUTES = 10;
const NO_ROUTE_MAX_HOURS = 0.5; // 30 минут


// — Инициализация —
const bot = new Telegraf(TELEGRAM_TOKEN);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

console.log(`[DB] Connecting to: ${DATABASE_URL}`);
;(async () => {
  try {
    const { rows } = await pool.query(`
      SELECT current_database() AS db, current_schema() AS schema_name;
    `);
    console.log(`[DB] Connected to database: ${rows[0].db}, schema: ${rows[0].schema_name}`);
  } catch (e) {
    console.error('[DB] Could not fetch current_database():', e.message);
  }
})();


let isPoolActive = true;

async function safeQuery(...args) {
    if (!isPoolActive) throw new Error("Attempted query after pool closed");
    return pool.query(...args);
}

// — Утилита: достать следующий сигнал из таблицы — 
async function fetchAllPendingSignals() {
    const ONE_MINUTE_AGO = Math.floor((Date.now() - 60 * 1000) / 1000);
    const res = await safeQuery(
      `SELECT mint
         FROM signals
        WHERE signal_ts > $1
        ORDER BY signal_ts;`,
      [ONE_MINUTE_AGO]
    );
    return res.rows.map(row => ({ mint: new PublicKey(row.mint) }));
}

  

// — Основные вспомогательные функции —

async function cleanupOldSignals() {
    // Удаляем сигналы старше 1 часа (processed=true или false — неважно)
    const ONE_HOUR_AGO = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
    const res = await safeQuery(
      `DELETE FROM signals WHERE signal_ts < $1 RETURNING mint;`,
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
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    // ── Сначала один раз подтягиваем decimals этого токена ──
    let decimals = 0;
    try {
        const info = await connection.getParsedAccountInfo(mint);
        decimals = info.value?.data?.parsed?.info?.decimals ?? 0;
    } catch (e) {
        console.warn(`[Balance] Could not fetch decimals for ${mint.toBase58()}: ${e.message}`);
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const resp = await connection.getParsedTokenAccountsByOwner(
                wallet.publicKey,
                { mint },
                "finalized"
            );
            const lamports = resp.value.length > 0
                ? parseInt(resp.value[0].account.data.parsed.info.tokenAmount.amount, 10)
                : 0;
            const human = lamports / Math.pow(10, decimals);
            console.log(
                `[Balance] ${mint.toBase58()} = ${human.toFixed(6)} tokens — Attempt ${attempt}/${MAX_RETRIES}`
            );
            return lamports;
        } catch (e) {
            console.error(
                `[Balance] Failed to find token balance on attempt ${attempt}/${MAX_RETRIES}:`,
                e.message
            );
            if (attempt === MAX_RETRIES) {
                await notify(
                    `🚨 **CRITICAL RPC ERROR**\n` +
                    `Failed to get wallet balance after ${MAX_RETRIES} attempts. Skipping signal.`,
                    botInstanceId
                );
                return 0;
            }
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
    }

    return 0;
}

  

async function runPriceImpactCheck(connection, outputMint, outputDecimals) {
    console.log(`[Safety L1] Running Price Impact Check for ${outputMint.toBase58()}`);
    try {
        
        // Используем реальную сумму сделки для более точной проверки
        const amountForBuyCheckLamports = Math.round(AMOUNT_TO_SWAP_USD * (10 ** USDC_DECIMALS));

        console.log(`[Safety L1] Simulating buy for ${AMOUNT_TO_SWAP_USD} USDC...`);
        let buyQuote = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            buyQuote = await getQuote(USDC_MINT, outputMint, amountForBuyCheckLamports);
            break;
          } catch (e) {
            if (e.message.includes("COULD_NOT_FIND_ANY_ROUTE")) {
              console.warn(`[Safety L1] No route for buy, attempt ${attempt}/3. Retrying in 1s...`);
              if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
            } else {
              console.error(`[Safety L1] Error on buy quote attempt ${attempt}:`, e.message);
              return { ok: false, impactPct: Infinity };
            }
          }
        }
        if (!buyQuote) {
          console.error(`[Safety L1] Failed to get buy quote after 3 attempts.`);
          return { ok: false, impactPct: Infinity };
        }
        const amountOfTokensToGet = parseInt(buyQuote.outAmount);
        if (amountOfTokensToGet === 0) {
          console.error("[Safety L1] Token not tradable, outAmount is zero.");
          return { ok: false, impactPct: Infinity };
        }

        // Теперь симулируем немедленную продажу полученных токенов
        console.log(`[Safety L1] Simulating immediate sell of ${amountOfTokensToGet} lamports...`);
        let sellQuote = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            sellQuote = await getQuote(outputMint, USDC_MINT, amountOfTokensToGet);
            break;
          } catch (e) {
            if (e.message.includes("COULD_NOT_FIND_ANY_ROUTE")) {
              console.warn(`[Safety L1] No route for sell, attempt ${attempt}/3. Retrying in 1s...`);
              if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
            } else {
              console.error(`[Safety L1] Error on sell quote attempt ${attempt}:`, e.message);
              return { ok: false, impactPct: Infinity };
            }
          }
        }
        if (!sellQuote) {
          console.error(`[Safety L1] Failed to get sell quote after 3 attempts.`);
          return { ok: false, impactPct: Infinity };
        }
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

async function checkRugPullRisk(outputMint, botInstanceId) {
    console.log(`[Safety L2] Running Rug Pull Check for ${outputMint.toBase58()}`);
    try {
        const url = `https://api.rugcheck.xyz/v1/tokens/${outputMint.toBase58()}/report`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`rugcheck.xyz API unavailable (status: ${response.status})`);
        }

        const data = await response.json();
        const liquidityRisk = data.risks.find(r => r.name === "liquidity");

        if (liquidityRisk && liquidityRisk.level === "danger") {
            await notify(
                `⚠️ **Safety L2 Failed**\n` +
                `Token: \`${outputMint.toBase58()}\`\n` +
                `Reason: \`${liquidityRisk.description}\``,
                botInstanceId
            );
            return false;
        }

        console.log(`[Safety L2] OK`);
        await notify(
            `✅ **Safety L2 Passed**\n` +
            `Token: \`${outputMint.toBase58()}\``,
            botInstanceId
        );
        return true;

    } catch (error) {
        console.error(
            `[Safety L2] CRITICAL: Could not perform rug pull check. SKIPPING TOKEN. Error: ${error.message}`
        );
        await notify(
            `🚨 **Safety L2 CRITICAL**\n` +
            `Could not perform rug pull check for \`${outputMint.toBase58()}\`. **Skipping token as a precaution.**`,
            botInstanceId
        );
        return false;
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

  async function mint(connection, wallet, trade, botInstanceId) {
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
        await notify(`🚨 **mint: Не удалось получить decimals** для ${mintAddress}`, botInstanceId);
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
  
  // ============ ON-CHAIN CHECK ===========
const onchainLamports = await findTokenBalance(
    connection,
    wallet,
    mint,            // там же, где вы в контексте работаете с этим mint
    botInstanceId
  );
  if (onchainLamports > dustLamports) {
    const onchainAmount = onchainLamports / (10 ** outputDecimals);
    console.log(
      `[Recovery] Token still on‐chain: ${onchainAmount.toFixed(6)} > dust ` +
      `(${dustLamports / 10**outputDecimals}). Skip closing.`
    );
    await notify(
      `ℹ️ Token still on‐chain (${onchainAmount.toFixed(6)}). ` +
      `Продолжаем мониторинг.`,
      botInstanceId
    );
  // в зависимости от места либо продолжаем цикл, либо просто выходим из текущей ветки:
  return;  // в циклах monitorOpenPosition
    // return; // в местах, где это выход из функции
  }
  // ============ /ON-CHAIN CHECK ===========
  
  
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
            // =========== RETRY ON COULD_NOT_FIND_ANY_ROUTE ===========
let priceQuote;
try {
  priceQuote = await getQuote(mint, USDC_MINT, monitorAmountLamports);
} catch (e) {
  if (
    e.message.includes("COULD_NOT_FIND_ANY_ROUTE") ||
    e.message.includes("Could not find any route")
  ) {
    console.warn(`[Trailing] No route found, retrying in 1s…`);
    await new Promise(r => setTimeout(r, 1000));
    // вторая попытка
    priceQuote = await getQuote(mint, USDC_MINT, monitorAmountLamports);
  } else {
    throw e;
  }
}
// ===========================================================
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
            
                // ── Учитываем DUST ──
                const info = await connection.getParsedAccountInfo(mint);
                const decimals = info.value.data.parsed.info.decimals;
                const dustLamports = Math.ceil(MIN_DUST_AMOUNT * 10 ** decimals);
            
                let balance = await findTokenBalance(connection, wallet, mint, botInstanceId);
                // Если нет баланса или только пыль — закрываем сразу
                if (balance === 0 || balance <= dustLamports) {
                    await notify(
                        `🔵 **Position Closed (or DUST)** for \`${mintAddress}\`. ` +
                        `Balance = ${balance} ≤ dust (${dustLamports}).`,
                        botInstanceId
                    );
                    
                    // ============ ON-CHAIN CHECK ===========
const onchainLamports = await findTokenBalance(
    connection,
    wallet,
    mint,            // там же, где вы в контексте работаете с этим mint
    botInstanceId
  );
  if (onchainLamports > dustLamports) {
    const onchainAmount = onchainLamports / (10 ** outputDecimals);
    console.log(
      `[Recovery] Token still on‐chain: ${onchainAmount.toFixed(6)} > dust ` +
      `(${dustLamports / 10**outputDecimals}). Skip closing.`
    );
    await notify(
      `ℹ️ Token still on‐chain (${onchainAmount.toFixed(6)}). ` +
      `Продолжаем мониторинг.`,
      botInstanceId
    );
  // в зависимости от места либо продолжаем цикл, либо просто выходим из текущей ветки:
  return;  // в циклах monitorOpenPosition
    // return; // в местах, где это выход из функции
  }
  // ============ /ON-CHAIN CHECK ===========
                    await safeQuery(
                        `UPDATE trades SET sell_tx = 'MANUAL_OR_EXTERNAL_SELL', closed_at = NOW() WHERE id = $1;`,
                        [tradeId]
                    );
                    break;
                }
            
                const PERCENTS = [100, 50, 25];
                let errorLog = [];
                let saleAttempts = 0;
                let manualSaleSuggested = false;
                let totalUSDC = 0;
                let soldAmount = 0;
                let lastSellTx = null;
            
                while (balance > 0) {
                    // перед каждой итерацией проверяем manual sale / dust
                    balance = await findTokenBalance(connection, wallet, mint, botInstanceId);
                    if (balance === 0 || balance <= dustLamports) {
                        await notify(`✅ **Manual sale detected or DUST cleared**. Resuming new signals.`, botInstanceId);
                        break;
                    }
            
                    let thisAttemptSuccess = false;
                    for (const pct of PERCENTS) {
                        if (balance === 0) break;
                        const amountSell = Math.floor(balance * pct / 100);
                        if (amountSell === 0) continue;
            
                        for (let sellTry = 1; sellTry <= 3; sellTry++) {
                            try {
                                await approveToken(connection, wallet, mint, amountSell);
                                const sellQuote = await getQuote(mint, USDC_MINT, amountSell);
                                const { swapTransaction, lastValidBlockHeight } = await getSwapTransaction(
                                    sellQuote,
                                    wallet.publicKey.toBase58()
                                );
                                const sellTxid = await executeTransaction(connection, swapTransaction, wallet, lastValidBlockHeight);
                                lastSellTx = sellTxid;
            
                                const usdcReceived = Number(sellQuote.outAmount) / 10 ** USDC_DECIMALS;
                                totalUSDC += usdcReceived;
                                soldAmount += Number(sellQuote.inAmount) / (10 ** decimals);
            
                                thisAttemptSuccess = true;
            
                                await notify(
                                    `🔻 **Sold ${pct}%** of ${mintAddress}\n`
                                    + `💰 Received: $${usdcReceived.toFixed(2)} USDC\n`
                                    + `📊 Total sold: ${soldAmount.toFixed(2)} tokens\n`
                                    + `💵 Total USDC: $${totalUSDC.toFixed(2)}`, 
                                    botInstanceId
                                );
                                break; // Успешная продажа, выходим из цикла попыток
                            } catch (error) {
                                console.log(`Sell attempt ${sellTry} failed:`, error.message);
                                if (sellTry === 3) {
                                    errorLog.push(`Failed to sell ${pct}% after 3 attempts: ${error.message}`);
                                }
                            }
                        }
                        
                        if (thisAttemptSuccess) {
                            break; // Успешная продажа, выходим из цикла процентов
                        }
                    }
                    
                    // Если ни одна попытка не удалась, выходим из основного цикла
                    if (!thisAttemptSuccess) {
                        break;
                    }
                }
            } // end while (balance > 0)
        } catch (e) {
            console.error("Error in mint:", e);
            await notify(`❌ Error in mint: ${e.message}`, botInstanceId);
        } // end try/catch
    } // end while (true)
} // end async function mint