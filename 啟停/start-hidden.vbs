' ai-doorbell——無視窗啟動
'
' 為什麼要這支：工作排程器直接叫 node 會跳一個黑色小視窗掛在畫面上（沒有人想要桌面上多一個關不掉的黑框）。
' WScript.Shell 的 Run 第二個參數 0 = 完全不顯示視窗，這是 Windows 上唯一乾淨的做法。
'
' 為什麼不經 cmd /c 做重導向（實測踩到）：
'   原本寫成 cmd /c node "…discord-watch.js" --config "…" > NUL 2>> "…log"，
'   引號一多，cmd 自己的解析規則就會咬掉整條命令——不帶 --config 剛好過關、
'   帶了就整條不執行，而且**完全無聲**（沒有任何錯誤、沒有 log，node 根本沒被啟動）。
'   現在直接叫 node，不重導向；啟動早期的錯誤由程式自己寫進 logs\boot.log。
'
' 用法：wscript start-hidden.vbs [設定檔名] [程式檔名]
'       設定檔名省略時用 config.json；程式檔名省略時用 discord-watch.js（聊天頻道的耳朵）
'       git 郵局的耳朵是 git-watch.js
Option Explicit

Dim shell, fso, here, cmd, cfg, prog
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 本檔在「啟停」資料夾裡，專案根目錄要往上一層
here = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

If WScript.Arguments.Count > 0 Then
  cfg = WScript.Arguments(0)
Else
  cfg = "config.json"
End If

If WScript.Arguments.Count > 1 Then
  prog = WScript.Arguments(1)
Else
  prog = "discord-watch.js"
End If

shell.CurrentDirectory = here

cmd = "node """ & here & "\" & prog & """ --config """ & cfg & """"

' 0 = 隱藏視窗，False = 不等它結束
shell.Run cmd, 0, False
