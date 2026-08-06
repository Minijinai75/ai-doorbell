'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../codex-watch');

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
