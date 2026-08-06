'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CodexAppServerClient } = require('../codex-app-server-client');

class FakeTransport {
  constructor(responder) {
    this.responder = responder;
    this.sent = [];
    this.lineHandler = null;
  }

  onLine(handler) {
    this.lineHandler = handler;
  }

  onExit() {}

  send(message) {
    this.sent.push(message);
    const response = this.responder?.(message);
    if (response) queueMicrotask(() => this.lineHandler(response));
  }

  emit(message) {
    queueMicrotask(() => this.lineHandler(message));
  }

  close() {}
}

test('先 initialize／initialized，再送 thread/resume', async () => {
  const transport = new FakeTransport((message) => {
    if (message.method === 'initialize') return { id: message.id, result: { userAgent: 'test' } };
    if (message.method === 'thread/resume') {
      return {
        id: message.id,
        result: { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } },
      };
    }
    return null;
  });
  const client = new CodexAppServerClient({ transport });

  const thread = await client.resumeThread('thread-1');

  assert.deepEqual(transport.sent.map((message) => message.method), [
    'initialize',
    'initialized',
    'thread/resume',
  ]);
  assert.equal(thread.id, 'thread-1');
  assert.equal(transport.sent[2].params.excludeTurns, false);
});

test('RPC error 會拒絕 promise，不把錯誤當成功', async () => {
  const transport = new FakeTransport((message) => {
    if (message.method === 'initialize') return { id: message.id, result: {} };
    if (message.method === 'turn/start') {
      return { id: message.id, error: { code: -32001, message: 'Server overloaded' } };
    }
    return null;
  });
  const client = new CodexAppServerClient({ transport });

  await assert.rejects(
    client.sendTurn({ method: 'turn/start', params: { threadId: 't', input: [] } }),
    /Server overloaded/,
  );
});

test('送 turn request 時保留 caller 建好的 method 與 params', async () => {
  const transport = new FakeTransport((message) => {
    if (message.method === 'initialize') return { id: message.id, result: {} };
    if (message.method === 'turn/steer') {
      return { id: message.id, result: { turnId: 'turn-live' } };
    }
    return null;
  });
  const client = new CodexAppServerClient({ transport });
  const request = {
    method: 'turn/steer',
    params: {
      threadId: 'thread-live',
      expectedTurnId: 'turn-live',
      input: [{ type: 'text', text: 'doorbell' }],
    },
  };

  await client.sendTurn(request);

  assert.equal(transport.sent[2].method, 'turn/steer');
  assert.deepEqual(transport.sent[2].params, request.params);
});

test('app-server 沒回應時逾時拒絕，不讓門鈴永久卡死', async () => {
  const transport = new FakeTransport(() => null);
  const client = new CodexAppServerClient({ transport, requestTimeoutMs: 10 });

  await assert.rejects(client.initialize(), /逾時/);
});

test('能等指定 thread 與 turn 完成，並保留先抵達的完成通知', async () => {
  const transport = new FakeTransport(() => null);
  const client = new CodexAppServerClient({ transport, requestTimeoutMs: 50 });
  const completed = {
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'a1', text: '收到，我在。', phase: 'final_answer' }],
      },
    },
  };

  transport.emit(completed);
  const result = await client.waitForTurnCompleted({
    threadId: 'thread-1',
    turnId: 'turn-1',
    timeoutMs: 50,
  });

  assert.equal(result.turn.id, 'turn-1');
  assert.equal(result.turn.items[0].text, '收到，我在。');
});

test('等待 turn 完成時不會誤收別的 thread 或 turn', async () => {
  const transport = new FakeTransport(() => null);
  const client = new CodexAppServerClient({ transport, requestTimeoutMs: 50 });
  const waiting = client.waitForTurnCompleted({
    threadId: 'thread-right',
    turnId: 'turn-right',
    timeoutMs: 50,
  });

  transport.emit({
    method: 'turn/completed',
    params: { threadId: 'thread-wrong', turn: { id: 'turn-right', status: 'completed', items: [] } },
  });
  transport.emit({
    method: 'turn/completed',
    params: { threadId: 'thread-right', turn: { id: 'turn-wrong', status: 'completed', items: [] } },
  });
  transport.emit({
    method: 'turn/completed',
    params: { threadId: 'thread-right', turn: { id: 'turn-right', status: 'completed', items: [] } },
  });

  const result = await waiting;
  assert.equal(result.turn.id, 'turn-right');
});

test('fork thread 時保留唯讀與 approval 設定', async () => {
  const transport = new FakeTransport((message) => {
    if (message.method === 'initialize') return { id: message.id, result: {} };
    if (message.method === 'thread/fork') {
      return { id: message.id, result: { thread: { id: 'thread-dc' } } };
    }
    return null;
  });
  const client = new CodexAppServerClient({ transport });

  const thread = await client.forkThread('thread-ui', {
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: false,
  });

  assert.equal(thread.id, 'thread-dc');
  assert.deepEqual(transport.sent[2].params, {
    threadId: 'thread-ui',
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: false,
  });
});
