'use strict';

const fs = require('node:fs');
const path = require('node:path');

function splitDiscordContent(content, maxLength = 1900) {
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 2000) {
    throw new Error('Discord 分段長度必須介於 1 到 2000');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Discord 回覆是空的，沒有送出');
  }
  const chunks = [];
  let rest = content;
  while (rest.length > maxLength) {
    let cut = Math.max(rest.lastIndexOf('\n', maxLength), rest.lastIndexOf(' ', maxLength));
    if (cut < Math.floor(maxLength / 2)) cut = maxLength;
    else cut += 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function createDiscordSender({
  token,
  userAgent = 'DiscordBot (https://example.com, 1.0)',
  fetchImpl = globalThis.fetch,
  maxLength = 1900,
} = {}) {
  if (!token) throw new Error('缺少 Discord bot token');
  if (typeof fetchImpl !== 'function') throw new Error('環境沒有可用的 fetch');

  return {
    async send({ channelId, replyToMessageId, content }) {
      if (!channelId) throw new Error('Discord 回覆缺少 channelId');
      const chunks = splitDiscordContent(content, maxLength);
      const sent = [];
      let referenceId = replyToMessageId || null;
      for (const chunk of chunks) {
        const body = {
          content: chunk,
          allowed_mentions: { parse: [] },
        };
        if (referenceId) {
          body.message_reference = {
            message_id: referenceId,
            channel_id: channelId,
            fail_if_not_exists: false,
          };
        }
        const response = await fetchImpl(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bot ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': userAgent,
            },
            body: JSON.stringify(body),
          },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            `Discord 回覆失敗（HTTP ${response.status}，code ${data.code ?? '?'}）：${data.message || ''}`,
          );
        }
        sent.push(data);
        referenceId = data.id || referenceId;
      }
      return sent;
    },
  };
}

function createDiscordSenderFromConfig(config, configPath, options = {}) {
  if (!config?.tokenFile) throw new Error('設定檔缺少 tokenFile');
  const tokenFile = path.isAbsolute(config.tokenFile)
    ? config.tokenFile
    : path.resolve(path.dirname(configPath), config.tokenFile);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  return createDiscordSender({
    token,
    userAgent: config.userAgent,
    ...options,
  });
}

module.exports = {
  createDiscordSender,
  createDiscordSenderFromConfig,
  splitDiscordContent,
};
