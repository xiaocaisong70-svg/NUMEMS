Option Explicit
Dim fs, shell, root, nodePath, command
Set fs=CreateObject("Scripting.FileSystemObject")
Set shell=CreateObject("WScript.Shell")
If WScript.Arguments.Count<>1 Then WScript.Quit 2
nodePath=WScript.Arguments(0)
If InStr(nodePath,Chr(34))>0 Or Not fs.FileExists(nodePath) Then WScript.Quit 2
root=fs.GetParentFolderName(fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName)))
shell.CurrentDirectory=root
command=Chr(34)&nodePath&Chr(34)&" "&Chr(34)&fs.BuildPath(root,"scripts\agentless\watchdog.mjs")&Chr(34)
WScript.Quit shell.Run(command,0,True)
