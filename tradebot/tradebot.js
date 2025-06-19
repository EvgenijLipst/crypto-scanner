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
const TelegramBot = require("node-telegram-bot-api");
const { Client: PgClient } = require("pg");

// — Переменные окружения (Railway Variables) —
const SOLANA_RPC_URL                = process.env.SOLANA_RPC_URL;
const WALLET_PRIVATE_KEY            = process.env.WALLET_PRIVATE_KEY;
const DATABASE_URL                  = process.env.DATABASE_URL;
const TELEGRAM_TOKEN                = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID              = process.env.TELEGRAM_CHAT_ID;

const AMOUNT_TO_SWAP_USD            = parseFloat(process.env.AMOUNT_TO_SWAP_USD);
const TRAILING_STOP_PERCENTAGE      = parseFloat(process.env.TRAILING_STOP_PERCENTAGE);
const SAFE_PRICE_IMPACT_PERCENT     = parseFloat(process.env.SAFE_PRICE_IMPACT_PERCENT);
const OUTPUT_DECIMALS               = parseInt(process.env.OUTPUT_DECIMALS, 10);
const PRICE_CHECK_INTERVAL_MS       = parseInt(process.env.PRICE_CHECK_INTERVAL_MS, 10);
const SIGNAL_CHECK_INTERVAL_MS      = parseInt(process.env.SIGNAL_CHECK_INTERVAL_MS, 10) || 5000;
const MAX_HOLDING_TIME_HOURS        = parseFloat(process.env.MAX_HOLDING_TIME_HOURS) || 24;
const TIMEOUT_SELL_PL_THRESHOLD     = parseFloat(process.env.TIMEOUT_SELL_PL_THRESHOLD) || -0.01;

// — Жёстко зашитые константы —
const USDC_MINT             = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DECIMALS         = 6;
const SWAP_PROGRAM_ID       = new PublicKey("JUP4Fb2cFoZz7n6RzbA7gHq9jz6yJ3zyZhftyPS87ya");

// — Инициализация —
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const db  = new PgClient({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// — Утилита: достать следующий сигнал из таблицы — 
async function fetchNextSignal() {
  console.log("[Signal] Checking for new signals...");
  const res = await db.query(
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
  await db.query(`UPDATE signals SET processed = true WHERE id = $1;`, [id]);
  console.log(`[Signal] Marked signal id=${id} as processed.`);
  return new PublicKey(token_mint);
}

// — Основные вспомогательные функции —
async function getQuote(inputMint, outputMint, amount, slippageBps = 50) {
  console.log(`[Quote] Requesting quote: ${inputMint.toBase58()}→${outputMint.toBase58()}, amount=${amount}`);
  const url = `https://quote-api.jup.ag/v6/quote`
    + `?inputMint=${inputMint.toBase58()}`
    + `&outputMint=${outputMint.toBase58()}`
    + `&amount=${amount}`
    + `&slippageBps=${slippageBps}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Quote error: " + await res.text());
  const data = await res.json();
  console.log(`[Quote] Received outAmount=${data.outAmount}, priceImpactPct=${data.priceImpactPct}`);
  return data;
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
  const tx  = VersionedTransaction.deserialize(buf);
  tx.sign([wallet]);
  const txid = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 5
  });
  console.log(`[Execute] tx sent: ${txid}, awaiting confirmation until block ${lastValidBlockHeight}`);
  
  const confirmation = await connection.confirmTransaction({
      signature: txid,
      blockhash: tx.message.recentBlockhash,
      lastValidBlockHeight: lastValidBlockHeight
  }, "confirmed");

  if (confirmation.value.err) throw new Error("TX failed: " + JSON.stringify(confirmation.value.err));
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
    
    const confirmation = await connection.confirmTransaction({
        signature: txid,
        blockhash: blockhash,
        lastValidBlockHeight: lastValidBlockHeight
    }, 'confirmed');

    if (confirmation.value.err) {
      throw new Error("Simple TX failed: " + JSON.stringify(confirmation.value.err));
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
  const resp = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { mint },
    "confirmed"
  );
  const bal = resp.value.length > 0
    ? parseInt(resp.value[0].account.data.parsed.info.tokenAmount.amount, 10)
    : 0;
  console.log(`[Balance] ${mint.toBase58()} balance = ${bal}`);
  return bal;
}

// --- Функции Безопасности ---
async function runPriceImpactCheck(outputMint) {
    console.log(`[Safety L1] Running Price Impact Check for ${outputMint.toBase58()}`);
    try {
        const amountForPriceCheck = 10 * (10 ** USDC_DECIMALS);
        const priceQuote = await getQuote(USDC_MINT, outputMint, amountForPriceCheck);
        const amountOfTokensFor10USD = parseInt(priceQuote.outAmount);
        if (amountOfTokensFor10USD === 0) throw new Error("Token not tradable, outAmount is zero.");
        
        const amountToSimulateSell = amountOfTokensFor10USD * 5; // ~$50
        const sellQuote = await getQuote(outputMint, USDC_MINT, amountToSimulateSell);
        const impactPct = parseFloat(sellQuote.priceImpactPct) * 100;

        console.log(`[Safety L1] Sell simulation impact: ${impactPct.toFixed(4)}%`);
        if (impactPct > SAFE_PRICE_IMPACT_PERCENT) {
            await notify(`⚠️ **Safety L1 Failed**\nToken: \`${outputMint.toBase58()}\`\nImpact: \`${impactPct.toFixed(2)}%\` > \`${SAFE_PRICE_IMPACT_PERCENT}%\``);
            return false;
        }
        console.log(`[Safety L1] OK`);
        return true;
    } catch (error) {
        await notify(`🚨 **Safety L1 Error**\nToken: \`${outputMint.toBase58()}\`\nError: \`${error.message}\``);
        return false;
    }
}

