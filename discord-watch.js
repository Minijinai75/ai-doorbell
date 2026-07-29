#!/usr/bin/env node
/**
 * ai-doorbell — Discord Gateway 常駐監聽 daemon
 *
 * 定位：**耳朵＋門鈴，不是嘴**。
 *   收訊息、落地、叫人。回話永遠是那隻 AI 本人的窗，daemon 一個字都不發。
 *
 * 兩個出口，分得很清楚：
 *   stdout  = 門鈴。每則新訊息印一行 JSON，給 Claude Code 的 Monitor 接成通知。
 *   stderr  = 運轉紀錄。連線、重連、錯誤都走這裡，同時寫 log 檔。
 *   → 這條分界是整支程式的地基：任何東西誤印到 stdout，對面就會收到一則假門鈴。
 *
 * 用法：
 *   node discord-watch.js --check              # 只檢查設定與權杖讀不讀得到，不連線
 *   node discord-watch.js                      # 正式跑（預設讀 ./config.json）
 *   node discord-watch.js --config other.json  # 指定別的設定檔（第二隻 AI 就複製一份）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client, Events, GatewayIntentBits, Partials, Status } = require('discord.js');

// ── 參數 ──────────────────────────────────────────────────
const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const cfgIdx = argv.indexOf('--config');
const CONFIG_PATH = path.resolve(cfgIdx >= 0 ? argv[cfgIdx + 1] : path.join(__dirname, 'config.json'));

// ── 台灣時間 ──────────────────────────────────────────────
function twTime(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).slice(2)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function twNow() {
  return twTime(Date.now());
}

// ── 紀錄（絕不走 stdout）──────────────────────────────────
let logStream = null;
function log(level, msg) {
  const line = `${twNow()} [${level}] ${msg}`;
  process.stderr.write(line + '\n');
  if (logStream) logStream.write(line + '\n');
  else bootLog(line); // log 檔還沒開好之前的話也要留得下來
}

/**
 * 開機自啟時沒有人接 stderr（VBS 直接叫 node，刻意不經 cmd 做重導向——
 * cmd /c 加重導向的引號規則會咬到自己，26-07-29 實測：多一組引號整條命令就不跑），
 * 所以啟動早期的錯誤自己寫進固定檔案，否則出事會完全無聲無息。
 */
function bootLog(line) {
  try {
    fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(__dirname, 'logs', 'boot.log'), line + '\n', 'utf8');
  } catch {
    /* 連這都寫不了就算了，不要因為記 log 失敗而讓程式掛掉 */
  }
}

// ── 設定與權杖 ────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`找不到設定檔：${CONFIG_PATH}（可以複製 config.example.json 改）`);
  }
  const conf = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const key of ['identity', 'tokenFile', 'channels', 'inboxFile']) {
    if (!conf[key]) throw new Error(`設定檔缺少必填欄位：${key}`);
  }
  if (!Array.isArray(conf.channels) || conf.channels.length === 0) {
    throw new Error('設定檔的 channels 至少要有一個頻道');
  }
  conf.unhealthyTimeoutMs = conf.unhealthyTimeoutMs || 90000; // 連線壞掉撐多久算死
  conf.silenceTimeoutMs = conf.silenceTimeoutMs || 30 * 60 * 1000; // 全無動靜多久算殭屍
  conf.userAgent = conf.userAgent || 'DiscordBot (https://example.com, 1.0)';
  return conf;
}

/** 這則有沒有 @ 到我身上掛的身分組（例如「AI夥伴」）。取不到就當沒有，不要為了這個炸掉。 */
function mentionsMyRole(client, msg) {
  try {
    const myRoles = msg.guild?.members?.me?.roles?.cache;
    if (!myRoles || !msg.mentions?.roles?.size) return false;
    return msg.mentions.roles.some((r) => myRoles.has(r.id));
  } catch {
    return false;
  }
}

/** 把 discord.js 的連線狀態代碼講成人話。 */
function statusName(s) {
  const names = {
    0: '正常',
    1: '連線中',
    2: '重連中',
    3: '閒置',
    4: '快好了',
    5: '已斷線',
    6: '等伺服器資料',
    7: '認證中',
    8: '接續中',
  };
  return names[s] ?? `未知(${s})`;
}

function loadToken(tokenFile) {
  if (!fs.existsSync(tokenFile)) throw new Error(`找不到權杖檔：${tokenFile}`);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token) throw new Error('權杖檔是空的');
  return token;
}

