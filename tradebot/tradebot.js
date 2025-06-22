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
const bs58 = require("bs58");
const { Telegraf } = require("telegraf");
const { Pool } = require("pg");

// Генерируем уникальный ID для этого запуска бота
const botInstanceId = Math.random().toString(36).substring(2, 8);

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


// — Жёстко зашитые константы —
const USDC_MINT             = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DECIMALS         = 6;
const SWAP_PROGRAM_ID       = new PublicKey("JUP4Fb2cFoZz7n6RzbA7gHq9jz6yJ3zyZhftyPS87ya");
const COOLDOWN_HOURS        = 1.0;

// — Инициализация —
const bot = new Telegraf(TELEGRAM_TOKEN);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// — Утилита: достать следующий сигнал из таблицы — 
async function fetchNextSignal() {
  console.log("[Signal] Checking for new signals...");
  const res = await pool.query(
    `SELECT id, token_mint
       FROM signals
      WHERE processed = false
      ORDER BY created_at
      LIMIT 1;`
  );
  if (res.rows.length === 0) {
    console.log("[Signal] No new signals found.");
    return null;
  }
  const { id, token_mint } = res.rows[0];
  console.log(`[Signal] Found signal id=${id}, mint=${token_mint}`);
  return { id, mint: new PublicKey(token_mint) };
}

// — Основные вспомогательные функции —

async function getQuote(inputMint, outputMint, amount) {
    // Добавляем AbortController для создания тайм-аута
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 секунд тайм-аут

    console.log(`[Quote] Requesting quote: ${inputMint.toBase58()}→${outputMint.toBase58()}, amount=${amount}, slippageBps=${SLIPPAGE_BPS}`);
    const url = `https://quote-api.jup.ag/v6/quote`
        + `?inputMint=${inputMint.toBase58()}`
        + `&outputMint=${outputMint.toBase58()}`
        + `&amount=${amount}`
        + `&slippageBps=${SLIPPAGE_BPS}`;
    
    try {
        const res = await fetch(url, {
            // Привязываем контроллер к запросу
            signal: controller.signal
        });

        if (!res.ok) throw new Error("Quote error: " + await res.text());
        const data = await res.json();
        console.log(`[Quote] Received outAmount=${data.outAmount}, priceImpactPct=${data.priceImpactPct}`);
        return data;
    } finally {
        // Важно! Очищаем таймер после выполнения запроса, чтобы избежать утечек памяти
        clearTimeout(timeoutId);
    }
}

