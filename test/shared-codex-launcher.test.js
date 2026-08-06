'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('共享 Codex 啟動器從設定讀 endpoint 與精確綁定 thread', {
  skip: process.platform !== 'win32',
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-launcher-'));
  const registry = path.join(dir, 'threads.jsonl');
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(registry, [
    JSON.stringify({ threadId: 'thread-old' }),
    'broken',
    JSON.stringify({ threadId: 'thread-shared' }),
  ].join('\n'));
  fs.writeFileSync(config, JSON.stringify({
    identity: '景和',
    codex: {
      appServerUrl: 'ws://127.0.0.1:42121',
      threadRegistryFile: registry,
    },
  }));

  const script = path.join(__dirname, '..', '啟停', '開啟共享Codex.ps1');
  const result = spawnSync('pwsh.exe', [
    '-NoProfile', '-File', script,
    '-Config', config,
    '-WhatIf',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ws:\/\/127\.0\.0\.1:42121/);
  assert.match(result.stdout, /thread-shared/);
  assert.match(result.stdout, /codex resume --remote/);
});

test('公開設定範例明列共享 App Server endpoint', () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  assert.equal(config.codex.appServerUrl, 'ws://127.0.0.1:42121');
});