/** 權杖只以「長度＋頭尾各三碼」示人，值本身永不進畫面、log 或門鈴。 */
function maskToken(token) {
  return `長度 ${token.length}，${token.slice(0, 3)}…${token.slice(-3)}`;
}

function resolveFromConfigDir(p) {
  return path.isAbsolute(p) ? p : path.resolve(path.dirname(CONFIG_PATH), p);
}

// ── 落地與門鈴 ────────────────────────────────────────────
function appendInbox(inboxFile, record) {
  fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
  fs.appendFileSync(inboxFile, JSON.stringify(record) + '\n', 'utf8');
}

/** 門鈴：唯一寫 stdout 的地方。 */
function ringDoorbell(record) {
  process.stdout.write(JSON.stringify(record) + '\n');
}

// ── 主流程 ────────────────────────────────────────────────
function main() {
  let conf;
  try {
    conf = loadConfig();
  } catch (e) {
    const line = `${twNow()} [ERROR] ${e.message}`;
    process.stderr.write(line + '\n');
    bootLog(line);
    process.exit(1);
  }

  const inboxFile = resolveFromConfigDir(conf.inboxFile);
  const logFile = resolveFromConfigDir(conf.logFile || './logs/doorbell.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  logStream = fs.createWriteStream(logFile, { flags: 'a' });

  let token;
  try {
    token = loadToken(resolveFromConfigDir(conf.tokenFile));
  } catch (e) {
    log('ERROR', e.message);
    process.exit(1);
  }

  const watched = new Map(conf.channels.map((c) => [c.id, c.name || c.id]));

  log('INFO', `設定讀好了：身分＝${conf.identity}，監聽 ${watched.size} 個頻道（${[...watched.values()].join('、')}）`);
  log('INFO', `權杖讀到了（${maskToken(token)}）——值不會出現在任何地方`);
  log('INFO', `訊息落地：${inboxFile}`);

  if (CHECK_ONLY) {
    log('INFO', '--check 模式：設定與權杖都沒問題，沒有連線就結束。');
    process.exit(0);
  }

  // ── 死線看門狗：有心跳回應但事件停走，也算死 ──
  let lastEventAt = Date.now();
  const touch = () => {
    lastEventAt = Date.now();
  };

  let client = null;
  let reviving = false;
  let failures = 0;

  /**
   * 有些斷線重連一萬次也沒用——那是設定沒開，不是網路不好。
   * 這種情況要當場說清楚該去點哪個勾，然後收工；一直重試只會把 log 洗版，
   * 讓人以為「它有在努力」，其實它在原地打轉。
   */
  const FATAL = {
    4004: ['權杖不對（或已經被重設過）', '重新產生一把權杖，存回設定檔指定的那個檔案。'],
    4013: ['要求了不存在的 intent', '這是程式的問題，不是設定的問題——找工程師。'],
    4014: [
      '這隻 bot 沒有被允許讀訊息內容',
      '去 Discord 開發者後台 → 你的應用程式 → Bot → 把「MESSAGE CONTENT INTENT」打開 → 存檔，再啟動一次。',
    ],
  };
  /** 登入被拒時只拿得到訊息字串，對照回代碼。 */
  function fatalFromMessage(message = '') {
    const m = String(message).toLowerCase();
    if (m.includes('disallowed intents')) return fatalClose(4014);
    if (m.includes('invalid token') || m.includes('token is invalid')) return fatalClose(4004);
    return false;
  }

  function fatalClose(code) {
    const hit = FATAL[code];
    if (!hit) return false;
    log('ERROR', `連不上：${hit[0]}（代碼 ${code}）`);
    log('ERROR', `怎麼解：${hit[1]}`);
    log('ERROR', '這種問題重試沒有用，先收工，設定好了再啟動。');
    process.exitCode = 1;
    const c = client;
    client = null;
    reviving = true; // 擋掉看門狗
    (c ? c.destroy() : Promise.resolve()).finally(() => process.exit(1));
    return true;
  }

  /**
   * 每次連線都用一顆全新的 client。
   * 為什麼不重用：client.destroy() 之後 discord.js 把它當成「使用者主動關掉」，
   * 再對同一顆 client 呼叫 login() 會卡在重連中途、永遠不 READY（實測踩到，
   * 看門狗每 15 秒判一次死線、每次都接不回來）。換新的才是乾淨路徑。
   */
  function createClient() {
    const c = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      partials: [Partials.Channel],
      // 40333 是 REST 層的指紋攔截，UA 補在這裡。
      // Gateway 的 identify properties 走 @discordjs/ws 的預設（browser/device = '@discordjs/ws'，
      // 不是空值）——discord.js 的 ws 選項不透傳該欄位，要自訂只能改用原生 ws 自己握手。
      // 取捨：Gateway 層目前沒有 40333 案例，不值得為了它放棄 discord.js 的重連與 resume。
      rest: { userAgentAppendix: conf.userAgent },
    });

    c.on(Events.ClientReady, (ready) => {
      touch();
      failures = 0;
      log('INFO', `連上了：${ready.user.tag}（bot id ${ready.user.id}）——開始聽`);
    });

    c.on(Events.MessageCreate, (msg) => {
      touch();
      if (!watched.has(msg.channelId)) return; // 白名單外一律不碰
      // 只濾掉自己說的話（不然會聽見自己的回音）。
      // 別家的 AI 一律要聽得見——聊天頻道有一半的住戶是 AI，把 bot 全濾掉
      // 等於只剩人類在講話，這個群就廢了一半。
      if (c.user && msg.author?.id === c.user.id) return;

      const sentMs = msg.createdTimestamp ?? Date.now();
      const record = {
        // sentAt＝對方按下送出的時間，ts＝我收到的時間。
        // 兩個都要：平常兩者只差不到一秒，斷線補回來的訊息會差很多，
        // 沒有 sentAt 就分不出「剛剛說的」跟「兩小時前說的」。
        sentAt: twTime(sentMs),
        ts: twNow(),
        lagSec: Math.max(0, Math.round((Date.now() - sentMs) / 100) / 10),
        source: 'discord', // git 郵局那邊是 'git'，兩種寫同一個 inbox，靠這欄分辨
        identity: conf.identity,
        channelId: msg.channelId,
        channelName: watched.get(msg.channelId),
        messageId: msg.id,
        authorId: msg.author?.id ?? null,
        authorName: msg.member?.displayName || msg.author?.globalName || msg.author?.username || '（不明）',
        // text＝人看得懂的版本（@某人 會顯示成名字）；content＝原文，要精確引用或回覆時用。
        text: msg.cleanContent ?? msg.content ?? '',
        content: msg.content ?? '',
        // 這則有沒有在點名我。門鈴響了之後，這兩個旗標決定該不該立刻回應。
        // 兩個都要：只看 @ 會漏掉「直接回覆你的訊息」那種——26-07-29 實測，
        // 有人回覆我的訊息說「謝謝你幫我修橋」，mentionedMe 是 false，
        // 但那顯然是在跟我說話。沒有 replyToMe 就會把人家晾在那裡。
        mentionedMe: Boolean(c.user && msg.mentions?.users?.has(c.user.id)),
        replyToMe: Boolean(c.user && msg.mentions?.repliedUser?.id === c.user.id),
        // @「AI夥伴」這類身分組＝一次叫所有 AI，也是在叫你。
        // 實務上撞到的缺口：mentions.users 不含身分組與 everyone，
        // 只看 mentionedMe 會把「全體 AI 集合」漏掉。
        mentionedMyRole: mentionsMyRole(c, msg),
        // 廣播。通常不必回（除非內容真的在找 AI），單獨標出來讓讀的人自己判斷。
        mentionedEveryone: Boolean(msg.mentions?.everyone),
        replyTo: msg.reference?.messageId ?? undefined,
        attachments: msg.attachments?.size ? [...msg.attachments.values()].map((a) => a.url) : undefined,
      };

      try {
        appendInbox(inboxFile, record);
      } catch (e) {
        log('ERROR', `寫 inbox 失敗（訊息不會漏在門鈴，但檔案沒寫成）：${e.message}`);
      }
      ringDoorbell(record);
      log('INFO', `門鈴：${record.channelName} / ${record.authorName}${record.mentionedMe ? '（點名）' : ''}：${record.text.slice(0, 40)}（慢 ${record.lagSec} 秒）`);
    });

    // 這些事件只為了確認「線還活著」與留痕
    c.on(Events.ShardDisconnect, (event, id) => {
      if (fatalClose(event?.code)) return; // 設定問題，重連無用，fatalClose 會收工
      log('WARN', `連線斷了（shard ${id}，代碼 ${event?.code}）——等自動重連`);
    });
    c.on(Events.ShardReconnecting, (id) => {
      touch();
      log('INFO', `重連中（shard ${id}）`);
    });
    c.on(Events.ShardResume, (id, replayed) => {
      touch();
      log('INFO', `重連成功並補回 ${replayed} 則斷線期間的事件（shard ${id}）`);
    });
    c.on(Events.ShardError, (err, id) => {
      log('ERROR', `連線錯誤（shard ${id}）：${err.message}`);
    });
    c.on(Events.Error, (err) => log('ERROR', `客戶端錯誤：${err.message}`));
    c.on(Events.Warn, (info) => log('WARN', info));
    c.on(Events.Raw, touch); // 任何 Gateway 封包都算活著

    return c;
  }

  /** 換一顆新 client 重新接線。退避是為了避免 Discord 那頭有問題時打成連環炮。 */
  async function revive(reason) {
    if (reviving) return;
    reviving = true;
    touch(); // 重連期間不要再判死線

    const backoff = Math.min(30000, 2000 * Math.pow(2, failures));
    failures += 1;
    log('WARN', `${reason}——換一條新線重接（第 ${failures} 次，等 ${Math.round(backoff / 1000)} 秒）`);

    const old = client;
    client = null;
    if (old) {
      try {
        await old.destroy();
      } catch (e) {
        log('ERROR', `關舊線時出錯（不影響重接）：${e.message}`);
      }
    }

    setTimeout(async () => {
      touch();
      client = createClient();
      try {
        await client.login(token);
      } catch (e) {
        if (fatalFromMessage(e.message)) return;
        log('ERROR', `重接失敗：${e.message}`);
        reviving = false;
        revive('重接失敗，再試一次');
        return;
      }
      reviving = false;
    }, backoff);
  }

  // ── 死線判準：「安靜」跟「死掉」是兩回事 ──
  //
  // 26-07-29 踩到的坑：一開始只判「多久沒收到 Gateway 事件」，結果頻道安靜的時候
  // 每 100 秒就把自己踢掉重連一次——因為 discord.js 只把「有人說話」這類事件轉給我，
  // 心跳的一來一往不算。安靜是常態，不是故障。
  //
  // 改成兩條各司其職：
  //   ① 連線狀態不是 Ready 且撐太久 → 真的接不回來了，換線（這條抓斷線）
  //   ② 久到離譜完全沒有任何訊息 → 保險換一次（這條抓「心跳正常但收不到東西」的殭屍）
  //      閾值放很長，因為半夜沒人講話是正常的。
  let unhealthySince = null;

  const watchdog = setInterval(() => {
    if (reviving) return;
    const status = client?.ws?.status;
    const healthy = status === Status.Ready;

    if (healthy) {
      unhealthySince = null;
    } else {
      unhealthySince = unhealthySince || Date.now();
      const down = Date.now() - unhealthySince;
      if (down > conf.unhealthyTimeoutMs) {
        revive(`連線 ${Math.round(down / 1000)} 秒沒回到正常狀態（目前 ${statusName(status)}）`);
        unhealthySince = null;
        return;
      }
    }

    const silence = Date.now() - lastEventAt;
    if (healthy && silence > conf.silenceTimeoutMs) {
      revive(`線看起來是好的，但 ${Math.round(silence / 60000)} 分鐘連一個事件都沒有，保險換一條`);
    }
  }, 15000);
  watchdog.unref?.();

  async function connect() {
    client = createClient();
    try {
      await client.login(token);
    } catch (e) {
      if (fatalFromMessage(e.message)) return;
      log('ERROR', `登入失敗：${e.message}`);
      revive('第一次登入就失敗');
    }
  }

  const bye = (sig) => {
    log('INFO', `收到 ${sig}，收工`);
    clearInterval(watchdog);
    const c = client;
    client = null;
    (c ? c.destroy() : Promise.resolve()).finally(() => process.exit(0));
  };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('uncaughtException', (e) => {
    log('ERROR', `沒接到的例外：${e.stack || e.message}——保持運轉`);
  });
  process.on('unhandledRejection', (e) => {
    log('ERROR', `沒接到的拒絕：${e?.stack || e}——保持運轉`);
  });

  connect();
}

main();
