Option Explicit

Dim fs, shell, projectPath, nodePath, runnerPath, command, exitCode
Set fs = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
If WScript.Arguments.Count <> 1 Then WScript.Quit 2

nodePath = WScript.Arguments(0)
If InStr(nodePath, Chr(34)) > 0 Then WScript.Quit 2
If Not fs.FileExists(nodePath) Then WScript.Quit 2
projectPath = fs.GetParentFolderName(fs.GetParentFolderName(fs.GetParentFolderName(WScript.ScriptFullName)))
runnerPath = fs.BuildPath(projectPath, "scripts\seat-executor\main.mjs")
If Not fs.FileExists(runnerPath) Then WScript.Quit 2

shell.CurrentDirectory = projectPath
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & runnerPath & Chr(34)
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
