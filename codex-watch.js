#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CodexAppServerClient } = require('./codex-app-server-client');
const { DeliveryLedger } = require('./codex-bridge-core');
const {
  deliverDiscordRecord,
  deliverWithRetry,
  shouldDeliverRecord,
} = require('./codex-delivery');
const { JsonlFollower, readLatestThreadBinding } = require('./codex-inbox');
const { spawnCodexAppServer } = require('./codex-stdio-transport');

function twNow() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: '2-digit', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date()).replace(' ', ' ');
}

function configPathFromArgs(argv) {
  const index = argv.indexOf('--config');
  return path.resolve(index >= 0 ? argv[index + 1] : path.join(__dirname, 'config.json'));
}

function resolveFromConfig(configPath, value) {
  return path.isAbsolute(value) ? value : path.resolve(path.dirname(configPath), value);
}

function loadConfig(configPath) {
  if (!fs.existsSync(configPath)) throw new Error(`找不到設定檔：${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.inboxFile) throw new Error('設定檔缺少 inboxFile');
  if (!config.codex?.threadRegistryFile) throw new Error('設定檔缺少 codex.threadRegistryFile');
  if (!config.codex?.ledgerFile) throw new Error('設定檔缺少 codex.ledgerFile');
  return config;
}

function createLogger(logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  return {
    log(level, message) {
      const line = `${twNow()} [${level}] ${message}`;
      process.stderr.write(`${line}\n`);
      stream.write(`${line}\n`);
    },
    close() { stream.end(); },
  };
}

function startCodexWatch({ configPath, checkOnly = false } = {}) {
  const config = loadConfig(configPath);
  const codex = config.codex;
  const inboxFile = resolveFromConfig(configPath, config.inboxFile);
  const registryFile = resolveFromConfig(configPath, codex.threadRegistryFile);
  const ledgerFile = resolveFromConfig(configPath, codex.ledgerFile);
  const logFile = resolveFromConfig(configPath, codex.logFile || './logs/codex-watch.log');
  const logger = createLogger(logFile);
  const binding = readLatestThreadBinding(registryFile);

  logger.log('INFO', `Codex 門鈴設定讀好了；inbox＝${inboxFile}`);
  if (binding) logger.log('INFO', `目前綁定 thread＝${binding.threadId}`);
  else logger.log('WARN', '目前沒有 thread 綁定；請在 Codex 窗執行 npm run codex:attach');
  if (checkOnly) {
    logger.close();
    return { close() {} };
  }

  const allowedChannels = (codex.channels || config.channels || []).map((entry) => (
    typeof entry === 'string' ? entry : entry.id
  )).filter(Boolean);
  const follower = new JsonlFollower(inboxFile, {
    onDiagnostic: (message) => logger.log('WARN', message),
  });
  const ledger = new DeliveryLedger(ledgerFile);
  let client = null;
  let closed = false;
  let queue = Promise.resolve();

  function resetClient() {
    client?.close();
    client = null;
  }

  function getClient() {
    if (client) return client;
    const transport = spawnCodexAppServer({
      cwd: binding?.cwd || process.cwd(),
      onDiagnostic: (message) => logger.log('APP', message),
    });
    client = new CodexAppServerClient({
      transport,
      requestTimeoutMs: codex.requestTimeoutMs || 30000,
    });
    return client;
  }

  async function send(record) {
    return deliverWithRetry({
      retryDelayMs: codex.retryDelayMs || 5000,
      onRetry(error, attempt) {
        resetClient();
        logger.log('WARN', `訊息 ${record.messageId} 第 ${attempt} 次未送入，排隊重試：${error.message}`);
      },
      operation: async () => {
        const latestBinding = readLatestThreadBinding(registryFile);
        if (!latestBinding) throw new Error('尚未綁定 Codex thread');
        try {
          const result = await deliverDiscordRecord({
            client: getClient(), ledger, record, binding: latestBinding,
          });
          logger.log('INFO', `訊息 ${record.messageId} 已送進 Codex thread ${latestBinding.threadId}`);
          return result;
        } catch (error) {
          resetClient();
          throw error;
        }
      },
    });
  }

  const timer = setInterval(() => {
    if (closed) return;
    let records;
    try {
      records = follower.poll();
    } catch (error) {
      logger.log('ERROR', `讀 inbox 失敗：${error.message}`);
      return;
    }
    for (const record of records) {
      if (!shouldDeliverRecord(record, {
        allowedChannels,
        ownAuthorId: codex.ownAuthorId,
      })) continue;
      if (ledger.has(record.messageId || record.id)) continue;
      queue = queue.then(() => send(record)).catch((error) => {
        logger.log('ERROR', `Codex 門鈴佇列失敗：${error.message}`);
      });
    }
  }, codex.pollIntervalMs || 500);

  logger.log('INFO', `Codex 門鈴開始守候；白名單頻道 ${allowedChannels.join('、') || '沿用全部 inbox'}`);
  return {
    close() {
      closed = true;
      clearInterval(timer);
      resetClient();
      logger.close();
    },
  };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  try {
    const watcher = startCodexWatch({
      configPath: configPathFromArgs(argv),
      checkOnly: argv.includes('--check'),
    });
    const stop = () => {
      watcher.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    process.stderr.write(`${twNow()} [ERROR] ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  configPathFromArgs,
  loadConfig,
  resolveFromConfig,
  startCodexWatch,
};
