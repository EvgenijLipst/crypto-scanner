require('dotenv').config();

// Простой тест для проверки критериев сигналов
function testSignalCriteria() {
  console.log('🔍 Testing signal criteria...');
  
  // Симулируем данные токена
  const testTokenData = {
    volumeSpike: 2.5,  // больше 2 ✅
    rsi: 42,           // меньше 45 ✅
    emaBull: true,     // ✅
    netFlow: 1.8,      // больше 1.5 ✅
    uniqueBuyers: 4,   // больше 3 ✅
    avgVol60m: 1500,   // больше 1000 ✅
    poolAgeOk: true,
    hasUsdcOrSol: true
  };
  
  // Проверяем критерии
  const volumeOk = testTokenData.volumeSpike >= 2;
  const rsiOk = testTokenData.rsi < 45;
  const emaOk = testTokenData.emaBull;
  const flowOk = testTokenData.netFlow >= 1.5;
  const buyersOk = testTokenData.uniqueBuyers >= 3;
  const volOk = testTokenData.avgVol60m >= 1000;
  
  const criteriaMet = [volumeOk, rsiOk, emaOk, flowOk, buyersOk, volOk].filter(Boolean).length;
  
  console.log('\n📊 Signal criteria analysis:');
  console.log(`• Volume Spike: ${testTokenData.volumeSpike}x ${volumeOk ? '✅' : '❌'}`);
  console.log(`• RSI: ${testTokenData.rsi} ${rsiOk ? '✅' : '❌'}`);
  console.log(`• EMA Bull: ${testTokenData.emaBull ? '✅' : '❌'}`);
  console.log(`• Net Flow: ${testTokenData.netFlow} ${flowOk ? '✅' : '❌'}`);
  console.log(`• Unique Buyers: ${testTokenData.uniqueBuyers} ${buyersOk ? '✅' : '❌'}`);
  console.log(`• Volume: $${testTokenData.avgVol60m} ${volOk ? '✅' : '❌'}`);
  console.log(`\n🎯 Criteria met: ${criteriaMet}/6`);
  
  const shouldSignal = criteriaMet >= 2 && testTokenData.poolAgeOk && testTokenData.hasUsdcOrSol;
  
  console.log(`\n🚀 Should generate signal: ${shouldSignal ? '✅ YES' : '❌ NO'}`);
  
  if (shouldSignal) {
    console.log('✅ With the new relaxed criteria, this token would generate a signal!');
  } else {
    console.log('❌ Even with relaxed criteria, this token would not generate a signal.');
  }
  
  return shouldSignal;
}

// Тест с разными сценариями
function testMultipleScenarios() {
  console.log('\n🧪 Testing multiple scenarios...\n');
  
  const scenarios = [
    {
      name: 'High Volume Token',
      data: { volumeSpike: 3.5, rsi: 50, emaBull: false, netFlow: 1.2, uniqueBuyers: 2, avgVol60m: 800 }
    },
    {
      name: 'Low RSI Token',
      data: { volumeSpike: 1.5, rsi: 35, emaBull: true, netFlow: 2.1, uniqueBuyers: 5, avgVol60m: 1200 }
    },
    {
      name: 'Balanced Token',
      data: { volumeSpike: 2.2, rsi: 40, emaBull: true, netFlow: 1.6, uniqueBuyers: 3, avgVol60m: 1100 }
    },
    {
      name: 'Poor Token',
      data: { volumeSpike: 1.1, rsi: 60, emaBull: false, netFlow: 0.8, uniqueBuyers: 1, avgVol60m: 500 }
    }
  ];
  
  let signalsGenerated = 0;
  
  scenarios.forEach((scenario, index) => {
    console.log(`\n--- Scenario ${index + 1}: ${scenario.name} ---`);
    
    const data = { ...scenario.data, poolAgeOk: true, hasUsdcOrSol: true };
    
    const volumeOk = data.volumeSpike >= 2;
    const rsiOk = data.rsi < 45;
    const emaOk = data.emaBull;
    const flowOk = data.netFlow >= 1.5;
    const buyersOk = data.uniqueBuyers >= 3;
    const volOk = data.avgVol60m >= 1000;
    
    const criteriaMet = [volumeOk, rsiOk, emaOk, flowOk, buyersOk, volOk].filter(Boolean).length;
    const shouldSignal = criteriaMet >= 2 && data.poolAgeOk && data.hasUsdcOrSol;
    
    console.log(`Criteria met: ${criteriaMet}/6`);
    console.log(`Signal: ${shouldSignal ? '✅ YES' : '❌ NO'}`);
    
    if (shouldSignal) signalsGenerated++;
  });
  
  console.log(`\n📊 Summary: ${signalsGenerated}/${scenarios.length} scenarios would generate signals`);
  console.log(`📈 Success rate: ${((signalsGenerated / scenarios.length) * 100).toFixed(1)}%`);
  
  if (signalsGenerated > 0) {
    console.log('\n✅ The relaxed criteria are working! Some tokens would generate signals.');
  } else {
    console.log('\n⚠️ Still no signals. Criteria may need further relaxation.');
  }
}

// Запуск тестов
testSignalCriteria();
testMultipleScenarios(); 