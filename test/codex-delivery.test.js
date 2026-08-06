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
  const options = {
    allowedChannels: ['allowed'],
    allowedAuthorIds: ['mini'],
    ownAuthorId: 'self',
  };
  assert.equal(shouldDeliverRecord(record({ authorId: 'stranger' }), options), false);
  assert.equal(shouldDeliverRecord(record({ authorId: 'mini' }), options), true);
  assert.equal(shouldDeliverRecord(record({ source: 'git', authorId: 'mini' }), options), false);
  assert.equal(shouldDeliverRecord(record({ channelId: 'elsewhere', authorId: 'mini' }), options), false);
  assert.equal(shouldDeliverRecord(record({ authorId: 'self' }), options), false);
});

test('雙向模式等 turn 完成、回 Discord 成功後才記已送達', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-reply-'));
  const ledger = new DeliveryLedger(path.join(dir, 'ledger.jsonl'));
  const calls = [];
  const client = {
    async resumeThread() {
      return { status: { type: 'idle' }, turns: [] };
    },
    async sendTurn(request) {
      calls.push(['turn', request.params.sandboxPolicy?.type]);
      return { turn: { id: 'turn-new' } };
    },
    async waitForTurnCompleted(options) {
      calls.push(['wait', options.turnId]);
      return {
        threadId: 'thread-live',
        turn: {
          id: 'turn-new',
          status: 'completed',
          items: [
            { type: 'agentMessage', id: 'c1', text: '處理中', phase: 'commentary' },
            { type: 'agentMessage', id: 'f1', text: '好，我看到了。', phase: 'final_answer' },
          ],
        },
      };
    },
  };
  const replySender = async (payload) => {
    calls.push(['discord', payload.replyToMessageId, payload.content]);
  };

  await deliverDiscordRecord({
    client,
    ledger,
    record: record({ authorId: 'mini' }),
    binding: { threadId: 'thread-live' },
    discordReply: { send: replySender, responseTimeoutMs: 100 },
  });

  assert.deepEqual(calls, [
    ['turn', 'readOnly'],
    ['wait', 'turn-new'],
    ['discord', 'm1', '好，我看到了。'],
  ]);
  assert.equal(ledger.has('m1'), true);
});

test('Discord 回覆失敗時不記已送達，保留重試資格', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-reply-fail-'));
  const ledger = new DeliveryLedger(path.join(dir, 'ledger.jsonl'));
  const client = {
    async resumeThread() { return { status: { type: 'idle' }, turns: [] }; },
    async sendTurn() { return { turn: { id: 'turn-new' } }; },
    async waitForTurnCompleted() {
      return {
        turn: {
          id: 'turn-new', status: 'completed',
          items: [{ type: 'agentMessage', id: 'f1', text: '回覆', phase: 'final_answer' }],
        },
      };
    },
  };

  await assert.rejects(
    deliverDiscordRecord({
      client,
      ledger,
      record: record(),
      binding: { threadId: 'thread-live' },
      discordReply: { send: async () => { throw new Error('Discord down'); } },
    }),
    /Discord down/,
  );
  assert.equal(ledger.has('m1'), false);
});

test('沿用原 thread 時不把唯讀 sandbox 寫回主窗', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-bound-'));
  const ledger = new DeliveryLedger(path.join(dir, 'ledger.jsonl'));
  let turnRequest;
  const client = {
    async resumeThread() { return { status: { type: 'idle' }, turns: [] }; },
    async sendTurn(request) {
      turnRequest = request;
      return { turn: { id: 'turn-bound' } };
    },
    async waitForTurnCompleted() {
      return {
        turn: {
          id: 'turn-bound', status: 'completed',
          items: [{ type: 'agentMessage', id: 'f1', text: '我在原窗。', phase: 'final_answer' }],
        },
      };
    },
  };

  await deliverDiscordRecord({
    client,
    ledger,
    record: record(),
    binding: { threadId: 'thread-bound' },
    discordReply: { send: async () => {}, restrictExecution: false },
  });

  assert.equal(turnRequest.params.sandboxPolicy, undefined);
  assert.equal(turnRequest.params.approvalPolicy, undefined);
});

test('DC 實作權會傳進 prompt，仍不覆寫原 thread sandbox', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-actions-'));
  const ledger = new DeliveryLedger(path.join(dir, 'ledger.jsonl'));
  let turnRequest;
  const client = {
    async resumeThread() { return { status: { type: 'idle' }, turns: [] }; },
    async sendTurn(request) {
      turnRequest = request;
      return { turn: { id: 'turn-actions' } };
    },
    async waitForTurnCompleted() {
      return {
        turn: {
          id: 'turn-actions', status: 'completed',
          items: [{ type: 'agentMessage', id: 'f1', text: '完成。', phase: 'final_answer' }],
        },
      };
    },
  };

  await deliverDiscordRecord({
    client,
    ledger,
    record: record(),
    binding: { threadId: 'thread-bound' },
    discordReply: {
      send: async () => {},
      restrictExecution: false,
      allowActions: true,
    },
  });

  assert.match(turnRequest.params.input[0].text, /已驗證的 Mini 本人請求/);
  assert.equal(turnRequest.params.sandboxPolicy, undefined);
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
