'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureDiscordReplyThread } = require('../codex-reply-thread');

test('第一次雙向回覆會從綁定主窗 fork 一扇唯讀 DC 專用 thread 並落地', async () => {
  const registryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-dc-thread-')), 'dc.jsonl');
  const calls = [];
  const client = {
    async forkThread(threadId, options) {
      calls.push({ threadId, options });
      return { id: 'thread-dc' };
    },
  };

  const binding = await ensureDiscordReplyThread({
    client,
    registryFile,
    sourceBinding: { threadId: 'thread-ui', cwd: 'C:/workspace' },
  });

  assert.equal(binding.threadId, 'thread-dc');
  assert.equal(binding.sourceThreadId, 'thread-ui');
  assert.deepEqual(calls[0].options, {
    cwd: 'C:/workspace',
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: false,
  });
  assert.match(fs.readFileSync(registryFile, 'utf8'), /thread-dc/);
});

test('已有 DC 專用 thread 時直接沿用，不重複 fork', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-dc-existing-'));
  const registryFile = path.join(dir, 'dc.jsonl');
  fs.writeFileSync(registryFile, `${JSON.stringify({ threadId: 'thread-existing', cwd: 'C:/workspace' })}\n`);
  const client = {
    async forkThread() { throw new Error('不該重複 fork'); },
  };

  const binding = await ensureDiscordReplyThread({
    client,
    registryFile,
    sourceBinding: { threadId: 'thread-ui', cwd: 'C:/workspace' },
  });

  assert.equal(binding.threadId, 'thread-existing');
});
