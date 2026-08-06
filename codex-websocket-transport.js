'use strict';

const WebSocket = require('ws');

function connectCodexAppServer(url, options = {}) {
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const onDiagnostic = options.onDiagnostic || (() => {});
  const socket = new WebSocketImpl(url);
  const queued = [];
  let lineHandler = () => {};
  let exitHandler = () => {};
  let opened = false;
  let closed = false;
  let exitError = null;

  function notifyExit(error) {
    if (closed || exitError) return;
    exitError = error instanceof Error ? error : new Error(String(error));
    exitHandler(exitError);
  }

  socket.on('open', () => {
    if (closed) return;
    opened = true;
    while (queued.length) socket.send(queued.shift());
  });
  socket.on('message', (data) => {
    try {
      lineHandler(JSON.parse(data.toString()));
    } catch (error) {
      onDiagnostic(`app-server WebSocket 訊息不是 JSON：${error.message}`);
    }
  });
  socket.on('error', (error) => notifyExit(error));
  socket.on('close', (code, reason) => {
    if (closed) return;
    const detail = reason?.toString() || 'no reason';
    notifyExit(new Error(`Codex app-server WebSocket 已斷線（code=${code}, reason=${detail}）`));
  });

  return {
    onLine(handler) {
      lineHandler = handler;
    },
    onExit(handler) {
      exitHandler = handler;
      if (exitError) queueMicrotask(() => exitHandler(exitError));
    },
    send(message) {
      if (closed || exitError) throw new Error('Codex app-server WebSocket transport 已關閉');
      const encoded = JSON.stringify(message);
      if (opened) socket.send(encoded);
      else queued.push(encoded);
    },
    close() {
      if (closed) return;
      closed = true;
      queued.length = 0;
      socket.close();
    },
  };
}

module.exports = { connectCodexAppServer };
