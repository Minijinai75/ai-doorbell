#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { appendThreadBinding } = require('./codex-inbox');

function configPathFromArgs(argv) {
  const index = argv.indexOf('--config');
  return path.resolve(index >= 0 ? argv[index + 1] : path.join(__dirname, 'config.json'));
}

function threadIdFromArgs(argv) {
  const index = argv.indexOf('--thread');
  return index >= 0 ? argv[index + 1] : process.env.CODEX_THREAD_ID;
}

function main() {
  const configPath = configPathFromArgs(process.argv.slice(2));
  if (!fs.existsSync(configPath)) throw new Error(`找不到設定檔：${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.codex?.threadRegistryFile) {
    throw new Error('設定檔缺少 codex.threadRegistryFile');
  }
  const registryFile = path.isAbsolute(config.codex.threadRegistryFile)
    ? config.codex.threadRegistryFile
    : path.resolve(path.dirname(configPath), config.codex.threadRegistryFile);
  const entry = appendThreadBinding(registryFile, {
    threadId: threadIdFromArgs(process.argv.slice(2)),
    cwd: process.cwd(),
  });
  process.stdout.write(`✓ 已把這扇 Codex 窗接上門鈴：${entry.threadId}\n`);
  process.stdout.write(`  綁定紀錄：${registryFile}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`✗ ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { configPathFromArgs, threadIdFromArgs };