async function getSwapTransaction(quoteResponse, userPubKey) {
  console.log("[SwapTx] Creating swap transaction via Jupiter API");
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
  console.log(`[SwapTx] Received swap transaction valid until block ${data.lastValidBlockHeight}`);
  return { 
      swapTransaction: data.swapTransaction, 
      lastValidBlockHeight: data.lastValidBlockHeight 
  };
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
            // Если есть ошибка, но это не тайм-аут, бросаем ее дальше
            throw new Error(JSON.stringify(confirmation.value.err));
        }

    } catch (e) {
        // Ловим ошибку, скорее всего это тайм-аут
        console.warn(`[Confirm V1] Primary confirmation failed for ${txid}: ${e.message}`);

        if (e.message.includes("block height exceeded")) {
            // Начинаем резервную проверку
            console.log(`[Confirm V2] Starting fallback confirmation check for ${txid}...`);
            await new Promise(resolve => setTimeout(resolve, 15000)); // Ждем 15 секунд

            const txInfo = await connection.getTransaction(txid, { maxSupportedTransactionVersion: 0 });

            if (txInfo) {
                console.log(`[Confirm V2] Fallback check successful! Transaction ${txid} is confirmed.`);
            } else {
                // Если даже после паузы транзакции нет - она действительно провалилась
                throw new Error(`[Confirm V2] Fallback check failed. Transaction ${txid} not found.`);
            }
        } else {
            // Если ошибка была не связана с тайм-аутом, просто пробрасываем ее
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

async function findTokenBalance(connection, wallet, mint) {
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
          await notify(`🚨 **CRITICAL RPC ERROR**\nFailed to get wallet balance after ${MAX_RETRIES} attempts. Skipping signal.`);
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

  async function processSignal(connection, wallet, signal, botInstanceId) {
  const { id: signalId, mint: outputMint } = signal;
  const mintAddress = outputMint.toBase58();
  console.log(`\n=== Processing ${mintAddress} ===`);

  const activePositionRes = await pool.query(`SELECT id FROM trades WHERE mint = $1 AND closed_at IS NULL LIMIT 1`, [mintAddress]);
  if (activePositionRes.rows.length > 0) {
    console.log(`[Validation] Position for ${mintAddress} is already active (trade id ${activePositionRes.rows[0].id}). Skipping signal.`);
    await pool.query(`UPDATE signals SET processed = true WHERE id = $1;`, [signalId]);
    return;
  }

  const cooldownCheckRes = await pool.query(`SELECT closed_at FROM trades WHERE mint = $1 ORDER BY closed_at DESC LIMIT 1`, [mintAddress]);
  if (cooldownCheckRes.rows.length > 0) {
      const lastClosed = new Date(cooldownCheckRes.rows[0].closed_at);
      const hoursSinceClose = (new Date() - lastClosed) / 3600000;
      if (hoursSinceClose < COOLDOWN_HOURS) {
          console.log(`[Validation] Cooldown period for ${mintAddress} is active (last sale ${hoursSinceClose.toFixed(2)}h ago). Skipping signal.`);
          await pool.query(`UPDATE signals SET processed = true WHERE id = $1;`, [signalId]);
          return;
      }
  }

  const usdcBalance = await findTokenBalance(connection, wallet, USDC_MINT);
  const requiredUsdcLamports = Math.round(AMOUNT_TO_SWAP_USD * 10 ** USDC_DECIMALS);
  if (usdcBalance < requiredUsdcLamports) {
    console.log(`[Validation] Insufficient USDC balance for ${mintAddress}. Have: ${usdcBalance}, Need: ${requiredUsdcLamports}`);
    // Формируем новое, более информативное сообщение
    const notifyMessage = `⚠️ **Insufficient Balance**\n` + 
                          `Token: \`${mintAddress}\`\n` +
                          `Not enough USDC to perform swap.\n` +
                          `Required: \`${AMOUNT_TO_SWAP_USD}\` USDC.`;
    await notify(notifyMessage, botInstanceId); // <-- Передаем ID
    await pool.query(`UPDATE signals SET processed = true WHERE id = $1;`, [signalId]);
    return;
}
  
  let outputDecimals;
  try {
    const tokenInfo = await connection.getParsedAccountInfo(outputMint);
    if (!tokenInfo || !tokenInfo.value) throw new Error("Could not fetch token info from chain");
    outputDecimals = tokenInfo.value.data.parsed.info.decimals;
    console.log(`[Info] Token decimals for ${mintAddress} is ${outputDecimals}`);
  } catch(e) {
    await notify(`🚨 **Error**\nCould not fetch token info for \`${mintAddress}\`. Skipping.`);
    await pool.query(`UPDATE signals SET processed = true WHERE id = $1;`, [signalId]);
    return;
  }

  const { ok, impactPct } = await runPriceImpactCheck(connection, outputMint, outputDecimals);
  if (!ok) {
    await notify(`⚠️ **Safety Check L1 Failed**\nToken: \`${mintAddress}\`\nImpact: \`${impactPct.toFixed(2)}%\` > \`${SAFE_PRICE_IMPACT_PERCENT}%\``);
    await pool.query(`UPDATE signals SET processed = true WHERE id = $1;`, [signalId]);
    return;
  }

  const isNotRugPull = await checkRugPullRisk(outputMint);
  if (!isNotRugPull) {
    await pool.query(`UPDATE signals SET processed = true WHERE id = $1;`, [signalId]);
    return;
  }
  
  await pool.query(`UPDATE signals SET processed = true WHERE id = $1;`, [signalId]);
  await notify(
    `✅ **All safety checks passed for** \`${mintAddress}\`\n` +
    `Impact: \`${impactPct.toFixed(2)}%\` < \`${SAFE_PRICE_IMPACT_PERCENT}%\`\n` +
    `Starting purchase.`,
    botInstanceId
  );
  
  let buyPricePerToken;
  let tradeId, initialBought, initialSpent;
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
      `[Tx](https://solscan.io/tx/${buyTxid})`
    );

    const res = await pool.query(
      `INSERT INTO trades(mint,bought_amount,spent_usdc,buy_tx,created_at)
       VALUES($1,$2,$3,$4,NOW()) RETURNING id, bought_amount, spent_usdc;`,
      [mintAddress, boughtTokens, AMOUNT_TO_SWAP_USD, buyTxid]
    );
    ({ id: tradeId, bought_amount: initialBought, spent_usdc: initialSpent } = res.rows[0]);
    console.log(`[DB] Inserted trade id=${tradeId}`);
} catch (e) {
    console.error("[Purchase] Purchase phase failed:", e);
    await notify(`🚨 **Purchase Failed** for \`${mintAddress}\`:\n\`${e.message}\``, botInstanceId);
    return; 
}

  // === НАЧАЛО ЦИКЛА МОНИТОРИНГА ===
  console.log("[Trailing] Starting position monitoring");
  let highestPrice = buyPricePerToken;
  const purchasePrice = buyPricePerToken;
  const purchaseTimestamp = Date.now();
  let lastLiquidityCheckTimestamp = Date.now();
  let totalUSDC = 0;
  let lastSellTx = null;

  while (true) {
      await new Promise(r => setTimeout(r, PRICE_CHECK_INTERVAL_MS));
      try {
          const priceQuote = await getQuote(outputMint, USDC_MINT, 10 ** outputDecimals);
          const currentPrice = Number(priceQuote.outAmount) / 10 ** outputDecimals;
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

          if (!sellReason && currentPrice <= stopPrice) {
              sellReason = "Trailing Stop-Loss";
          } else if (!sellReason && elapsedHours >= MAX_HOLDING_TIME_HOURS) {
              if (currentPL <= TIMEOUT_SELL_PL_THRESHOLD) {
                  sellReason = `Max Holding Time (${MAX_HOLDING_TIME_HOURS}h) with Loss`;
              } else {
                  console.log(`[Trailing] Max holding time reached, but position is profitable. TSL remains active.`);
              }
          }

          if (sellReason) {
            console.log(`[Sale] Triggered by: ${sellReason}. Starting cascading sell...`);
            await notify(`🔔 **Sale Triggered** for \`${mintAddress}\`\nReason: ${sellReason}`, botInstanceId);
            
            let balance = await findTokenBalance(connection, wallet, outputMint);
            let soldAmount = 0;
            let wasAnySaleSuccessful = false; // <-- НАШ НОВЫЙ ФЛАГ

            for (const pct of [100, 50, 25]) {
                if (balance === 0) break;
                const amountSell = Math.floor(balance * pct / 100);
                if (amountSell === 0) continue;

                console.log(`[Sale] Selling ${pct}% => ${amountSell} lamports`);
                try {
                    await approveToken(connection, wallet, outputMint, amountSell);
                    const sellQuote = await getQuote(outputMint, USDC_MINT, amountSell);
                    const { swapTransaction: sellTx, lastValidBlockHeight: sellLVBH } = await getSwapTransaction(
                        sellQuote,
                        wallet.publicKey.toBase58()
                    );
                    const sellTxid = await executeTransaction(connection, sellTx, wallet, sellLVBH);
                    lastSellTx = sellTxid;

                    const usdcReceived = Number(sellQuote.outAmount) / 10 ** USDC_DECIMALS;
                    totalUSDC += usdcReceived;
                    soldAmount += Number(sellQuote.route.inAmount) / (10 ** outputDecimals);
                    
                    wasAnySaleSuccessful = true; // <-- ОТМЕЧАЕМ УСПЕХ

                    const tokensSoldInChunk = Number(sellQuote.inAmount) / (10 ** outputDecimals);
                    const sellPrice = usdcReceived / tokensSoldInChunk;

                    console.log(`[Sale] Sold ${pct}% => received=${usdcReceived.toFixed(6)} USDC, tx=${sellTxid}`);
                    await notify(
                        `🔻 **Sold ${pct}%** of \`${mintAddress}\`\n` +
                        `Price: \`${sellPrice.toFixed(6)}\` USDC\n` + 
                        `Received: \`${usdcReceived.toFixed(4)}\` USDC\n` +
                        `[Tx](https://solscan.io/tx/${sellTxid})`
                    );
                    await new Promise(r => setTimeout(r, 5000));
                    balance = await findTokenBalance(connection, wallet, outputMint);
                } catch (e) {
                    console.error(`[Sale] Sell attempt for ${pct}% failed.`, e.message);
                    await notify(`🚨 **Sale Error (${pct}%)** for \`${mintAddress}\`:\n\`${e.message}\``, botInstanceId)
                }
            }
            
            // <-- НАША НОВАЯ ПРОВЕРКА
            if (!wasAnySaleSuccessful) {
                // Если ни одна попытка продажи не удалась, вызываем ошибку,
                // чтобы сработал внешний блок catch с логикой восстановления.
                throw new Error("All cascade sell attempts failed.");
            }

            if (await findTokenBalance(connection, wallet, outputMint) > 0) {
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
                `[Final Tx](https://solscan.io/tx/${lastSellTx}, botInstanceId)`
            );

            await pool.query(
                `UPDATE trades 
                    SET sold_amount   = $1, 
                        received_usdc = $2, 
                        pnl           = $3, 
                        sell_tx       = $4, 
                        closed_at     = NOW() 
                WHERE id = $5;`,
                [soldAmount, totalUSDC, pnl, lastSellTx, tradeId]
            );
            console.log(`[DB] Updated trade id=${tradeId} with sale info`);
            break; 
        }
      } catch (e) {
          // === НАЧАЛО НОВОГО БЛОКА ВОССТАНОВЛЕНИЯ ===
          console.error(`[Trailing] Error in trailing loop for ${mintAddress}:`, e.message);
          await notify(`🟡 **TSL Paused** for \`${mintAddress}\`\nAn error occurred: \`${e.message}\`\nVerifying position status...`, botInstanceId);
          
          console.log("[Recovery] Verifying token balance to decide next action...");
          const balance = await findTokenBalance(connection, wallet, outputMint);

          if (balance > 0) {
              // Если токен все еще на кошельке, значит ошибка была временной.
              console.log(`[Recovery] Token ${mintAddress} is still in the wallet. Resuming TSL after a delay.`);
              await notify(`✅ **TSL Resuming** for \`${mintAddress}\`. The token is still held. Monitoring continues.`);
              // Ждем минуту, чтобы не спамить запросами в случае проблем с API
              await new Promise(r => setTimeout(r, 60000));
              continue; // Продолжаем следующую итерацию цикла while
          } else {
              // Если баланс токена равен нулю, значит его продали вручную.
              console.log(`[Recovery] Token ${mintAddress} balance is zero. Assuming manual sell. Closing trade.`);
              await notify(`🔵 **Position Closed Manually** for \`${mintAddress}\`. The token is no longer in the wallet. Stopping monitoring.`);
              
              // Обновляем запись в БД, чтобы пометить сделку как закрытую вручную
              await pool.query(
                  `UPDATE trades 
                     SET sell_tx = 'MANUAL_OR_EXTERNAL_SELL',
                         closed_at = NOW()
                   WHERE id = $1;`,
                  [tradeId]
              );
              console.log(`[DB] Marked trade id=${tradeId} as manually closed.`);
              break; // Прерываем цикл while и выходим из мониторинга
          }
          // === КОНЕЦ НОВОГО БЛОКА ВОССТАНОВЛЕНИЯ ===
      }
  }
  // === КОНЕЦ ЦИКЛА МОНИТОРИНГА ===
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

function startHealthCheckServer() {
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
        notify(`✅ Health check server started on port ${PORT}.`);
    });
}


(async () => {
    const botInstanceId = Math.random().toString(36).substring(2, 8); // <--- ВОТ ЭТА СТРОКА ДОБАВЛЕНА
  
    await setupDatabase();
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
        process.exit(0);
      };
  
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  while (true) {
    try {
      const signal = await fetchNextSignal();
      if (signal) {
        console.log(`[Main] Received signal for ${signal.mint.toBase58()}`);
        await processSignal(connection, wallet, signal, botInstanceId);
        console.log(`[Main] Finished processing ${signal.mint.toBase58()}, looking for next signal.`);
      } else {
        await new Promise(r => setTimeout(r, SIGNAL_CHECK_INTERVAL_MS));
      }
    } catch (err) {
      console.error("[Main] Error in main loop:", err);
      await notify(`🚨 **FATAL ERROR** in main loop: \`${err.message}\``);
      await new Promise(r => setTimeout(r, SIGNAL_CHECK_INTERVAL_MS));
    }
  }
})().catch(async err => {
  console.error("Fatal error, exiting:", err);
  await notify(`💀 **FATAL SHUTDOWN**: \`${err.message}\``);
  await pool.end();
  process.exit(1);
});