#requires -Version 5.1
[CmdletBinding()]
param([string] $Root = 'D:\My day')

$ErrorActionPreference = 'Stop'
$remote = 'https://github.com/LTstripes/My-day-.git'
if ($Root -notmatch '^[a-zA-Z]:[\\/]' -or $Root -match '(^|[\\/])\.\.([\\/]|$)') {
    throw 'Choose an absolute local project directory.'
}
foreach ($name in @('GIT_DIR','GIT_COMMON_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_NAMESPACE','GIT_QUARANTINE_PATH','GIT_SHALLOW_FILE','GIT_GRAFT_FILE')) {
    if ([Environment]::GetEnvironmentVariable($name)) { throw "Cannot set up workspaces while $name is set." }
}
$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
if (-not $rootPath -or $rootPath.Length -le [IO.Path]::GetPathRoot($rootPath).TrimEnd('\').Length) {
    throw 'Choose a project directory below the drive root.'
}

function Assert-PlainPath([string] $Path) {
    for ($part = [IO.DirectoryInfo]::new($Path); $null -ne $part; $part = $part.Parent) {
        try { $entry = Get-Item -Force -LiteralPath $part.FullName -ErrorAction Stop }
        catch [System.Management.Automation.ItemNotFoundException] { continue }
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Linked path is outside this setup: $($part.FullName)"
        }
    }
}
function Git-At([string] $Path, [string[]] $Arguments) {
    & git -C $Path @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Git could not complete setup in $Path" }
}
function Sync-Copy([string] $Name) {
    $path = Join-Path $rootPath $Name
    Assert-PlainPath $path
    $fresh = -not (Test-Path -LiteralPath $path)
    if ($fresh) {
        & git clone --origin origin --branch main -- $remote $path
        if ($LASTEXITCODE -ne 0) { throw "Clone failed in $path. The directory is available for inspection." }
    }
    $gitDir = Join-Path $path '.git'
    Assert-PlainPath $gitDir
    if (-not (Test-Path -LiteralPath $gitDir -PathType Container)) { throw "Expected an independent Git clone in $path" }
    $top = Git-At $path @('rev-parse', '--show-toplevel')
    if ([IO.Path]::GetFullPath($top) -ne [IO.Path]::GetFullPath($path)) { throw "Unexpected repository root in $path" }
    $common = Git-At $path @('rev-parse', '--path-format=absolute', '--git-common-dir')
    $actualGitDir = Git-At $path @('rev-parse', '--absolute-git-dir')
    if ([IO.Path]::GetFullPath($common) -ne $gitDir -or [IO.Path]::GetFullPath($actualGitDir) -ne $gitDir) {
        throw "Expected private Git metadata in $path"
    }
    foreach ($relative in @('objects', 'objects\info', 'refs', 'logs', 'config', 'index')) { Assert-PlainPath (Join-Path $gitDir $relative) }
    foreach ($relative in @('commondir', 'objects\info\alternates', 'objects\info\http-alternates', 'worktrees', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_START', 'rebase-apply', 'rebase-merge', 'sequencer', 'index.lock')) {
        if (Test-Path -LiteralPath (Join-Path $gitDir $relative)) { throw "Git checkout requires attention in $path ($relative)." }
    }
    $urls = @(Git-At $path @('config', '--local', '--get-all', 'remote.origin.url'))
    if ($urls.Count -ne 1 -or $urls[0] -notin @($remote, $remote.Substring(0, $remote.Length - 4), 'git@github.com:LTstripes/My-day-.git')) {
        throw "Unexpected origin in $path"
    }
    $branch = Git-At $path @('branch', '--show-current')
    $dirty = Git-At $path @('--no-optional-locks', 'status', '--porcelain', '--untracked-files=all')
    if ($dirty -or ($Name -eq 'main' -and $branch -ne 'main') -or ($Name -eq 'test' -and !$fresh -and $branch)) {
        Write-Warning "Skipped $path with local work or a different branch."
        return
    }
    Git-At $path @('fetch', 'origin', 'main')
    & git -C $path merge-base --is-ancestor HEAD refs/remotes/origin/main
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Preserved local commits in $path."
        return
    }
    if ($Name -eq 'main') { Git-At $path @('merge', '--ff-only', '--no-overwrite-ignore', 'origin/main') }
    else { Git-At $path @('switch', '--detach', '--no-overwrite-ignore', 'origin/main') }
}

Assert-PlainPath $rootPath
foreach ($path in @($rootPath, (Join-Path $rootPath 'projects'), (Join-Path $rootPath 'quarantine'))) {
    Assert-PlainPath $path
    [void][IO.Directory]::CreateDirectory($path)
}
Sync-Copy 'main'
Sync-Copy 'test'
$localGuide = Join-Path $rootPath 'AGENTS.md'
Assert-PlainPath $localGuide
if (-not (Test-Path -LiteralPath $localGuide)) {
    [IO.File]::Copy((Join-Path $PSScriptRoot 'ROOT-AGENTS.md'), $localGuide, $false)
}
