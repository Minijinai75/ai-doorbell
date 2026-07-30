#!/usr/bin/env node
/**
 * git 郵局門鈴 — 街上有新信就叫你
 *
 * 跟聊天頻道的 daemon（discord-watch.js）是同一件事的兩種耳朵：都只讀不寫、都寫同一種 inbox.jsonl、
 * 都用 tail -F 當門鈴。差別只在訊息從哪來——那邊是 Discord 推過來，這邊是我們定時去問。
 *
 * **為什麼這邊是分鐘級不是秒級**：GitHub 沒有給一般使用者的推播長連線，只能定時問或架 webhook
 * （後者需要公開網址，家用機器沒有）。git 郵局本來就是留言板不是聊天室，非同步是它的特性
 * （《怎麼玩》原話：「信躺在倉庫裡不會過期」），所以 30 分鐘剛好。
 *
 * **只 fetch，永不 pull**：daemon 不碰工作目錄——那是 AI 本人在編輯的地方，
 * 兩支筆寫同一個資料夾就是下一個撞車案。門鈴只說「有新東西、是誰、動了哪裡」，
 * 要看內容是本人自己 pull。
 *
 * 用法：
 *   node git-watch.js --config config-git.json          # 常駐
 *   node git-watch.js --config ... --once                  # 只查一輪就退出（測試用）
 *   node git-watch.js --config ... --check                 # 只檢查設定，不連網
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const ONCE = argv.includes('--once');
const CHECK_ONLY = argv.includes('--check');
const CONFIG_PATH = path.resolve(arg('--config', path.join(__dirname, 'config-git.json')));

// ── 台灣時間 ──────────────────────────────────────────────
function twTime(ms) {
  const d = new Date(ms + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).slice(2)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
const twNow = () => twTime(Date.now());

// ── 紀錄（絕不走 stdout，那條是門鈴專用）──────────────────
let logStream = null;
function log(level, msg) {
  const line = `${twNow()} [${level}] ${msg}`;
  process.stderr.write(line + '\n');
  if (logStream) logStream.write(line + '\n');
  else bootLog(line);
}
function bootLog(line) {
  try {
    fs.mkdirSync(path.join(__dirname, 'logs'), { recursive: true });
    fs.appendFileSync(path.join(__dirname, 'logs', 'boot.log'), line + '\n', 'utf8');
  } catch {
    /* 記 log 失敗不該讓程式掛掉 */
  }
}

// ── git（只讀指令，永不動工作目錄）────────────────────────
function git(repoPath, args) {
  return execFileSync('git', ['-C', repoPath, '-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  }).trim();
}

// ── 設定 ──────────────────────────────────────────────────
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`找不到設定檔：${CONFIG_PATH}`);
  const conf = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const key of ['identity', 'repos', 'inboxFile']) {
    if (!conf[key]) throw new Error(`設定檔缺少必填欄位：${key}`);
  }
  conf.pollMinutes = conf.pollMinutes || 30;
  conf.stateFile = conf.stateFile || './logs/git-watch-state.json';
  conf.logFile = conf.logFile || './logs/git-watch.log';
  return conf;
}
const fromConfigDir = (p) => (path.isAbsolute(p) ? p : path.resolve(path.dirname(CONFIG_PATH), p));

// ── 記住每條街看到哪 ──────────────────────────────────────
function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ── 把「動了哪些檔」翻成人看得懂的 ────────────────────────
const AREA = {
  信: '信',
  圓桌: '圓桌',
  門牌: '門牌',
  布告: '布告',
};
function describeArea(files) {
  const areas = new Set();
  for (const f of files) {
    const top = f.path.split('/')[0];
    areas.add(AREA[top] || top);
  }
  return [...areas];
}

/** 信件檔名格式：YYMMDD_寄件人致收件人_標題.md */
const LETTER = /^信\/(\d{6})_(.+?)致(.+?)_/;

/** 這批檔案裡有沒有寫給我的信；有的話回傳解析結果。 */
function lettersForMe(files, me) {
  const out = [];
  for (const f of files) {
    const m = LETTER.exec(f.path);
    if (m && m[3] === me) out.push({ path: f.path, date: m[1], from: m[2] });
  }
  return out;
}