async function checkRugPullRisk(tokenMint) {
    console.log(`[Safety L2] Running Rug Pull Check for ${tokenMint.toBase58()}`);
    try {
        const url = `https://api.rugcheck.xyz/v1/tokens/${tokenMint.toBase58()}/report`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`rugcheck.xyz API unavailable (status: ${response.status})`);
        
        const data = await response.json();
        const liquidityRisk = data.risks.find(risk => risk.name === "liquidity");
        
        if (liquidityRisk && liquidityRisk.level === "danger") {
            await notify(`⚠️ **Safety L2 Failed**\nToken: \`${tokenMint.toBase58()}\`\nReason: \`${liquidityRisk.description}\``);
            return false;
        }
        console.log(`[Safety L2] OK`);
        return true;
    } catch (error) {
        console.warn(`[Safety L2] Warning: Could not perform rug pull check. Proceeding with caution. Error: ${error.message}`);
        await notify(`🟡 **Safety L2 Warning**\nCould not perform rug pull check for \`${tokenMint.toBase58()}\`. Proceeding with caution.`);
        return true;
    }
}


// — Telegram уведомление —
async function notify(text) {
  try {
    console.log("[Notify] " + text.replace(/\n/g, " | "));
    await bot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error("Telegram notification failed:", e.message);
  }
}

