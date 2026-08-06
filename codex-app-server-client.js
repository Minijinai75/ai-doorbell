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
    this.turnWaiters = new Map();
    this.completedTurns = new Map();
    this.initializing = null;
    this.initialized = false;

    this.transport.onLine((message) => this._handleMessage(message));
    this.transport.onExit?.((error) => this._handleExit(error));
  }

  _handleMessage(message) {
    if (message?.id == null) {
      this._handleNotification(message);
      return;
    }
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

  _turnKey(threadId, turnId) {
    return `${threadId}:${turnId}`;
  }

  _handleNotification(message) {
    if (message?.method !== 'turn/completed') return;
    const threadId = message.params?.threadId;
    const turnId = message.params?.turn?.id;
    if (!threadId || !turnId) return;
    const key = this._turnKey(threadId, turnId);
    const waiter = this.turnWaiters.get(key);
    if (waiter) {
      this.turnWaiters.delete(key);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
      return;
    }
    this.completedTurns.set(key, message.params);
    if (this.completedTurns.size > 100) {
      this.completedTurns.delete(this.completedTurns.keys().next().value);
    }
  }

  _handleExit(error) {
    const reason = error instanceof Error ? error : new Error(String(error || 'app-server 已結束'));
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.turnWaiters.clear();
    this.completedTurns.clear();
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

  async forkThread(threadId, options = {}) {
    await this.initialize();
    const result = await this._request('thread/fork', { threadId, ...options });
    return result.thread;
  }

  waitForTurnCompleted({ threadId, turnId, timeoutMs = 600000 } = {}) {
    if (!threadId || !turnId) throw new Error('等待 turn 完成時缺少 threadId 或 turnId');
    const key = this._turnKey(threadId, turnId);
    const completed = this.completedTurns.get(key);
    if (completed) {
      this.completedTurns.delete(key);
      return Promise.resolve(completed);
    }
    if (this.turnWaiters.has(key)) throw new Error(`已經在等待 Codex turn：${turnId}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.turnWaiters.delete(key);
        reject(new Error(`等待 Codex turn 完成逾時：${turnId}`));
      }, timeoutMs);
      this.turnWaiters.set(key, { resolve, reject, timer });
    });
  }

  close() {
    this.transport.close?.();
  }
}

module.exports = { CodexAppServerClient };
