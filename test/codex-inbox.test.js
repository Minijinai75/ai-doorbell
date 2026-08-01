'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  JsonlFollower,
  appendThreadBinding,
  readLatestThreadBinding,
} = require('../codex-inbox');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('thread 綁定檔只追加，並讀最後一筆有效綁定', () => {
  const file = path.join(tempDir('doorbell-binding-'), 'thread.jsonl');

  appendThreadBinding(file, { threadId: 'thread-one', cwd: 'C:/one' });
  fs.appendFileSync(file, '{broken json}\n', 'utf8');
  appendThreadBinding(file, { threadId: 'thread-two', cwd: 'C:/two' });

  assert.equal(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).length, 3);
  const latest = readLatestThreadBinding(file);
  assert.equal(latest.threadId, 'thread-two');
  assert.equal(latest.cwd, 'C:/two');
  assert.match(latest.attachedAt, /T/);
});

test('inbox follower 從啟動時 EOF 開始，不重播舊訊息', () => {
  const file = path.join(tempDir('doorbell-follow-'), 'inbox.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ messageId: 'old' })}\n`, 'utf8');
  const follower = new JsonlFollower(file);

  assert.deepEqual(follower.poll(), []);
  fs.appendFileSync(file, `${JSON.stringify({ messageId: 'new' })}\n`, 'utf8');
  assert.deepEqual(follower.poll().map((x) => x.messageId), ['new']);
});

test('inbox follower 等完整換行才交件，壞行不拖垮後續訊息', () => {
  const file = path.join(tempDir('doorbell-partial-'), 'inbox.jsonl');
  fs.writeFileSync(file, '', 'utf8');
  const diagnostics = [];
  const follower = new JsonlFollower(file, { onDiagnostic: (line) => diagnostics.push(line) });

  fs.appendFileSync(file, '{"messageId":"partial"', 'utf8');
  assert.deepEqual(follower.poll(), []);
  fs.appendFileSync(file, '}\nnot-json\n{"messageId":"after"}\n', 'utf8');

  assert.deepEqual(follower.poll().map((x) => x.messageId), ['partial', 'after']);
  assert.equal(diagnostics.length, 1);
});
