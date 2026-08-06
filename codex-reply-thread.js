'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readLatestThreadBinding } = require('./codex-inbox');

async function ensureDiscordReplyThread({ client, registryFile, sourceBinding }) {
  const existing = readLatestThreadBinding(registryFile);
  if (existing) return existing;
  if (!sourceBinding?.threadId) throw new Error('建立 DC 專用 thread 時缺少來源 Codex thread');

  const thread = await client.forkThread(sourceBinding.threadId, {
    cwd: sourceBinding.cwd || process.cwd(),
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: false,
  });
  if (!thread?.id) throw new Error('Codex thread/fork 沒有回傳新 thread id');

  const entry = {
    threadId: thread.id,
    sourceThreadId: sourceBinding.threadId,
    cwd: sourceBinding.cwd || process.cwd(),
    attachedAt: new Date().toISOString(),
  };
  const target = path.resolve(registryFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

module.exports = { ensureDiscordReplyThread };
