'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createCodexTransport,
  loadConfig,
  warmCodexClient,
} = require('../codex-watch');

test('雙向 Discord 沒有指定 author 白名單時拒絕啟動', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-config-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    inboxFile: 'inbox.jsonl',
    tokenFile: 'token.txt',
    codex: {
      threadRegistryFile: 'threads.jsonl',
      ledgerFile: 'ledger.jsonl',
      discordReply: {
        enabled: true,
        threadRegistryFile: 'discord-thread.jsonl',
      },
    },
  }));

  assert.throws(() => loadConfig(configFile), /allowedAuthorIds/);
});

test('沿用綁定原 thread 時不要求 DC fork registry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-bound-config-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    inboxFile: 'inbox.jsonl',
    tokenFile: 'token.txt',
    codex: {
      threadRegistryFile: 'threads.jsonl',
      ledgerFile: 'ledger.jsonl',
      discordReply: {
        enabled: true,
        threadMode: 'bound',
        allowedAuthorIds: ['mini'],
      },
    },
  }));

  const config = loadConfig(configFile);
  assert.equal(config.codex.discordReply.threadMode, 'bound');
});

test('DC 實作權只能開在沿用原 thread 的白名單模式', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-action-config-'));
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    inboxFile: 'inbox.jsonl',
    tokenFile: 'token.txt',
    codex: {
      threadRegistryFile: 'threads.jsonl',
      ledgerFile: 'ledger.jsonl',
      discordReply: {
        enabled: true,
        threadMode: 'fork',
        actionPolicy: 'reversible',
        allowedAuthorIds: ['mini'],
        threadRegistryFile: 'dc.jsonl',
      },
    },
  }));

  assert.throws(() => loadConfig(configFile), /actionPolicy.*bound/);
});

test('共享 App Server 只接受本機 loopback WebSocket', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-shared-config-'));
  const configFile = path.join(dir, 'config.json');
  const base = {
    inboxFile: 'inbox.jsonl',
    codex: {
      threadRegistryFile: 'threads.jsonl',
      ledgerFile: 'ledger.jsonl',
      appServerUrl: 'ws://127.0.0.1:42121',
    },
  };
  fs.writeFileSync(configFile, JSON.stringify(base));
  assert.equal(loadConfig(configFile).codex.appServerUrl, 'ws://127.0.0.1:42121');

  base.codex.appServerUrl = 'ws://example.com:42121';
  fs.writeFileSync(configFile, JSON.stringify(base));
  assert.throws(() => loadConfig(configFile), /loopback/);
});

test('有 appServerUrl 時連共享 WebSocket，沒有才另起 stdio', () => {
  const calls = [];
  const shared = { kind: 'shared' };
  const privateServer = { kind: 'stdio' };

  assert.equal(createCodexTransport({
    appServerUrl: 'ws://127.0.0.1:42121',
    cwd: 'C:/work',
    connect: (url) => { calls.push(['connect', url]); return shared; },
    spawn: () => { calls.push(['spawn']); return privateServer; },
  }), shared);
  assert.equal(createCodexTransport({
    cwd: 'C:/work',
    connect: () => { calls.push(['connect']); return shared; },
    spawn: (options) => { calls.push(['spawn', options.cwd]); return privateServer; },
  }), privateServer);

  assert.deepEqual(calls, [
    ['connect', 'ws://127.0.0.1:42121'],
    ['spawn', 'C:/work'],
  ]);
});

test('家鈴啟動時先連線並 resume 綁定 thread', async () => {
  const calls = [];
  const client = {
    async resumeThread(threadId) {
      calls.push(threadId);
      return { id: threadId, status: { type: 'idle' } };
    },
  };

  const thread = await warmCodexClient({
    binding: { threadId: 'thread-shared' },
    getClient: () => client,
  });

  assert.equal(thread.id, 'thread-shared');
  assert.deepEqual(calls, ['thread-shared']);
  assert.equal(await warmCodexClient({ binding: null, getClient: () => client }), null);
});
