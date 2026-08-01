'use strict';

class CodexAppServerClient {
  constructor({ transport, clientInfo, requestTimeoutMs = 30000 } = {}) {
    if (!transport) throw new Error('缺少 app-server transport');
    this.transport = transport;
    this.clientInfo = clientInfo || {
      name: 'ai_doorbell',
      title: 'AI Doorbell',
      version: '1.0.0',
    };
    this.requestTimeoutMs = requestTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.initializing = null;
    this.initialized = false;

    this.transport.onLine((message) => this._handleMessage(message));
    this.transport.onExit?.((error) => this._handleExit(error));
  }

  _handleMessage(message) {
    if (message?.id == null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(message.error.message || 'Codex app-server RPC error');
      error.code = message.error.code;
      pending.reject(error);
      return;
    }
    pending.resolve(message.result);
  }

  _handleExit(error) {
    const reason = error instanceof Error ? error : new Error(String(error || 'app-server 已結束'));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.initialized = false;
  }

  _request(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server RPC 逾時：${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.transport.send({ method, id, params });
    return promise;
  }

  async initialize() {
    if (this.initialized) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      await this._request('initialize', { clientInfo: this.clientInfo });
      this.transport.send({ method: 'initialized', params: {} });
      this.initialized = true;
    })();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async resumeThread(threadId) {
    await this.initialize();
    const result = await this._request('thread/resume', { threadId, excludeTurns: false });
    return result.thread;
  }

  async sendTurn(request) {
    await this.initialize();
    return this._request(request.method, request.params);
  }

  close() {
    this.transport.close?.();
  }
}

module.exports = { CodexAppServerClient };
