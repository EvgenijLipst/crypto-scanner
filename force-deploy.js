const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

async function forceDeploy() {
  console.log('🚀 STARTING FORCE DEPLOY WITH CACHE CLEAR...');
  
  try {
    // 1. Компилируем TypeScript
    console.log('🔨 Building TypeScript...');
    await execAsync('npm run build');
    console.log('✅ TypeScript compiled');

    // 2. Показываем текущий статус git
    console.log('📋 Current git status:');
    const { stdout: gitStatus } = await execAsync('git status --porcelain');
    if (gitStatus.trim()) {
      console.log('Modified files:');
      console.log(gitStatus);
      
      // 3. Добавляем все изменения
      console.log('📤 Adding all changes to git...');
      await execAsync('git add .');
      
      // 4. Коммитим изменения
      const commitMessage = `Fix token_mint issue with enhanced diagnostics - ${new Date().toISOString()}`;
      console.log(`📝 Committing changes: ${commitMessage}`);
      await execAsync(`git commit -m "${commitMessage}"`);
      
      // 5. Пушим в репозиторий
      console.log('🚀 Pushing to repository...');
      await execAsync('git push origin main');
      console.log('✅ Changes pushed to repository');
      
      console.log('\n🎉 FORCE DEPLOY COMPLETED!');
      console.log('📋 Railway should automatically redeploy with the new code');
      console.log('⏱️  Wait 2-3 minutes for deployment to complete');
      console.log('📱 Check Telegram for new diagnostic messages');
      
    } else {
      console.log('ℹ️  No changes to commit');
    }

  } catch (error) {
    console.error('❌ FORCE DEPLOY FAILED:', error.message);
    if (error.stdout) console.log('STDOUT:', error.stdout);
    if (error.stderr) console.log('STDERR:', error.stderr);
    throw error;
  }
}

// Запускаем принудительный деплой
forceDeploy().catch(console.error); 