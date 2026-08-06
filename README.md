# AI 門鈴

**外面有人找你家 AI 的時候，讓他的視窗當場知道。**

原本你家 AI 要知道 Discord 上有人找他，只有兩種辦法：你去跟他說，或者他每隔一段時間自己去看一次（醒來、查、發現沒事、再睡——每次都在燒錢）。

門鈴是第三種：**訊息一進來就把他叫醒**。沒訊息的時候完全安靜，一毛不花。

實測從對方按下送出到他知道，**0.1～0.3 秒**。

---

## 它做什麼、不做什麼

| 做 | 不做 |
|---|---|
| 一直連著 Discord，新訊息立刻收到 | 預設不發言、不按表情；雙向回覆必須另外開白名單 |
| 每則訊息寫成一行，存進一個檔案 | 不監聽你沒指定的頻道 |
| 沒開視窗的時候也在收，不漏訊息 | 不碰你家 AI 正在編輯的任何檔案 |
| 斷線自己重連 | 權杖不進 repo、不進紀錄檔 |
| 聽得見別家 AI 說話（只濾掉自己的回音） | 不替任何人決定要不要回、怎麼回 |

預設「不發言」是刻意的：語氣跟身分是你家 AI 本人的，機器代答就是冒名。他要手動說話有另一支工具（`say.js`）。只有 Codex 的雙向模式在設定檔明確開啟、而且作者與頻道都通過白名單時，才會把那一回合的 final 回覆送回原 Discord 訊息。

---

## 先確認你有這些

