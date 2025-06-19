// tradebot/tradebot.js

const {
    Connection,
    Keypair,
    PublicKey,
    VersionedTransaction
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
  
  // — Жёстко зашитые константы —
  const USDC_MINT       = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const USDC_DECIMALS   = 6;
  const SWAP_PROGRAM_ID = new PublicKey("JUP4Fb2cFoZz7n6RzbA7gHq9jz6yJ3zyZhftyPS87ya");
  
  // — Параметры из окружения (Railway Variables) —
  const SOLANA_RPC_URL            = process.env.SOLANA_RPC_URL;
  const WALLET_PRIVATE_KEY        = process.env.WALLET_PRIVATE_KEY;
  const AMOUNT_TO_SWAP_USD        = parseFloat(process.env.AMOUNT_TO_SWAP_USD);
  const PRICE_CHECK_INTERVAL_MS   = parseInt(process.env.PRICE_CHECK_INTERVAL_MS, 10);
  const TRAILING_STOP_PERCENTAGE  = parseFloat(process.env.TRAILING_STOP_PERCENTAGE);
  const OUTPUT_DECIMALS           = parseInt(process.env.OUTPUT_DECIMALS, 10);
  const SAFE_PRICE_IMPACT_PERCENT = parseFloat(process.env.SAFE_PRICE_IMPACT_PERCENT);
  const TELEGRAM_TOKEN            = process.env.TELEGRAM_TOKEN;
  const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;
  const DATABASE_URL              = process.env.DATABASE_URL;
  
  // — Инициализация Telegram и Postgres —
  const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
  const db  = new PgClient({ connectionString: DATABASE_URL });
  
  // — Утилиты БД для сигналов —
  async function fetchNextSignal() {
    const res = await db.query(
      `SELECT id, token_mint 
         FROM signals 
        WHERE processed = false 
        ORDER BY created_at 
        LIMIT 1;`
    );
    if (res.rows.length === 0) return null;
    const { id, token_mint } = res.rows[0];
    await db.query(`UPDATE signals SET processed = true WHERE id = $1;`, [id]);
    return new PublicKey(token_mint);
  }
  
  // — Основные вспомогательные функции —
  async function getQuote(inputMint, outputMint, amount, slippageBps = 50) {
    const url = `https://quote-api.jup.ag/v6/quote`
      + `?inputMint=${inputMint.toBase58()}`
      + `&outputMint=${outputMint.toBase58()}`
      + `&amount=${amount}`
      + `&slippageBps=${slippageBps}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Quote error: " + await res.text());
    return res.json();
  }
  
  async function getSwapTransaction(quoteResponse, userPubKey) {
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
    if (!res.ok) throw new Error("Swap tx error: " + res.statusText);
    return res.json();
  }
  
  async function executeTransaction(connection, rawTx, wallet) {
    const buf = Buffer.from(rawTx, "base64");
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([wallet]);
    const txid = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 5
    });
    const conf = await connection.confirmTransaction(txid, "confirmed");
    if (conf.value.err) throw new Error("TX failed: " + JSON.stringify(conf.value.err));
    return txid;
  }
  
  async function approveToken(connection, wallet, mint, amountLamports) {
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
    const ix  = createApproveInstruction(ata, SWAP_PROGRAM_ID, wallet.publicKey, amountLamports, []);
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new VersionedTransaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash });
    tx.add(ix);
    tx.sign([wallet]);
    await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  }
  
  async function revokeToken(connection, wallet, mint) {
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
    const ix  = createRevokeInstruction(ata, wallet.publicKey, []);
    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new VersionedTransaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash });
    tx.add(ix);
    tx.sign([wallet]);
    await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  }
  
  async function findTokenBalance(connection, wallet, mint) {
    const resp = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { mint },
      "confirmed"
    );
    if (resp.value.length === 0) return 0;
    return parseInt(resp.value[0].account.data.parsed.info.tokenAmount.amount, 10);
  }
  
  // — Проверка SAFE_PRICE_IMPACT_PERCENT —
  async function runSafetyCheck(connection, outputMint) {
    const checkLamports = 50 * 10 ** USDC_DECIMALS;
    const buyQuote      = await getQuote(USDC_MINT, outputMint, checkLamports);
    const tokensFor50   = buyQuote.outAmount;
    if (tokensFor50 === "0") throw new Error("Token not tradable");
    const sellQuote   = await getQuote(outputMint, USDC_MINT, tokensFor50);
    const impactPct   = parseFloat(sellQuote.priceImpactPct) * 100;
    return { ok: impactPct <= SAFE_PRICE_IMPACT_PERCENT, impactPct };
  }
  
  // — Telegram уведомление —
  async function notify(text) {
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, text);
  }
  
  // — Логика обработки одного сигнала —
  async function processSignal(connection, wallet, outputMint) {
    // 1) Safety check
    const { ok, impactPct } = await runSafetyCheck(connection, outputMint);
    if (!ok) {
      const msg = `⚠️ Safety failed: impact ${impactPct.toFixed(2)}% > ${SAFE_PRICE_IMPACT_PERCENT}%`;
      await notify(msg);
      return;
    }
  
    // 2) Покупка
    const usdcLamports     = Math.round(AMOUNT_TO_SWAP_USD * 10 ** USDC_DECIMALS);
    await approveToken(connection, wallet, USDC_MINT, usdcLamports);
    const buyQuote         = await getQuote(USDC_MINT, outputMint, usdcLamports);
    const { swapTransaction } = await getSwapTransaction(buyQuote, wallet.publicKey.toBase58());
    const buyTxid          = await executeTransaction(connection, swapTransaction, wallet);
    await revokeToken(connection, wallet, USDC_MINT);
  
    const boughtTokens     = Number(buyQuote.outAmount) / 10 ** OUTPUT_DECIMALS;
    const buyPricePerToken = AMOUNT_TO_SWAP_USD / boughtTokens;
  
    // Запись покупки в БД
    const res = await db.query(
      `INSERT INTO trades(mint, bought_amount, spent_usdc, buy_tx, created_at)
       VALUES($1,$2,$3,$4,NOW()) RETURNING id, bought_amount, spent_usdc;`,
      [ outputMint.toBase58(), boughtTokens, AMOUNT_TO_SWAP_USD, buyTxid ]
    );
    const tradeId      = res.rows[0].id;
    const initialSpent = res.rows[0].spent_usdc;
    const initialBought = res.rows[0].bought_amount;
  
    // Уведомление о покупке
    await notify(
      `✅ Purchased ${outputMint.toBase58()}\n` +
      `Amount: ${boughtTokens.toFixed(6)}\n` +
      `Price/token: ${buyPricePerToken.toFixed(6)} USDC\n` +
      `Spent: ${AMOUNT_TO_SWAP_USD.toFixed(6)} USDC\n` +
      `Tx: https://solscan.io/tx/${buyTxid}`
    );
  
    // 3) Trailing stop
    let highest    = 0;
    let totalUSDC  = 0;
    let lastSellTx = null;
  
    while (true) {
      await new Promise(r => setTimeout(r, PRICE_CHECK_INTERVAL_MS));
      const priceQuote = await getQuote(outputMint, USDC_MINT, 10 ** OUTPUT_DECIMALS);
      const current     = Number(priceQuote.outAmount) / 10 ** USDC_DECIMALS;
      highest          = Math.max(highest, current);
      const stopPrice  = highest * (1 - TRAILING_STOP_PERCENTAGE / 100);
      if (current <= stopPrice) {
        let balance = await findTokenBalance(connection, wallet, outputMint);
        for (let pct of [100,50,25]) {
          if (balance === 0) break;
          const amountSell = Math.floor(balance * pct/100);
          await approveToken(connection, wallet, outputMint, amountSell);
          const sellQuote = await getQuote(outputMint, USDC_MINT, amountSell);
          const { swapTransaction: sellTx } = await getSwapTransaction(sellQuote, wallet.publicKey.toBase58());
          const sellTxid = await executeTransaction(connection, sellTx, wallet);
          lastSellTx = sellTxid;
          await revokeToken(connection, wallet, outputMint);
  
          const usdcReceived = Number(sellQuote.outAmount) / 10 ** USDC_DECIMALS;
          totalUSDC += usdcReceived;
          balance    = await findTokenBalance(connection, wallet, outputMint);
  
          await notify(
            `🔻 Sold ${pct}% of ${outputMint.toBase58()}\n` +
            `Amount: ${(amountSell/10**OUTPUT_DECIMALS).toFixed(6)}\n` +
            `Received: ${usdcReceived.toFixed(6)} USDC\n` +
            `Tx: https://solscan.io/tx/${sellTxid}`
          );
        }
        if (await findTokenBalance(connection, wallet, outputMint) === 0) {
          await revokeToken(connection, wallet, outputMint);
          await notify(`⛔ Revoked approval for ${outputMint.toBase58()}`);
        }
        const pnl = totalUSDC - initialSpent;
        await notify(
          `💰 Trade complete for ${outputMint.toBase58()}\n` +
          `Bought: ${initialSpent.toFixed(6)} USDC\n` +
          `Sold: ${totalUSDC.toFixed(6)} USDC\n` +
          `PnL: ${pnl.toFixed(6)} USDC\n` +
          `Final Tx: https://solscan.io/tx/${lastSellTx}`
        );
        await db.query(
          `UPDATE trades
              SET sold_amount   = $1,
                  received_usdc = $2,
                  pnl           = $3,
                  sell_tx       = $4,
                  closed_at     = NOW()
            WHERE id = $5;`,
          [ initialBought, totalUSDC, pnl, lastSellTx, tradeId ]
        );
        break;
      }
    }
  }
  
  // — Главный цикл —  
  (async () => {
    await db.connect();
    console.log("--- Tradebot worker started ---");
    const wallet     = Keypair.fromSecretKey(bs58.decode(WALLET_PRIVATE_KEY));
    const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  
    while (true) {
      const tokenMint = await fetchNextSignal();
      if (tokenMint) {
        console.log("Processing signal:", tokenMint.toBase58());
        try {
          await processSignal(connection, wallet, tokenMint);
        } catch (err) {
          console.error("Error processing signal:", err);
        }
      } else {
        // Нет сигналов — ждем 10 секунд
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  })().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
  