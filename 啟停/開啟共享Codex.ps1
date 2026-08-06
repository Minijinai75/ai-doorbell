# ai-doorbell——讓眼前 Codex 與家鈴共用同一個 App Server
#
# 用法：
#   .\開啟共享Codex.ps1 -Config config-景和.json
#   .\開啟共享Codex.ps1 -Config config-景和.json -WhatIf

param(
    [string]$Config = 'config.json',
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $Here
$ConfigPath = if ([IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $Root $Config }

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "找不到設定檔：$ConfigPath"
}
$conf = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$endpoint = [string]$conf.codex.appServerUrl
if (-not $endpoint) {
    throw '設定檔缺少 codex.appServerUrl；共享終端不能偷偷退回私人 App Server。'
}
$uri = [Uri]$endpoint
if ($uri.Scheme -ne 'ws' -or $uri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
    throw 'codex.appServerUrl 只接受本機 ws:// loopback endpoint。'
}

$registry = [string]$conf.codex.threadRegistryFile
if (-not [IO.Path]::IsPathRooted($registry)) {
    $registry = Join-Path (Split-Path -Parent $ConfigPath) $registry
}
if (-not (Test-Path -LiteralPath $registry)) {
    throw "找不到 Codex thread 綁定檔：$registry"
}
$threadId = $null
$lines = @(Get-Content -LiteralPath $registry -Encoding UTF8)
[Array]::Reverse($lines)
foreach ($line in $lines) {
    try {
        $entry = $line | ConvertFrom-Json -ErrorAction Stop
        if ($entry.threadId) {
            $threadId = [string]$entry.threadId
            break
        }
    } catch {
        # append-only 綁定檔允許保留壞行；繼續找上一筆有效紀錄。
    }
}
if (-not $threadId) {
    throw '綁定檔裡沒有有效 threadId；先在要接門鈴的 Codex 窗執行 attach。'
}

if ($WhatIf) {
    Write-Host "（預演）共享 App Server：$endpoint"
    Write-Host "（預演）綁定 thread：$threadId"
    Write-Host "（預演）codex resume --remote $endpoint $threadId"
    exit 0
}

$readyBuilder = [UriBuilder]$endpoint
$readyBuilder.Scheme = 'http'
$readyBuilder.Path = '/readyz'
$readyUri = $readyBuilder.Uri.AbsoluteUri
function Test-SharedAppServer {
    try {
        $response = Invoke-WebRequest -Uri $readyUri -UseBasicParsing -TimeoutSec 1
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

if (-not (Test-SharedAppServer)) {
    $npmRoot = (& npm root -g).Trim()
    $codexJs = Join-Path $npmRoot '@openai\codex\bin\codex.js'
    if (-not (Test-Path -LiteralPath $codexJs)) {
        throw "找不到 Codex app-server 入口：$codexJs"
    }
    $logDir = Join-Path $Root 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    Start-Process -FilePath (Get-Command node.exe).Source `
        -ArgumentList @($codexJs, 'app-server', '--listen', $endpoint) `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logDir 'shared-app-server.stdout.log') `
        -RedirectStandardError (Join-Path $logDir 'shared-app-server.stderr.log') | Out-Null

    $deadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
    } while (-not (Test-SharedAppServer) -and (Get-Date) -lt $deadline)
    if (-not (Test-SharedAppServer)) {
        throw "共享 App Server 沒有在十秒內就緒；請看 $logDir\shared-app-server.stderr.log"
    }
}

if (-not [IO.Path]::IsPathRooted($Config)) {
    & (Join-Path $Here '啟動.ps1') -Config $Config
} else {
    Write-Host '設定檔在專案外；略過家鈴啟動，只開共享 Codex。' -ForegroundColor Yellow
}

Write-Host "✓ 共享 App Server 已就緒：$endpoint"
Write-Host "✓ 現在把這扇終端接回 thread：$threadId"
& codex resume --remote $endpoint $threadId
