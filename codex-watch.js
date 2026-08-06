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
const { ensureDiscordReplyThread } = require('./codex-reply-thread');
const { spawnCodexAppServer } = require('./codex-stdio-transport');
const { connectCodexAppServer } = require('./codex-websocket-transport');
const { createDiscordSenderFromConfig } = require('./discord-send');

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
  if (config.codex.appServerUrl) {
    let endpoint;
    try {
      endpoint = new URL(config.codex.appServerUrl);
    } catch {
      throw new Error('codex.appServerUrl 必須是有效的 loopback WebSocket URL');
    }
    const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
    if (endpoint.protocol !== 'ws:' || !loopbackHosts.has(endpoint.hostname)) {
      throw new Error('codex.appServerUrl 只接受 ws:// loopback endpoint');
    }
  }
  if (config.codex.discordReply?.enabled) {
    const threadMode = config.codex.discordReply.threadMode || 'fork';
    const actionPolicy = config.codex.discordReply.actionPolicy || 'chat-only';
    if (!['bound', 'fork'].includes(threadMode)) {
      throw new Error('codex.discordReply.threadMode 只能是 bound 或 fork');
    }
    if (!['chat-only', 'reversible'].includes(actionPolicy)) {
      throw new Error('codex.discordReply.actionPolicy 只能是 chat-only 或 reversible');
    }
    if (actionPolicy === 'reversible' && threadMode !== 'bound') {
      throw new Error('codex.discordReply.actionPolicy=reversible 必須搭配 threadMode=bound');
    }
    if (!Array.isArray(config.codex.discordReply.allowedAuthorIds)
      || config.codex.discordReply.allowedAuthorIds.length === 0) {
      throw new Error('雙向 Discord 必須設定 codex.discordReply.allowedAuthorIds 白名單');
    }
    if (threadMode === 'fork' && !config.codex.discordReply.threadRegistryFile) {
      throw new Error('雙向 Discord 必須設定 codex.discordReply.threadRegistryFile');
    }
    if (!config.tokenFile) throw new Error('雙向 Discord 必須設定 tokenFile');
  }
  return config;
}

function createCodexTransport({
  appServerUrl,
  cwd,
  onDiagnostic,
  connect = connectCodexAppServer,
  spawn = spawnCodexAppServer,
} = {}) {
  if (appServerUrl) return connect(appServerUrl, { onDiagnostic });
  return spawn({ cwd, onDiagnostic });
}

async function warmCodexClient({ binding, getClient } = {}) {
  if (!binding?.threadId) return null;
  return getClient(binding).resumeThread(binding.threadId);
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
  const replyConfig = codex.discordReply?.enabled ? codex.discordReply : null;
  const replyThreadMode = replyConfig?.threadMode || 'fork';
  const replyThreadRegistryFile = replyConfig && replyThreadMode === 'fork'
    ? resolveFromConfig(configPath, replyConfig.threadRegistryFile)
    : null;
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
  let discordSender = null;
  let closed = false;
  let queue = Promise.resolve();

  function resetClient() {
    client?.close();
    client = null;
  }

  function getClient(activeBinding = binding) {
    if (client) return client;
    const transport = createCodexTransport({
      appServerUrl: codex.appServerUrl,
      cwd: activeBinding?.cwd || process.cwd(),
      onDiagnostic: (message) => logger.log('APP', message),
    });
    client = new CodexAppServerClient({
      transport,
      requestTimeoutMs: codex.requestTimeoutMs || 30000,
    });
    return client;
  }

  function getDiscordSender() {
    if (!discordSender) discordSender = createDiscordSenderFromConfig(config, configPath);
    return discordSender;
  }

  const ready = warmCodexClient({ binding, getClient }).then((thread) => {
    if (thread) {
      const endpoint = codex.appServerUrl || 'private stdio app-server';
      logger.log('INFO', `Codex 家鈴已連上 ${endpoint}，並訂閱 thread ${thread.id}`);
    }
    return thread;
  }).catch((error) => {
    resetClient();
    logger.log('WARN', `Codex 家鈴啟動連線失敗，收到訊息時會重試：${error.message}`);
    return null;
  });

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
          const activeClient = getClient(latestBinding);
          const deliveryBinding = replyConfig && replyThreadMode === 'fork'
            ? await ensureDiscordReplyThread({
              client: activeClient,
              registryFile: replyThreadRegistryFile,
              sourceBinding: latestBinding,
            })
            : latestBinding;
          const result = await deliverDiscordRecord({
            client: activeClient,
            ledger,
            record,
            binding: deliveryBinding,
            discordReply: replyConfig ? {
              send: (payload) => getDiscordSender().send(payload),
              responseTimeoutMs: replyConfig.responseTimeoutMs || 600000,
              restrictExecution: replyThreadMode === 'fork',
              allowActions: replyConfig.actionPolicy === 'reversible',
            } : null,
          });
          if (replyConfig) {
            logger.log('INFO', `訊息 ${record.messageId} 已由 Codex thread ${deliveryBinding.threadId} 回覆 Discord`);
          } else {
            logger.log('INFO', `訊息 ${record.messageId} 已送進 Codex thread ${latestBinding.threadId}`);
          }
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
        allowedAuthorIds: replyConfig?.allowedAuthorIds || [],
        ownAuthorId: codex.ownAuthorId,
      })) continue;
      if (ledger.has(record.messageId || record.id)) continue;
      queue = queue.then(() => send(record)).catch((error) => {
        logger.log('ERROR', `Codex 門鈴佇列失敗：${error.message}`);
      });
    }
  }, codex.pollIntervalMs || 500);

  const mode = replyConfig
    ? `雙向 DC 對話（${replyThreadMode === 'bound' ? '沿用原 thread' : '專用 fork'}）`
    : '只送入 Codex';
  logger.log('INFO', `Codex 門鈴開始守候（${mode}）；白名單頻道 ${allowedChannels.join('、') || '沿用全部 inbox'}`);
  return {
    ready,
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
  createCodexTransport,
  loadConfig,
  resolveFromConfig,
  startCodexWatch,
  warmCodexClient,
};