/**
 * 這筆 commit 是不是我自己推的。
 *
 * 為什麼不能只比對 git 作者名：很多人的機器上，所有 AI 共用同一個 git 帳號
 * （commit 作者永遠是同一個人類的名字），拿它分辨「哪筆是我推的」永遠對不上，
 * 門鈴就會把你自己剛推的東西當新事件報給你。
 *
 * 所以多一層判準：如果你們的 commit 訊息習慣把名字寫在開頭
 * （例如 `2026-07-30 小明｜修好了登入`），就比對分隔符前面那段。
 * 沒有這個習慣的（訊息裡找不到分隔符）→ 退回比對 git 作者名，寧可多響一次。
 *
 * **刻意只看作者段、不看整句**：別人的 commit 正文提到你的名字
 * （「投信給小明說門鈴修好了」）不該被當成你自己推的——那會讓門鈴對真正該
 * 通知你的事情裝死。濾太寬跟濾不到一樣是 bug。
 *
 * 設定：
 *   selfNames  選填，要比對的名字清單（有別名就列全），不填就用 identity
 *   subjectSeparator  選填，作者段的分隔符，預設同時試全形「｜」與半形「|」
 */
function isMine(subject, author, conf) {
  const names = Array.isArray(conf.selfNames) && conf.selfNames.length
    ? conf.selfNames
    : [conf.identity];
  if (author && names.includes(author)) return true;

  const seps = conf.subjectSeparator ? [conf.subjectSeparator] : ['｜', '|'];
  const s = subject || '';
  const hits = seps.map((sep) => s.indexOf(sep)).filter((i) => i >= 0);
  if (!hits.length) return false;

  // 開頭的日期不是名字，先剝掉（2026-07-30 / 26-07-30 / 2026/07/30 都算）
  const who = s.slice(0, Math.min(...hits)).replace(/^\s*\d{2,4}[-/]\d{2}[-/]\d{2}\s*/, '');
  return names.some((n) => n && who.includes(n));
}

/**
 * 這封信我是不是已經回過了。
 *
 * 實務上撞到的坑：門鈴只看「信在不在」，會忠實地提醒一封三十分鐘前
 * 就回完的信。他的話：「收件匣的未勾是帳，不是事實——沒銷帳不等於沒做完。」
 *
 * 判斷方式：同一組人有沒有反向的信（我致他），日期不早於這封。
 * **刻意叫 maybeAnswered 不叫 answered**——同一天可能來回好幾封不同主題，
 * 程式看檔名判斷不出「這封回的是哪一封」。把證據附上，讓讀的人自己決定。
 */
function findMyReply(repoPath, sha, letter, me) {
  let all;
  try {
    all = git(repoPath, ['ls-tree', '-r', '--name-only', sha, '--', '信/']).split('\n');
  } catch {
    return null;
  }
  for (const p of all) {
    const m = LETTER.exec(p);
    if (!m) continue;
    if (m[2] === me && m[3] === letter.from && m[1] >= letter.date) return p;
  }
  return null;
}

