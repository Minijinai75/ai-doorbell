'use strict';

const fs = require('node:fs');
const path = require('node:path');

function appendThreadBinding(file, { threadId, cwd } = {}) {
  if (!threadId) throw new Error('缺少 CODEX_THREAD_ID，請在要接門鈴的 Codex 窗裡執行 attach');
  const target = path.resolve(file);
  const entry = {
    threadId,
    cwd: cwd || process.cwd(),
    attachedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

function readLatestThreadBinding(file) {
  const target = path.resolve(file);
  if (!fs.existsSync(target)) return null;
  const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]) continue;
    try {
      const entry = JSON.parse(lines[index]);
      if (entry?.threadId) return entry;
    } catch {
      // 壞行原樣保留供鑑識，往前找最後一筆有效綁定。
    }
  }
  return null;
}

class JsonlFollower {
  constructor(file, { replayExisting = false, onDiagnostic = () => {} } = {}) {
    this.file = path.resolve(file);
    this.onDiagnostic = onDiagnostic;
    this.offset = 0;
    this.buffer = '';
    if (!replayExisting && fs.existsSync(this.file)) {
      this.offset = fs.statSync(this.file).size;
    }
  }

  poll() {
    if (!fs.existsSync(this.file)) return [];
    const size = fs.statSync(this.file).size;
    if (size < this.offset) {
      this.offset = 0;
      this.buffer = '';
    }
    if (size === this.offset) return [];

    const length = size - this.offset;
    const bytes = Buffer.alloc(length);
    const handle = fs.openSync(this.file, 'r');
    try {
      fs.readSync(handle, bytes, 0, length, this.offset);
    } finally {
      fs.closeSync(handle);
    }
    this.offset = size;
    this.buffer += bytes.toString('utf8');

    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || '';
    const records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch (error) {
        this.onDiagnostic(`inbox 有一行不是 JSON，已略過：${error.message}`);
      }
    }
    return records;
  }
}

module.exports = {
  JsonlFollower,
  appendThreadBinding,
  readLatestThreadBinding,
};
