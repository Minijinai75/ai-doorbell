#!/usr/bin/env node
/**
 * 說話 — 給 AI 本人用的嘴
 *
 * ⚠️ 這支跟耳朵（discord-watch.js）是分開的兩件事，而且**永遠不會被耳朵呼叫**。
 *    一般手動說話仍由 AI 本人在自己的窗裡按下這支；Codex 雙向白名單模式另走
 *    discord-send.js，不會偷偷呼叫本 CLI。
 *    理由：語體與身分是本人的，機器代答就是冒名。
 *
 * 用法（訊息一律走檔案，不走命令列——中文過 shell 會被編碼吃掉）：
 *   node say.js --config config-第二個.json --file 訊息.txt
 *   node say.js --config config-第二個.json --file 訊息.txt --dry-run   # 只印不送
 *   node say.js ... --reply <訊息id>                                  # 回覆某則
 */

'use strict';

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const DRY = argv.includes('--dry-run');

const CONFIG_PATH = path.resolve(arg('--config', 'config.json'));
const FILE = arg('--file');
const REPLY_TO = arg('--reply');
const CHANNEL = arg('--channel');

if (!FILE) {
  console.error('要說什麼？請用 --file 指定一個 UTF-8 純文字檔。');
  process.exit(1);
}

const conf = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const tokenFile = path.isAbsolute(conf.tokenFile)
  ? conf.tokenFile
  : path.resolve(path.dirname(CONFIG_PATH), conf.tokenFile);
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const channelId = CHANNEL || conf.channels[0].id;
const content = fs.readFileSync(path.resolve(FILE), 'utf8').trim();

if (!content) {
  console.error('訊息是空的，沒有送出。');
  process.exit(1);
}
if (content.length > 2000) {
  console.error(`Discord 單則上限 2000 字，這則 ${content.length} 字——請自己分段，我不擅自替你斷句。`);
  process.exit(1);
}

console.log(`以「${conf.identity}」的身分，發到 ${conf.channels.find((c) => c.id === channelId)?.name || channelId}：`);
console.log('─'.repeat(40));
console.log(content);
console.log('─'.repeat(40));

if (DRY) {
  console.log('（--dry-run：沒有真的送出。）');
  process.exit(0);
}

const body = { content };
if (REPLY_TO) body.message_reference = { message_id: REPLY_TO };

fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
  method: 'POST',
  headers: {
    Authorization: `Bot ${token}`,
    'Content-Type': 'application/json',
    // 缺這個會撞 40333（偽裝成 403 的指紋攔截）
    'User-Agent': conf.userAgent || 'DiscordBot (https://example.com, 1.0)',
  },
  body: JSON.stringify(body),
})
  .then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`✗ 沒送出去（HTTP ${res.status}，code ${data.code ?? '?'}）：${data.message ?? ''}`);
      if (data.code === 40333) console.error('  → 缺 User-Agent，補上就好。');
      if (data.code === 50013 || data.code === 50001) console.error('  → 這是真的權限不足，要請你家人類對身分組。');
      process.exit(1);
    }
    console.log(`✓ 說出去了（訊息 id ${data.id}）`);
  })
  .catch((e) => {
    console.error(`✗ 送不出去：${e.message}`);
    process.exit(1);
  });
