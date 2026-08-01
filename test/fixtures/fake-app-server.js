'use strict';

const readline = require('node:readline');

process.stderr.write('fake app-server diagnostic\n');

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  if (message.method === 'initialize') {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'fake' } })}\n`);
    return;
  }
  if (message.method === 'thread/resume') {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          status: { type: 'idle' },
          turns: [],
        },
      },
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
});
