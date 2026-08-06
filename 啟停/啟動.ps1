# ai-doorbell——手動啟動（無視窗）
# 已經在跑就不會重複開第二支（重複跑不會出事）。
#
# 用法：
#   .\啟動.ps1                          # 啟動 config.json 那一隻
#   .\啟動.ps1 -Config config-第二個.json  # 啟動別隻

param([string]$Config = 'config.json')

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
$Vbs = Join-Path $Here 'start-hidden.vbs'

if (-not (Test-Path (Join-Path $Root $Config))) {
    Write-Host "找不到設定檔：$Config（要放在 $Root 裡）" -ForegroundColor Red
    exit 1
}
# -Encoding UTF8 不能省：Windows PowerShell 5.1 預設用系統的 ANSI 編碼讀檔，
# 設定檔裡只要有非英文字元（中文、日文等）就會變亂碼，ConvertFrom-Json 直接失敗。
# 為什麼不改成給 config.json 加 BOM 解：node 端是 JSON.parse(readFileSync(...,'utf8'))，
# BOM 會讓它爆——設定檔必須保持無 BOM，所以編碼要在讀的這一端明示。
$conf = Get-Content (Join-Path $Root $Config) -Raw -Encoding UTF8 | ConvertFrom-Json
$who = $conf.identity
# 有 repos 欄位＝git 郵局那種（定時去問 GitHub），否則是聊天頻道（Discord 長連線）
$Prog = if ($conf.repos) { 'git-watch.js' } else { 'discord-watch.js' }
$what = if ($conf.repos) { 'git 郵局' } else { '聊天頻道' }
$programs = @([pscustomobject]@{ File = $Prog; Name = $what })
if (-not $conf.repos -and $conf.codex.enabled) {
    $programs += [pscustomobject]@{ File = 'codex-watch.js'; Name = 'Codex 活體窗' }
}

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
foreach ($program in $programs) {
    $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object {
            $_.CommandLine -like "*ai-doorbell*" -and
            $_.CommandLine -like "*$Config*" -and
            $_.CommandLine -like "*$($program.File)*"
        }
    if ($running) {
        Write-Host "✓ $who 的$($program.Name)已經在跑了（行程編號 $($running.ProcessId -join '、')），沒有重複啟動。"
        continue
    }
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$Vbs`"", "`"$Config`"", "`"$($program.File)`"" -WindowStyle Hidden
}
Start-Sleep -Seconds 4

foreach ($program in $programs) {
    $now = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object {
            $_.CommandLine -like "*ai-doorbell*" -and
            $_.CommandLine -like "*$Config*" -and
            $_.CommandLine -like "*$($program.File)*"
        }
    if (-not $now) {
        Write-Host "✗ $($program.Name)啟動失敗。看一下 $Root\logs\ 裡的紀錄說了什麼。" -ForegroundColor Red
        exit 1
    }
    Write-Host "✓ $who 的$($program.Name)確認正在跑（行程編號 $($now.ProcessId -join '、')），沒有視窗。"
}
$replying = -not $conf.repos -and $conf.codex.enabled -and $conf.codex.discordReply.enabled
if ($replying) {
    if ($conf.codex.discordReply.threadMode -eq 'bound') {
        Write-Host "  它在做的事：收$what 的新訊息寫進 inbox；只替白名單使用者沿用綁定原窗，等空閒後把 final 回覆送回原訊息。"
    } else {
        Write-Host "  它在做的事：收$what 的新訊息寫進 inbox；只替白名單使用者喚醒唯讀 DC 專用窗，並把 final 回覆送回原訊息。"
    }
} else {
    Write-Host "  它在做的事：收$what 的新訊息寫進 inbox；Codex 開啟時只把通知送進綁定窗。絕不回 Discord。"
}
if ($conf.codex.appServerUrl) {
    Write-Host "  Codex 橋接目標：$($conf.codex.appServerUrl)（與用 --remote 開的終端共用）"
}
Write-Host "  看它的運轉紀錄：$Root\logs\"
