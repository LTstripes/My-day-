#requires -Version 5.1
[CmdletBinding()]
param([string] $Root = 'D:\My day')

$ErrorActionPreference = 'Stop'
if ($Root -notmatch '^[a-zA-Z]:[\\/]' -or $Root -match '(^|[\\/])\.\.([\\/]|$)') {
    throw 'Choose an absolute local project directory.'
}
$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
if ($rootPath.Length -le 2) { throw 'Choose a directory below the drive root.' }
$scriptPath = Join-Path $rootPath 'main\tools\workspace\Move-InactiveWorkspaces.ps1'
$file = Get-Item -LiteralPath $scriptPath -Force
if ($file.PSIsContainer) { throw "Expected a script at $scriptPath" }
for ($item = $file; $null -ne $item;) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked path: $($item.FullName)" }
    if ($item -is [IO.FileInfo]) { $item = $item.Directory } else { $item = $item.Parent }
}
$taskName = 'MyDay-WorkspaceQuarantine'
$description = 'My Day: move inactive managed workspaces into project quarantine.'
$exe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -Root "{1}" -Apply' -f $scriptPath, $rootPath
$userName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$existing = Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq $taskName
if ($existing -and ($existing.Description -ne $description -or $existing.Actions.Count -ne 1 -or
    $existing.Actions[0].Execute -ne $exe -or $existing.Actions[0].Arguments -ne $arguments)) {
    throw "A different task already uses the name $taskName."
}
$action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $rootPath
$trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today.AddHours(19))
$principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Description $description -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force:([bool]$existing)