// — Обработка одного сигнала —
async function processSignal(connection, wallet, outputMint) {
  console.log(`\n=== Processing ${outputMint.toBase58()} ===`);

  const isImpactSafe = await runPriceImpactCheck(outputMint);
  if (!isImpactSafe) return;
  
  const isNotRugPull = await checkRugPullRisk(outputMint);
  if (!isNotRugPull) return;

  await notify(`✅ **All safety checks passed for** \`${outputMint.toBase58()}\`. Starting purchase.`);
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

  const boughtTokens     = Number(buyQuote.outAmount) / 10 ** OUTPUT_DECIMALS;
  const buyPricePerToken = AMOUNT_TO_SWAP_USD / boughtTokens;
  console.log(`[Purchase] Bought ${boughtTokens.toFixed(6)} @ ${buyPricePerToken.toFixed(6)} USDC/token, tx=${buyTxid}`);
  await notify(
    `✅ **Purchased**\nToken: \`${outputMint.toBase58()}\`\n` +
    `Amount: \`${boughtTokens.toFixed(4)}\`\n` +
    `Price: \`${buyPricePerToken.toFixed(6)}\` USDC\n` +
    `Spent: \`${AMOUNT_TO_SWAP_USD.toFixed(2)}\` USDC\n` +
    `[Tx](https://solscan.io/tx/${buyTxid})`
  );

  const res = await db.query(
    `INSERT INTO trades(mint,bought_amount,spent_usdc,buy_tx,created_at)
     VALUES($1,$2,$3,$4,NOW()) RETURNING id, bought_amount, spent_usdc;`,
    [outputMint.toBase58(), boughtTokens, AMOUNT_TO_SWAP_USD, buyTxid]
  );
  const { id: tradeId, bought_amount: initialBought, spent_usdc: initialSpent } = res.rows[0];
  console.log(`[DB] Inserted trade id=${tradeId}`);

  console.log("[Trailing] Starting position monitoring");
  let highestPrice      = buyPricePerToken;
  const purchasePrice   = buyPricePerToken;
  const purchaseTimestamp = Date.now();

  while (true) {
    await new Promise(r => setTimeout(r, PRICE_CHECK_INTERVAL_MS));
    try {
      const priceQuote = await getQuote(outputMint, USDC_MINT, 10 ** OUTPUT_DECIMALS, 500);
      const currentPrice  = Number(priceQuote.outAmount) / 10 ** USDC_DECIMALS;
      highest = Math.max(highest, currentPrice);

      const elapsedHours = (Date.now() - purchaseTimestamp) / (3600 * 1000);
      const currentPL    = (currentPrice - purchasePrice) / purchasePrice;
      const stopPrice    = highest * (1 - TRAILING_STOP_PERCENTAGE / 100);

      console.log(`[Trailing] price=${currentPrice.toFixed(6)}, P/L=${(currentPL*100).toFixed(2)}%, stop=${stopPrice.toFixed(6)}, time=${elapsedHours.toFixed(1)}h`);
      
      let sellReason = null;
      if (currentPrice <= stopPrice) {
          sellReason = "Trailing Stop-Loss";
      } else if (elapsedHours >= MAX_HOLDING_TIME_HOURS) {
          if (currentPL <= TIMEOUT_SELL_PL_THRESHOLD) {
              sellReason = `Max Holding Time (${MAX_HOLDING_TIME_HOURS}h) with Loss`;
          } else {
              console.log(`[Trailing] Max holding time reached, but position is profitable. TSL remains active.`);
          }
      }

      if (sellReason) {
        console.log(`[Sale] Triggered by: ${sellReason}. Starting cascading sell...`);
        await notify(`🔔 **Sale Triggered** for \`${outputMint.toBase58()}\`\nReason: ${sellReason}`);
        let balance = await findTokenBalance(connection, wallet, outputMint);

        for (const pct of [100, 50, 25]) {
          if (balance === 0) break;
          const amountSell = Math.floor(balance * pct / 100);
          console.log(`[Sale] Selling ${pct}% => ${amountSell} lamports`);
          await approveToken(connection, wallet, outputMint, amountSell);

          const sellQuote = await getQuote(outputMint, USDC_MINT, amountSell);
          const { swapTransaction: sellTx, lastValidBlockHeight: sellLVBH } = await getSwapTransaction(
            sellQuote,
            wallet.publicKey.toBase58()
          );
          const sellTxid = await executeTransaction(connection, sellTx, wallet, sellLVBH);
          
          const usdcReceived = Number(sellQuote.outAmount) / 10 ** USDC_DECIMALS;
          totalUSDC        += usdcReceived;
          lastSellTx = sellTxid;
          
          console.log(`[Sale] Sold ${pct}% => received=${usdcReceived.toFixed(6)} USDC, tx=${sellTxid}`);
          await notify(
            `🔻 **Sold ${pct}%** of \`${outputMint.toBase58()}\`\n` +
            `Received: \`${usdcReceived.toFixed(4)}\` USDC\n` +
            `[Tx](https://solscan.io/tx/${sellTxid})`
          );
          balance = await findTokenBalance(connection, wallet, outputMint);
        }
        
        if (await findTokenBalance(connection, wallet, outputMint) > 0) {
            console.log("[Sale] Final revoke for remaining balance");
            await revokeToken(connection, wallet, outputMint);
        }

        const pnl = totalUSDC - initialSpent;
        console.log(`[PNL] spent=${initialSpent.toFixed(2)}, received=${totalUSDC.toFixed(2)}, pnl=${pnl.toFixed(2)}`);
        await notify(
          `💰 **Trade Complete** for \`${outputMint.toBase58()}\`\n` +
          `Bought for: \`${initialSpent.toFixed(2)}\` USDC\n` +
          `Sold for: \`${totalUSDC.toFixed(2)}\` USDC\n` +
          `**PnL: \`${pnl.toFixed(2)}\` USDC**\n` +
          `[Final Tx](https://solscan.io/tx/${lastSellTx})`
        );

        await db.query(
          `UPDATE trades
              SET sold_amount   = $1,
                  received_usdc = $2,
                  pnl           = $3,
                  sell_tx       = $4,
                  closed_at     = NOW()
            WHERE id = $5;`,
          [initialBought, totalUSDC, pnl, lastSellTx, tradeId]
        );
        console.log(`[DB] Updated trade id=${tradeId} with sale info`);
        break;
      }
    } catch(e) {
        console.error("[Trailing] Error in trailing loop", e.message);
        await notify(`Crashed in trailing loop for ${outputMint.toBase58()}: ${e.message}`);
    }
  }
}

// — Главный цикл —
(async () => {
  await db.connect();
  console.log("--- Tradebot worker started ---");
  await notify("🚀 Tradebot worker started!");

  const wallet     = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");

  while (true) {
    try {
      const mint = await fetchNextSignal();
      if (mint) {
        console.log(`[Main] Received signal for ${mint.toBase58()}`);
        await processSignal(connection, wallet, mint);
        console.log(`[Main] Finished processing ${mint.toBase58()}, looking for next signal.`);
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
  process.exit(1);
});