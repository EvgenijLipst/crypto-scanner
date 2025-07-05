// Быстрый тест Jupiter API
const fetch = require('cross-fetch');

async function testJupiterAPI() {
  try {
    console.log('🧪 Testing Jupiter API...');
    
    const url = 'https://quote-api.jup.ag/v6/quote?' +
      'inputMint=So11111111111111111111111111111111111111112&' + // SOL
      'outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&' + // USDC (правильный)
      'amount=1000000000&' + // 1 SOL
      'slippageBps=50';
    
    console.log('📡 URL:', url);
    
    const response = await fetch(url);
    console.log('📊 Status:', response.status, response.statusText);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.log('❌ Error response:', errorText);
      return;
    }
    
    const quote = await response.json();
    console.log('✅ Quote received:');
    console.log('• Input amount:', quote.inAmount);
    console.log('• Output amount:', quote.outAmount);
    console.log('• Price impact:', quote.priceImpactPct);
    
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

testJupiterAPI(); 