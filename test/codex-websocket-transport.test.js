'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  connectCodexAppServer,
} = require('../codex-websocket-transport');

class FakeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  send(value) {
    this.sent.push(value);
  }

  close() {
    this.closed = true;
  }
}

test('WebSocket transport 在連線前排隊，開啟後交換 JSON RPC', () => {
  FakeWebSocket.instances.length = 0;
  const received = [];
  const diagnostics = [];
  const exits = [];
  const transport = connectCodexAppServer('ws://127.0.0.1:42121', {
    WebSocketImpl: FakeWebSocket,
    onDiagnostic: (message) => diagnostics.push(message),
  });
  transport.onLine((message) => received.push(message));
  transport.onExit((error) => exits.push(error.message));

  transport.send({ method: 'initialize', id: 1, params: {} });
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'ws://127.0.0.1:42121');
  assert.deepEqual(socket.sent, []);

  socket.emit('open');
  assert.deepEqual(socket.sent.map(JSON.parse), [
    { method: 'initialize', id: 1, params: {} },
  ]);

  socket.emit('message', Buffer.from(JSON.stringify({ id: 1, result: { ok: true } })));
  socket.emit('message', Buffer.from('not-json'));
  assert.deepEqual(received, [{ id: 1, result: { ok: true } }]);
  assert.match(diagnostics[0], /不是 JSON/);

  socket.emit('close', 1006, Buffer.from('lost'));
  assert.match(exits[0], /1006.*lost/);
});

test('主動 close 不回報成斷線錯誤', () => {
  FakeWebSocket.instances.length = 0;
  const exits = [];
  const transport = connectCodexAppServer('ws://127.0.0.1:42121', {
    WebSocketImpl: FakeWebSocket,
  });
  transport.onExit((error) => exits.push(error));
  const socket = FakeWebSocket.instances[0];

  transport.close();
  socket.emit('close', 1000, Buffer.from(''));

  assert.equal(socket.closed, true);
  assert.deepEqual(exits, []);
});
