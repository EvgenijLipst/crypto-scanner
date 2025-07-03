#!/usr/bin/env node

// Простой скрипт запуска для signal bot
require('ts-node').register({
  project: './tsconfig.json'
});

require('./src/index.ts'); 