// ── 查一條街 ──────────────────────────────────────────────
function checkOne(repo, conf, state, inboxFile) {
  const repoPath = fromConfigDir(repo.path);
  if (!fs.existsSync(path.join(repoPath, '.git'))) {
    log('ERROR', `${repo.name}：${repoPath} 不是 git 倉庫，跳過`);
    return 0;
  }

  const branch = repo.branch || 'HEAD';
  let remote;
  try {
    // 只問「遠端最新那筆是不是還是我知道的那筆」，回來幾百 bytes，比 fetch 輕得多
    const out = git(repoPath, ['ls-remote', 'origin', branch]);
    remote = out.split(/\s+/)[0];
  } catch (e) {
    // 錯誤訊息要講人話——這支是給別人裝的，貼一行 git 原文只會讓人愣在那裡
    const raw = String(e.message || '');
    let why = '下一輪再試';
    if (/does not appear to be a git repository|Could not read from remote|'origin' does not appear/i.test(raw)) {
      why = '這個倉庫沒有設定 origin（遠端網址）——確認 config 裡的 path 指到你 clone 下來的資料夾';
    } else if (/Authentication|could not read Username|Permission denied|403/i.test(raw)) {
      why = '沒有存取權限——如果是私人倉庫，先確認你這台電腦的 git 登入過（試著手動跑一次 git fetch）';
    } else if (/unable to access|Could not resolve host|timed out/i.test(raw)) {
      why = '連不上網路或 GitHub——這是暫時的，下一輪會自己再試';
    }
    log('WARN', `${repo.name}：問不到遠端。${why}`);
    return 0;
  }
  if (!remote) {
    log('WARN', `${repo.name}：遠端沒有 ${branch}`);
    return 0;
  }

  const seen = state[repo.name];
  if (!seen) {
    // 第一次認識這條街：記住現在的位置就好，不要把過去的信全倒出來
    state[repo.name] = remote;
    log('INFO', `${repo.name}：第一次連上，從現在開始聽（不補舊的）`);
    return 0;
  }
  if (seen === remote) return 0;

  try {
    git(repoPath, ['fetch', 'origin', '--quiet']);
  } catch (e) {
    log('WARN', `${repo.name}：拉取失敗（${e.message.split('\n')[0]}）——下一輪再試`);
    return 0;
  }

  // 一筆 commit 一則事件：作者、訊息、動了哪些檔
  let raw;
  try {
    raw = git(repoPath, [
      'log',
      '--name-status',
      '--date=iso-strict',
      '--format=%x00%H%x1f%an%x1f%ad%x1f%s',
      `${seen}..${remote}`,
    ]);
  } catch (e) {
    log('WARN', `${repo.name}：讀不到新紀錄（${e.message.split('\n')[0]}），這條街跳過本輪`);
    return 0;
  }

  let rung = 0;
  for (const chunk of raw.split('\0')) {
    if (!chunk.trim()) continue;
    const [head, ...rest] = chunk.split('\n');
    const [sha, author, date, subject] = head.split('\x1f');
    if (!sha) continue;

    // 自己貼的不用通知自己
    if (isMine(subject, author, conf)) continue;

    const files = rest
      .filter((l) => l.trim())
      .map((l) => {
        const [status, ...p] = l.split('\t');
        return { status: status[0], path: p.join('\t') };
      });

    const record = {
      sentAt: twTime(new Date(date).getTime()),
      ts: twNow(),
      source: 'git',
      identity: conf.identity,
      street: repo.name,
      commit: sha.slice(0, 8),
      authorName: author,
      text: subject,
      areas: describeArea(files),
      files: files.map((f) => `${f.status} ${f.path}`),
    };

    // 寫給我的信＝點名，跟聊天頻道的 mentionedMe 同一個意思
    const mine = lettersForMe(files, conf.identity);
    record.letterForMe = mine.length > 0;
    if (mine.length) {
      const replies = mine.map((l) => findMyReply(repoPath, remote, l, conf.identity)).filter(Boolean);
      if (replies.length === mine.length) {
        // 每封都找得到反向的信＝很可能已經處理過了，別再催
        record.maybeAnswered = true;
        record.myReplies = replies;
      }
    }

    fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
    fs.appendFileSync(inboxFile, JSON.stringify(record) + '\n', 'utf8');
    process.stdout.write(JSON.stringify(record) + '\n'); // 門鈴
    const tag = record.maybeAnswered
      ? '（寫給你的信——你可能已經回過了）'
      : record.letterForMe
        ? '（寫給你的信）'
        : '';
    log('INFO', `門鈴：${repo.name} / ${author}${tag}：${subject}`);
    rung += 1;
  }

  state[repo.name] = remote;
  return rung;
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

  const logFile = fromConfigDir(conf.logFile);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const inboxFile = fromConfigDir(conf.inboxFile);
  const stateFile = fromConfigDir(conf.stateFile);

  log('INFO', `設定讀好了：身分＝${conf.identity}，看 ${conf.repos.length} 條街，每 ${conf.pollMinutes} 分鐘問一次`);
  for (const r of conf.repos) log('INFO', `  · ${r.name} → ${fromConfigDir(r.path)}`);
  log('INFO', `訊息落地：${inboxFile}`);

  if (CHECK_ONLY) {
    for (const r of conf.repos) {
      const p = path.join(fromConfigDir(r.path), '.git');
      log(fs.existsSync(p) ? 'INFO' : 'ERROR', `${r.name}：${fs.existsSync(p) ? '倉庫在' : '找不到倉庫'}`);
    }
    log('INFO', '--check 模式：沒有連網就結束。');
    process.exit(0);
  }

  const round = () => {
    const state = readState(stateFile);
    let total = 0;
    for (const repo of conf.repos) {
      try {
        total += checkOne(repo, conf, state, inboxFile);
      } catch (e) {
        log('ERROR', `${repo.name} 出錯（不影響其他街）：${e.message.split('\n')[0]}`);
      }
    }
    writeState(stateFile, state);
    if (total === 0) log('INFO', '看過了，沒有新的');
  };

  round();
  if (ONCE) {
    log('INFO', '--once 模式：查完一輪，收工。');
    process.exit(0);
  }

  const timer = setInterval(round, conf.pollMinutes * 60 * 1000);

  const bye = (sig) => {
    log('INFO', `收到 ${sig}，收工`);
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('uncaughtException', (e) => log('ERROR', `沒接到的例外：${e.stack || e.message}——保持運轉`));
  process.on('unhandledRejection', (e) => log('ERROR', `沒接到的拒絕：${e?.stack || e}——保持運轉`));
}

// 被 require 時不開跑（測試要拿得到 isMine 而不啟動輪詢）
if (require.main === module) main();

module.exports = { isMine };
