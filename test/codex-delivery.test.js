'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DeliveryLedger } = require('../codex-bridge-core');
const {
  deliverDiscordRecord,
  deliverWithRetry,
  shouldDeliverRecord,
} = require('../codex-delivery');

function record(overrides = {}) {
  return {
    source: 'discord',
    messageId: 'm1',
    channelId: 'allowed',
    channelName: '技術討論圈圈',
    authorName: '承曦',
    text: 'ping',
    ...overrides,
  };
}

test('只送 Discord 白名單頻道，自己 bot 的回音也不送', () => {
  const options = { allowedChannels: ['allowed'], ownAuthorId: 'self' };
  assert.equal(shouldDeliverRecord(record(), options), true);
  assert.equal(shouldDeliverRecord(record({ source: 'git' }), options), false);
  assert.equal(shouldDeliverRecord(record({ channelId: 'elsewhere' }), options), false);
  assert.equal(shouldDeliverRecord(record({ authorId: 'self' }), options), false);
});

test('讀目前綁定、resume thread 後才依狀態送 turn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-delivery-'));
  const ledger = new DeliveryLedger(path.join(dir, 'ledger.jsonl'));
  const calls = [];
  const client = {
    async resumeThread(threadId) {
      calls.push(['resume', threadId]);
      return { status: { type: 'idle' }, turns: [] };
    },
    async sendTurn(request) {
      calls.push(['send', request.method]);
      return { turn: { id: 'turn-new' } };
    },
  };

  await deliverDiscordRecord({
    client,
    ledger,
    record: record(),
    binding: { threadId: 'thread-live' },
  });

  assert.deepEqual(calls, [['resume', 'thread-live'], ['send', 'turn/start']]);
  assert.equal(ledger.has('m1'), true);
});

test('忙碌／鎖定錯誤會排隊重試，成功前不記已送達', async () => {
  let attempts = 0;
  const sleeps = [];
  const result = await deliverWithRetry({
    operation: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('thread is active elsewhere');
      return 'delivered';
    },
    retryDelayMs: 25,
    maxAttempts: 3,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.equal(result, 'delivered');
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [25, 25]);
});