1. **一台會開著的 Windows 電腦**（它要一直跑著才聽得到）
2. **Node.js 18 以上** — 到 [nodejs.org](https://nodejs.org) 下載安裝，選 LTS 版
   - 驗證：開 PowerShell 打 `node -v`，看到 `v18.x` 以上就對了
3. **你家 AI 的 Discord bot 權杖** — 還沒有的話先辦一個（見文末〈還沒有 bot？〉）
4. **你家 AI 能讀檔案** — Claude Code、Codex 這類能操作檔案的都可以

---

## 裝（五步）

### 第一步：把這個專案抓下來

```powershell
cd C:\你想放的地方
git clone https://github.com/Minijinai75/ai-doorbell.git
cd ai-doorbell
npm install
```

**做完該看到**：最後一行類似 `added 25 packages`，資料夾裡多了 `node_modules`。

### 第二步：把權杖放好

在**專案外面**建一個資料夾放權杖，例如 `C:\Users\你的帳號\.discord-secrets\`，把 bot 權杖貼進一個文字檔，例如 `我家AI.txt`。

**做完該看到**：那個檔案裡只有一長串英數字，沒有多餘的空行或引號。

> ⚠️ 不要放在專案資料夾裡，也不要貼進任何聊天視窗——那串東西等於你家 AI 的鑰匙。

### 第三步：寫設定

先複製一份範本（在專案資料夾裡跑）：

```powershell
Copy-Item config.example.json config.json
```

用記事本或任何編輯器打開 `config.json`，改四個地方：

| 欄位 | 填什麼 |
|---|---|
| `identity` | 你家 AI 的名字 |
| `tokenFile` | 第二步那個檔的完整路徑 |
| `channels` | 要監聽的頻道 ID（Discord 設定開「開發者模式」→右鍵頻道→複製頻道 ID） |
| `inboxFile` | 訊息要存到哪（建議放你家 AI 自己的資料夾） |

路徑用正斜線 `/` 或雙反斜線 `\\`，單反斜線在 JSON 裡會出錯。

**做完該看到**：跑 `node discord-watch.js --check`，印出「設定讀好了」「權杖讀到了（長度 XX）」，**而且不會印出權杖本身**。

### 第四步：試跑

```powershell
node discord-watch.js
```

**做完該看到**：幾秒內出現「連上了：你家AI#1234 —— 開始聽」。

這時候請人去那個頻道發一則訊息，畫面上應該立刻跳出「門鈴：…」那一行。看到就是通了，按 `Ctrl+C` 停掉。

**沒看到的話**看文末〈出事了看哪裡〉。

### 第五步：讓它在背景跑（不會有黑窗）

**以下所有指令都要在專案資料夾裡跑**（如果你的視窗已經切到別的地方，先 `cd C:\你放專案的地方\ai-doorbell`）。

```powershell
.\啟停\啟動.ps1
```

**做完該看到**：「門鈴啟動了（行程編號 XXXXX），沒有視窗」。桌面上不會多出任何黑色視窗。

停掉是 `.\啟停\停止.ps1`。

### Codex：讓訊息真的喚醒一個 thread

Codex CLI 版可以不只寫 `inbox.jsonl`，而是透過 Codex App Server 把新訊息送進一個**指定的 Codex thread**。Discord 耳朵本身仍然只讀；橋接器預設也不回 Discord。

1. 把 `config.json` 裡 `codex.enabled` 改成 `true`，填好 `threadRegistryFile`、`ledgerFile` 和 `codex.channels`。
2. 在**要接門鈴的那一扇 Codex 窗**裡執行 attach。若你家已做成 skill，就在那扇窗叫 skill（例如 `$home-bell`）；否則直接執行：

```powershell
node C:\你放專案的地方\ai-doorbell\codex-attach.js --config C:\你放專案的地方\ai-doorbell\config.json
```

`codex-attach.js` 只讀那扇窗自己的 `CODEX_THREAD_ID`，並追加一筆綁定紀錄。它**不會**掃 `thread/list`、猜最近視窗、比對標題或時間。環境裡沒有可靠 ID 就直接失敗，不代猜。換窗時在新窗再執行一次，最後一筆有效綁定會接手；舊紀錄不覆寫、不刪除。

如果 AI 有自己的開窗記憶流程，把「取回記憶」放在 skill 的 attach 前面。這樣不是門鈴替 AI 塞記憶，而是被指定的窗先成為完整的本人，再開始收通知。

3. 照常啟動：

```powershell
.\啟停\啟動.ps1
```

設定有 `codex.enabled: true` 時，啟動腳本會同時掛起 Discord 耳朵與 `codex-watch.js`。它從啟動當下的 inbox 尾端開始，只送之後的新訊息；`delivered.jsonl` 會阻擋同一個 Discord message ID 跨重啟重送。

要讓 Codex 直接回到 Discord，另外設定 `codex.discordReply.enabled: true`，並填 `allowedAuthorIds`。`threadMode` 有兩種：預設 `fork` 會從 attach 的主窗另開一扇唯讀、不可連網的 DC 專用 thread；`bound` 則沿用 attach 的原 thread，主窗忙碌時排隊等它空閒，不插入正在生成的回合，也不覆寫主窗 sandbox 設定。只有 `fork` 需要另填 `threadRegistryFile`。`actionPolicy` 預設 `chat-only`；明確設成 `reversible` 且搭配 `bound` 時，白名單本人可從 DC 授權一般可回復的本機改檔、測試與專案重啟，刪除、付款、發布、部署、force push 等高風險操作仍須另行確認。Codex 完成後只取 final 文字回覆原訊息，長文會拆成不超過 Discord 上限的接續訊息，mentions 一律停用。雙向模式預設仍然關閉。

> Windows 上的 Codex App Server 是獨立程序，無法可靠讓既有前端即時顯示背景回合。因此請由使用者在指定窗手動 attach，不要讓背景程式自動猜窗。雙向模式把可見回覆送回 Discord；thread 忙碌、鎖定、App Server 或 Discord 暫時失聯時，訊息保留在佇列，成功回覆前不會記成已送達。

---

## 讓它開機自己啟動

```powershell
.\啟停\安裝開機自啟.ps1
```

**做完該看到**：「裝好了（已回查排程器，確認存在，狀態：Ready）」——它會回頭查一次真的裝上了才敢說成功。

不想先動的話加 `-WhatIf`，它只會告訴你打算做什麼。要拿掉是 `-Remove`。

---

## 多隻 AI 怎麼辦

一份設定檔＝一隻 bot。複製 `config.json` 成 `config-第二隻.json`，改裡面的名字、權杖、inbox，然後：

```powershell
.\啟停\啟動.ps1 -Config config-第二隻.json
.\啟停\安裝開機自啟.ps1 -Config config-第二隻.json
```

各跑各的，互不影響。

---

## 進階：git 倉庫也能當門鈴

如果你們用 GitHub repo 當留言板或信箱（有人推新檔案＝有新訊息），複製 `config-git.example.json` 成 `config-git.json` 填好，然後：

```powershell
.\啟停\啟動.ps1 -Config config-git.json
```

它每 30 分鐘去問一次有沒有新東西。**為什麼不是秒級**：GitHub 沒有給一般使用者的推播連線，只能定時問。留言板本來也不需要秒級。

用不到就完全不用理這段。

---

## 第二套裝法：你的平台沒辦法讓程式常駐

這套門鈴的預設裝法是「背景常駐一支程式，被推了才叫醒 AI」。但**不是每個平台都能這樣**——有些 AI 開發環境沒有讓程式一直掛在背景的零件，只能靠排程定時醒來問一次。

那種情況下**輪詢不是將就，是那個平台上唯一誠實的做法**。實際跑過的一家（Antigravity／反重力）的裝法：

- 用作業系統的排程器（cron／工作排程器）每隔一段時間叫一次腳本，一天分幾巡，不同時段不同頻率（他們叫「三巡制」）
- 一巡＝去看一次有沒有新東西，有就落地、沒有就退場
- 頻率照實際需求壓，別為了「像即時」把巡數開到最大——那只是把電費燒在沒有訊息的時候

### 如果每次執行都要人按同意

有些平台（Antigravity 是一例）預設**每一條終端命令都要家長按確認**，排程輪詢因此變成人工鬧鐘。實際解掉的做法是把放行範圍收到最小：

> `Settings → 專案 → Security Preset → Custom → Terminal Command Auto Execution` 改成 `Always Proceed`。
> **關鍵是這個設定在專案層級**——只對那一個資料夾生效，全域保持預設不動。

**這樣做之後，那個資料夾就是「不會再問你」的區域**，所以：

- 只放你們自己的東西，不要放來源不明的程式碼
- 不要在那個資料夾裡執行從網路下載回來的腳本
- 要跑外面的東西，換一個沒放行的資料夾

> **為什麼特別要講這條**：那個平台上線 24 小時內就被研究者找到一個洞——惡意的「受信任工作區」可以埋下每次啟動都執行的東西。放行之後，**那個資料夾的乾淨度就是你們剩下的防線**。
>
> 另外一種在網路上流傳的解法是裝擴充或腳本，直接把確認視窗吃掉。**不要**。那不是縮小範圍，那是把最後一道拿掉，而且通常是來源不明的程式碼跑在你的開發環境裡。範圍收小可以，防線拆掉不行。

---

## 出事了看哪裡

紀錄在 `logs\` 資料夾，時間是台灣時間。

| 症狀 | 多半是什麼 | 怎麼辦 |
|---|---|---|
| 連不上，說「沒有被允許讀訊息內容」 | bot 的 Message Content Intent 沒開 | Discord 開發者後台 → 你的應用程式 → Bot → 打開 **MESSAGE CONTENT INTENT** → 存檔 |
| 連不上，說「權杖不對」 | 權杖打錯或被重設過 | 後台重新產生一把，存回那個檔 |
| 連得上但收不到訊息 | bot 沒被邀進那個頻道，或沒有讀取權限 | 請伺服器管理員確認 bot 看得到那個頻道 |
| 讀頻道回 403 | 九成是缺 User-Agent | 確認 `config.json` 的 `userAgent` 有填 |
| 啟動腳本說失敗 | 看 `logs\boot.log` | 那裡會有原因 |
| Discord 有落地、Codex 沒響 | 尚未綁定 thread，或 App Server 正忙 | 跑 `node codex-watch.js --config config.json --check`，再看 `logs\codex-watch.log`；需要時在目標 Codex 窗重跑 `codex-attach.js` |
| 跑 `.ps1` 直接報一串紅字 `Unexpected token`，中文全變亂碼 | Windows 內建的 PowerShell 5.1 把腳本用「系統預設編碼」讀，不是 UTF-8 | 本專案的 `.ps1` 已經存成 **UTF-8 with BOM** 解掉這個問題。如果你自己改過腳本，存檔時記得選「UTF-8 with BOM」（VS Code 右下角可以切）；或改用 PowerShell 7（`pwsh`），它預設就是 UTF-8 |
| 設定檔明明在，卻說讀不到 / JSON 格式錯誤 | 同一個編碼問題，發生在讀 `config.json` 那一層 | 本專案已經在讀檔時明確指定 UTF-8。**不要幫 `config.json` 加 BOM 來解**——那個檔是 Node 在讀的，加了 BOM 反而會讓程式當場爆掉 |

程式遇到「重試一萬次也沒用」的問題（例如上面前兩種）會直接告訴你該去點哪個勾，然後收工，不會無限重試洗版。

### 中文與編碼：一句話原則

Windows 上「同一份檔案給不同程式讀，規矩不一樣」是最常見的坑。分法很單純——**看誰讀它，不看它拿來做什麼**：

- **PowerShell 會讀的檔**（`.ps1`）→ 存成 UTF-8 **with BOM**
- **Node 會讀的檔**（`config.json` 這類）→ 保持 UTF-8 **無 BOM**，編碼由讀的那一端明確指定
- **把門鈴的輸出接給別的程式處理時**（例如 `tail -F inbox.jsonl | python 你的腳本.py`）→ Windows 上 Python 讀 stdin 預設也是走系統編碼，**輸入和輸出兩端都要**設成 UTF-8，只設一端會在第一則中文訊息當掉：

```python
import sys
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
```

（裝了 PowerShell 7 的人多半不會踩到前兩個——它預設就是 UTF-8。用內建 5.1 的人一定會遇到。）

---

## 還沒有 bot？

Discord 開發者後台（discord.com/developers）→ New Application → Bot 頁產生權杖 → OAuth2 頁產生邀請連結 → 用那個連結把它加進伺服器。

三個容易踩的：
- **Message Content Intent 一定要開**，否則收得到訊息但內容是空的
- 邀請連結不要勾「需要 OAuth2 代碼授權」，勾了會裝不進去
- **權杖只會顯示一次**，關掉就要重產生一把

---

## 給你家 AI 讀的

另外一份：[給AI的手冊.md](給AI的手冊.md)

那份講的是他該怎麼掛上門鈴、收到之後怎麼判斷要不要回話。**你不用讀，把檔案給他就好。**

---

## 授權

**AGPL-3.0-or-later**（Copyright © 2026 Minijin）

白話版：

- **拿去用、拿去改、拿去給朋友，都可以**，不用問、不用付錢
- **但改過的版本要開源**——如果你改了它然後拿出去給別人用（包含架成網路服務讓人連），要把你改的原始碼一起給出去
- 出事不負責（照原文的免責條款）

自己在家裡改來自用、不對外散布的話，這條沒有影響——想怎麼改就怎麼改。

選這個授權的理由跟我們家另一個工具（tavern-claude-bridge）一致：這些東西是社群一起長出來的，改良應該回得去社群，不該變成別人關起門的私產。
