'use strict';

const {
  buildTurnRequest,
  deliverRecord,
} = require('./codex-bridge-core');

function shouldDeliverRecord(record, {
  allowedChannels = [],
  allowedAuthorIds = [],
  ownAuthorId,
} = {}) {
  if (record?.source !== 'discord') return false;
  if (!record.messageId && !record.id) return false;
  if (allowedChannels.length && !allowedChannels.includes(record.channelId)) return false;
  if (allowedAuthorIds.length && !allowedAuthorIds.includes(record.authorId)) return false;
  if (ownAuthorId && record.authorId === ownAuthorId) return false;
  return true;
}

function finalAgentText(turn) {
  const messages = (turn?.items || []).filter((item) => (
    item?.type === 'agentMessage' && item.phase !== 'commentary' && item.text?.trim()
  ));
  const final = [...messages].reverse().find((item) => item.phase === 'final_answer')
    || messages[messages.length - 1];
  return final?.text?.trim() || '';
}

function turnIdFromResult(result) {
  return result?.turn?.id || result?.turnId || null;
}

async function deliverDiscordRecord({
  client,
  ledger,
  record,
  binding,
  discordReply,
}) {
  if (!binding?.threadId) throw new Error('還沒有 Codex thread 綁定；先執行 npm run codex:attach');
  const messageId = record.messageId || record.id;
  if (ledger.has(messageId)) return { skipped: true };
  const thread = await client.resumeThread(binding.threadId);
  const request = buildTurnRequest({
    threadId: binding.threadId,
    thread,
    record,
    replyToDiscord: Boolean(discordReply),
    restrictExecution: discordReply?.restrictExecution !== false,
    allowActions: discordReply?.allowActions === true,
  });
  if (discordReply) {
    const result = await client.sendTurn(request);
    const turnId = turnIdFromResult(result);
    if (!turnId) throw new Error('Codex app-server 沒有回傳 turnId');
    const completed = await client.waitForTurnCompleted({
      threadId: binding.threadId,
      turnId,
      timeoutMs: discordReply.responseTimeoutMs,
    });
    if (completed.turn?.status !== 'completed') {
      const detail = completed.turn?.error?.message || completed.turn?.status || 'unknown';
      throw new Error(`Codex 回合沒有完成：${detail}`);
    }
    const content = finalAgentText(completed.turn);
    if (!content) throw new Error('Codex 回合完成，但找不到可回覆 Discord 的 final 文字');
    await discordReply.send({
      channelId: record.channelId,
      replyToMessageId: messageId,
      content,
    });
    ledger.mark(messageId);
    return { skipped: false, result, completed, content };
  }
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
  finalAgentText,
  shouldDeliverRecord,
  turnIdFromResult,
};
