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

$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*ai-doorbell*" -and $_.CommandLine -like "*$Config*" }

if ($running) {
    Write-Host "✓ $who 的$what 門鈴已經在跑了（行程編號 $($running.ProcessId -join '、')），沒有重複啟動。"
    exit 0
}

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'logs') | Out-Null
Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$Vbs`"", "`"$Config`"", "`"$Prog`"" -WindowStyle Hidden
Start-Sleep -Seconds 4

$now = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*ai-doorbell*" -and $_.CommandLine -like "*$Config*" }

if ($now) {
    Write-Host "✓ $who 的$what 門鈴啟動了（行程編號 $($now.ProcessId -join '、')），沒有視窗。"
    Write-Host "  它在做的事：收$what 的新訊息寫進 inbox.jsonl。不發言。"
    Write-Host "  看它的運轉紀錄：$Root\logs\"
} else {
    Write-Host "✗ 啟動失敗。看一下 $Root\logs\ 裡的紀錄說了什麼。" -ForegroundColor Red
    exit 1
}
