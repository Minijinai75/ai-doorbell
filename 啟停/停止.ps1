# ai-doorbell——停止
# 只殺「跑ai-doorbell discord-watch.js」的那支 node，其他 node 程式一律不碰。
#
# 用法：
#   .\停止.ps1                          # 停 config.json 那一隻
#   .\停止.ps1 -Config config-第二個.json  # 停指定的那隻
#   .\停止.ps1 -All                      # 全部停掉

param(
    [string]$Config = 'config.json',
    [switch]$All
)

$ErrorActionPreference = 'Stop'

# 比對不指定程式檔名——本專案有兩種耳朵（discord-watch.js 聊天頻道／git-watch.js git 郵局），
# 寫死 discord-watch.js 會讓git 郵局那支變成停不掉的孤兒（實測踩到：
# 停止說「本來就沒在跑」、啟動說「已經在跑了」，兩句自相矛盾就是這個原因）
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*ai-doorbell*" }

if (-not $All) {
    # 沒帶 --config 啟動的（舊版啟動方式）算是預設那一隻，否則會變成殺不掉的孤兒
    $running = $running | Where-Object {
        ($_.CommandLine -like "*$Config*") -or
        ($Config -eq 'config.json' -and $_.CommandLine -notlike '*--config*')
    }
}

if (-not $running) {
    Write-Host "✓ 本來就沒在跑。"
    exit 0
}

foreach ($p in $running) {
    Write-Host "停掉行程 $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force
}
Write-Host "✓ 停好了。訊息不會再進 inbox（Discord 那邊的訊息不會消失，重開之後補得回來）。"
