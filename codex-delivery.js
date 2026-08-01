'use strict';

const {
  buildTurnRequest,
  deliverRecord,
} = require('./codex-bridge-core');

function shouldDeliverRecord(record, { allowedChannels = [], ownAuthorId } = {}) {
  if (record?.source !== 'discord') return false;
  if (!record.messageId && !record.id) return false;
  if (allowedChannels.length && !allowedChannels.includes(record.channelId)) return false;
  if (ownAuthorId && record.authorId === ownAuthorId) return false;
  return true;
}

async function deliverDiscordRecord({ client, ledger, record, binding }) {
  if (!binding?.threadId) throw new Error('還沒有 Codex thread 綁定；先執行 npm run codex:attach');
  const thread = await client.resumeThread(binding.threadId);
  const request = buildTurnRequest({
    threadId: binding.threadId,
    thread,
    record,
  });
  return deliverRecord({
    ledger,
    record,
    request,
    send: (turnRequest) => client.sendTurn(turnRequest),
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliverWithRetry({
  operation,
  retryDelayMs = 3000,
  maxAttempts = Number.POSITIVE_INFINITY,
  sleep = defaultSleep,
  onRetry = () => {},
}) {
  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      return await operation(attempts);
    } catch (error) {
      if (attempts >= maxAttempts) throw error;
      onRetry(error, attempts);
      await sleep(retryDelayMs);
    }
  }
  throw new Error('Codex 門鈴重試次數已用完');
}

module.exports = {
  deliverDiscordRecord,
  deliverWithRetry,
  shouldDeliverRecord,
};
