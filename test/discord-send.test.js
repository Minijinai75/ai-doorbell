'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDiscordSender, splitDiscordContent } = require('../discord-send');

test('Discord 長訊息會安全切成不超過 2000 字的段落', () => {
  const chunks = splitDiscordContent(`第一段\n\n${'字'.repeat(2100)}`, 1900);

  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 1900));
  assert.equal(chunks.join(''), `第一段\n\n${'字'.repeat(2100)}`);
});

test('回覆 Discord 時禁用 mentions，第一段引用原訊息，後段接續上一段', async () => {
  const requests = [];
  const sender = createDiscordSender({
    token: 'secret',
    userAgent: 'DiscordBot (test, 1.0)',
    maxLength: 10,
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        async json() { return { id: `bot-${requests.length}` }; },
      };
    },
  });

  await sender.send({
    channelId: 'channel-1',
    replyToMessageId: 'user-1',
    content: '1234567890abcdefghij',
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body.allowed_mentions, { parse: [] });
  assert.equal(requests[0].body.message_reference.message_id, 'user-1');
  assert.equal(requests[1].body.message_reference.message_id, 'bot-1');
  assert.equal(requests[0].options.headers.Authorization, 'Bot secret');
});
