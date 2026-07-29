# ai-doorbell——安裝／移除開機自啟（Windows 工作排程器）
#
# 四件套：①事先在複本上測過 ②動作前先報告要做什麼 ③重複跑不會出事 ④輸出講人話
#
# 用法（在 PowerShell 裡跑）：
#   .\安裝開機自啟.ps1                          # 裝 config.json 那一隻
#   .\安裝開機自啟.ps1 -Config config-第二個.json  # 裝別隻
#   .\安裝開機自啟.ps1 -Remove                   # 移除
#   .\安裝開機自啟.ps1 -WhatIf                   # 只講會做什麼，不真的動
#
# 一隻 AI 一項工作，各自獨立，互不影響。

param(
    [string]$Config = 'config.json',
    [switch]$Remove,
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
$Vbs = Join-Path $Here 'start-hidden.vbs'
$ConfigPath = Join-Path $Root $Config

if (-not (Test-Path $Vbs)) {
    Write-Host "找不到 start-hidden.vbs，路徑：$Vbs" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $ConfigPath)) {
    Write-Host "找不到設定檔：$ConfigPath" -ForegroundColor Red
    exit 1
}

$conf = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$who = $conf.identity
# 有 repos 欄位＝git 郵局那種（定時去問 GitHub），否則是聊天頻道（Discord 長連線）
$Prog = if ($conf.repos) { 'git-watch.js' } else { 'discord-watch.js' }
$what = if ($conf.repos) { 'git 郵局' } else { '聊天頻道' }
$TaskName = "門鈴-$who-$what"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

# ── 移除 ──────────────────────────────────────────────
if ($Remove) {
    if (-not $existing) {
        Write-Host "✓ $who 本來就沒裝開機自啟，沒有東西要移除。"
        exit 0
    }
    if ($WhatIf) {
        Write-Host "（預演）會移除工作排程器裡的「$TaskName」。"
        exit 0
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "✓ 已移除 $who 的開機自啟。正在跑的門鈴不受影響，要停它請跑 停止.ps1。"
    exit 0
}

# ── 安裝 ──────────────────────────────────────────────
if ($existing) {
    Write-Host "✓ $who 已經裝過了（工作排程器裡有「$TaskName」），沒有重複安裝。"
    Write-Host "  要改設定請先 .\安裝開機自啟.ps1 -Config $Config -Remove 再裝一次。"
    exit 0
}

if ($WhatIf) {
    Write-Host "（預演）會在工作排程器建立一項工作："
    Write-Host "   名稱：$TaskName"
    Write-Host "   時機：妳登入 Windows 時"
    Write-Host "   動作：wscript.exe `"$Vbs`" `"$Config`"（無視窗啟動 $who 的門鈴）"
    Write-Host "   帳號：$env:USERNAME（不需要密碼、不用系統權限）"
    exit 0
}

# UserId 要「電腦名\使用者名」完整格式——只給使用者名會回「參數錯誤」
# （實測踩到，而且當時腳本照樣印「裝好了」，比失敗本身更糟）
$FullUser = "$env:COMPUTERNAME\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Vbs`" `"$Config`" `"$Prog`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $FullUser
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $FullUser -LogonType Interactive -RunLevel Limited

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "ai-doorbell（$who）：Discord 新訊息收進 inbox.jsonl。只讀不寫，不會代替任何人發言。" -ErrorAction Stop | Out-Null
} catch {
    Write-Host "✗ 沒裝成功：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  工作排程器沒有被改動。門鈴現在還是要手動啟動（.\啟動.ps1 -Config $Config）。"
    exit 1
}

# 寫完要回頭確認真的在排程器裡——不然「印了成功」跟「真的成功」是兩回事
$check = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $check) {
    Write-Host "✗ 指令跑完了，但排程器裡查不到「$TaskName」——當作沒裝成功。" -ForegroundColor Red
    exit 1
}

Write-Host @"
✓ $who 的$what 門鈴裝好了（已回查排程器，確認存在，狀態：$($check.State)）。
   下次登入 Windows 就會自己啟動，不會跳黑窗。
   現在要立刻啟動一次的話：.\啟動.ps1 -Config $Config
   想拿掉：.\安裝開機自啟.ps1 -Config $Config -Remove
   它做的事：只收$what 的新訊息寫進檔案，不發言、不按表情。
"@
