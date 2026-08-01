'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { CodexAppServerClient } = require('../codex-app-server-client');
const { spawnCodexAppServer } = require('../codex-stdio-transport');

test('stdio transport 能跟真子程序交換 JSONL，stderr 不會變成假 RPC', async () => {
  const fixture = path.join(__dirname, 'fixtures', 'fake-app-server.js');
  const diagnostics = [];
  const transport = spawnCodexAppServer({
    command: process.execPath,
    args: [fixture],
    onDiagnostic: (line) => diagnostics.push(line),
  });
  const client = new CodexAppServerClient({ transport });

  try {
    const thread = await client.resumeThread('thread-stdio');
    const result = await client.sendTurn({
      method: 'turn/start',
      params: { threadId: thread.id, input: [{ type: 'text', text: 'doorbell' }] },
    });

    assert.equal(thread.id, 'thread-stdio');
    assert.equal(result.ok, true);
    assert.ok(diagnostics.some((line) => line.includes('diagnostic')));
  } finally {
    client.close();
  }
});
