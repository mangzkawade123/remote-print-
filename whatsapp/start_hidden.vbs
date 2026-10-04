' Starts WhatsApp Auto Print with no window (used at Windows startup).
' If the program stops or crashes, it is started again after 30 seconds.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
Do
    sh.Run """C:\Program Files\nodejs\node.exe"" """ & dir & "\bot.js""", 0, True
    WScript.Sleep 30000
Loop
