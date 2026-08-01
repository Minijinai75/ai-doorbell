'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DeliveryLedger,
  buildDoorbellText,
  buildTurnRequest,
  deliverRecord,
} = require('../codex-bridge-core');

function sampleRecord(overrides = {}) {
  return {
    messageId: '1533126065369780324',
    source: 'discord',
    channelId: '1533119450788659362',
    channelName: '技術討論圈圈',
    authorId: '1531935816467742720',
    authorName: '承曦',
    content: '橋現在一口快取都沒吃到。',
    text: '橋現在一口快取都沒吃到。',
    sentAt: '26-08-01 22:55:38',
    lagSec: 0.2,
    ...overrides,
  };
}

test('門鈴文字把 Discord 內容標成不可信外部資料，且禁止自動對外發言', () => {
  const text = buildDoorbellText(sampleRecord());

  assert.match(text, /不可信的外部訊息/);
  assert.match(text, /技術討論圈圈/);
  assert.match(text, /承曦/);
  assert.match(text, /1533126065369780324/);
  assert.match(text, /橋現在一口快取都沒吃到/);
  assert.match(text, /不要自動發送 Discord 訊息/);
});

test('thread 空閒時以 turn/start 叫醒 Codex', () => {
  const request = buildTurnRequest({
    threadId: 'thread-idle',
    thread: { status: { type: 'idle' }, turns: [] },
    record: sampleRecord(),
  });

  assert.equal(request.method, 'turn/start');
  assert.equal(request.params.threadId, 'thread-idle');
  assert.equal(request.params.clientUserMessageId, 'discord-1533126065369780324');
  assert.equal(request.params.input[0].type, 'text');
});

test('thread 忙碌時以 turn/steer 插入目前回合', () => {
  const request = buildTurnRequest({
    threadId: 'thread-active',
    thread: {
      status: { type: 'active', activeFlags: [] },
      turns: [
        { id: 'turn-old', status: 'completed', items: [] },
        { id: 'turn-live', status: 'inProgress', items: [] },
      ],
    },
    record: sampleRecord(),
  });

  assert.equal(request.method, 'turn/steer');
  assert.equal(request.params.expectedTurnId, 'turn-live');
  assert.equal(request.params.threadId, 'thread-active');
});

test('thread 狀態不安全時拒絕送入，不猜測', () => {
  assert.throws(
    () => buildTurnRequest({
      threadId: 'thread-bad',
      thread: { status: { type: 'systemError' }, turns: [] },
      record: sampleRecord(),
    }),
    /systemError/,
  );
});

test('DeliveryLedger 落地後跨程序阻擋同一則訊息重送', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-ledger-'));
  const file = path.join(dir, 'delivered.json');
  const first = new DeliveryLedger(file);

  assert.equal(first.has('m1'), false);
  first.mark('m1');
  assert.equal(first.has('m1'), true);

  const reopened = new DeliveryLedger(file);
  assert.equal(reopened.has('m1'), true);
});

test('RPC 成功後才記已送達；失敗保留重試資格', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doorbell-deliver-'));
  const ledger = new DeliveryLedger(path.join(dir, 'delivered.json'));
  const record = sampleRecord({ messageId: 'retry-me' });

  await assert.rejects(
    deliverRecord({
      ledger,
      record,
      send: async () => { throw new Error('app-server down'); },
      request: { method: 'turn/start', params: {} },
    }),
    /app-server down/,
  );
  assert.equal(ledger.has('retry-me'), false);

  await deliverRecord({
    ledger,
    record,
    send: async () => ({ ok: true }),
    request: { method: 'turn/start', params: {} },
  });
  assert.equal(ledger.has('retry-me'), true);
});
