Option Explicit
Dim fs, shell, root, nodePath, command, powershell
Set fs=CreateObject("Scripting.FileSystemObject")
Set shell=CreateObject("WScript.Shell")
If WScript.Arguments.Count<>1 Then WScript.Quit 2
nodePath=WScript.Arguments(0)
If InStr(nodePath,Chr(34))>0 Or Not fs.FileExists(nodePath) Then WScript.Quit 2
root=fs.GetParentFolderName(fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName)))
shell.CurrentDirectory=root
powershell=shell.ExpandEnvironmentStrings("%SystemRoot%")&"\System32\WindowsPowerShell\v1.0\powershell.exe"
command=Chr(34)&powershell&Chr(34)&" -NoProfile -NonInteractive -WindowStyle Hidden -File "&Chr(34)&fs.BuildPath(root,"scripts\agentless\isolated-desktop.ps1")&Chr(34)&" -Mode run -NodeExe "&Chr(34)&nodePath&Chr(34)
WScript.Quit shell.Run(command,0,True)
