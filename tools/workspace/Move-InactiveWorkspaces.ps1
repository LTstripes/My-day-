#requires -Version 5.1
[CmdletBinding()]
param([string]$Root = 'D:\My day', [switch]$Apply)

$ErrorActionPreference = 'Stop'
$cutoff = [DateTime]::UtcNow.AddDays(-7)
$day = Get-Date -Format 'yyyy-MM-dd'

# Walk from the volume root. Resolve-Path alone does not reject intermediate junctions.
function Assert-PlainPath([string]$Path, [switch]$File) {
    $item = Get-Item -Force -LiteralPath $Path
    if ($File.IsPresent -eq $item.PSIsContainer) { throw "Unexpected file type: $Path" }
    while ($null -ne $item) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked path: $($item.FullName)" }
        if ($item -is [IO.FileInfo]) { $item = $item.Directory } else { $item = $item.Parent }
    }
}

function Get-GitOutput([string]$At, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $lines = & git --no-optional-locks --no-replace-objects -c core.fsmonitor=false -c core.untrackedCache=false -C $At @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Git could not verify '$($Arguments[0])'." }
    $lines
}

function Assert-IndependentClone([string]$At) {
    $metadata = Join-Path $At '.git'
    Assert-PlainPath $metadata
    Assert-PlainPath (Join-Path $metadata 'config') -File
    Assert-PlainPath (Join-Path $metadata 'objects\info')
    foreach ($relative in @('commondir','worktrees','objects\info\alternates','objects\info\http-alternates')) {
        if (Test-Path -LiteralPath (Join-Path $metadata $relative)) { throw 'Git storage is linked or shared.' }
    }
    $actual = Get-GitOutput $At @('rev-parse','--absolute-git-dir')
    $top = Get-GitOutput $At @('rev-parse','--show-toplevel')
    if ([IO.Path]::GetFullPath($actual) -ne $metadata -or [IO.Path]::GetFullPath($top) -ne $At) {
        throw 'Git resolves to a different working tree or metadata directory.'
    }
}

function Get-Origin([string]$At) {
    $urls = @(Get-GitOutput $At @('config','--local','--get-all','remote.origin.url'))
    if ($urls.Count -ne 1 -or [string]::IsNullOrWhiteSpace($urls[0])) { throw 'Cannot verify a unique origin.' }
    return $urls[0]
}

function Get-WorkBlocker([string]$At) {
    # Enumerate one directory at a time, checking links before entering them.
    $stack = New-Object 'System.Collections.Generic.Stack[System.IO.DirectoryInfo]'
    $stack.Push([IO.DirectoryInfo]$At)
    $gitPrefix = (Join-Path $At '.git') + '\'
    while ($stack.Count) {
        $dir = $stack.Pop()
        foreach ($entry in $dir.EnumerateFileSystemInfos()) {
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { return 'Contains a linked file or directory.' }
            $path = $entry.FullName
            if ($path.StartsWith($gitPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                $relative = $path.Substring($gitPrefix.Length)
                if ($relative -match '(^|\\)[^\\]+\.lock$|^(worktrees|commondir|modules|rebase-apply|rebase-merge|sequencer|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_START|objects\\info\\(http-)?alternates)$') {
                    return 'Contains linked Git storage, an active operation, or a lock.'
                }
                # A background fetch updates remote refs, objects and FETCH_HEAD.
                $activity = $relative -match '^(HEAD|index|config|packed-refs|my-day-finished|logs\\HEAD|(?:logs\\)?refs\\heads(?:\\.*)?)$'
            } else {
                if ($entry.Name -eq '.git' -and $dir.FullName -ne $At) { return 'Contains another Git repository.' }
                $activity = $entry.Name -ne '.git'
            }
            if ($activity -and ($entry.LastWriteTimeUtc -gt $cutoff -or $entry.CreationTimeUtc -gt $cutoff)) {
                return 'Recent working tree or local Git activity.'
            }
            if ($entry -is [IO.DirectoryInfo]) { $stack.Push($entry) }
        }
    }
}

function Test-Ancestor([string]$At, [string]$Commit, [string]$Tip) {
    try {
        Get-GitOutput $At @('merge-base','--is-ancestor',$Commit,$Tip) | Out-Null
        return $true
    } catch { return $false }
}

function Get-RetentionReason([IO.DirectoryInfo]$Folder, [string]$Source) {
    $Folder.Refresh()
    $at = $Folder.FullName
    $meta = Join-Path $at '.git'
    Assert-PlainPath $meta
    if (Test-Path -LiteralPath (Join-Path $meta 'my-day-keep')) { return 'Explicit keep marker.' }
    $marker = Join-Path $meta 'my-day-workspace.json'
    Assert-PlainPath $marker -File
    $record = Get-Content -Raw -LiteralPath $marker -Encoding UTF8 | ConvertFrom-Json
    if (($record.schema -isnot [int] -and $record.schema -isnot [long]) -or $record.schema -ne 1 -or
        $record.source -isnot [string] -or $record.task -isnot [string] -or
        $record.source -cne $Source -or $record.task -cne $Folder.Name) { return 'Ownership marker does not match this path.' }
    if ($record.createdUtc -is [datetime]) {
        if ($record.createdUtc.Kind -eq [DateTimeKind]::Unspecified) { return 'Creation time lacks a time zone.' }
        $created = $record.createdUtc.ToUniversalTime()
    } else {
        if ($record.createdUtc -notmatch '^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d\d:\d\d)$') { return 'Invalid creation time.' }
        $created = [DateTimeOffset]::Parse($record.createdUtc, [cultureinfo]::InvariantCulture).UtcDateTime
    }
    if ($created -gt $cutoff -or $Folder.LastWriteTimeUtc -gt $cutoff -or $Folder.CreationTimeUtc -gt $cutoff) { return 'Workspace is recent.' }
    $blocker = Get-WorkBlocker $at
    if ($blocker) { return $blocker }
    Assert-IndependentClone $at
    # Refresh the trusted identity on both the preview and the final decision.
    try {
        Assert-IndependentClone $mainPath
        Get-GitOutput $mainPath @('rev-parse','--verify','refs/remotes/origin/main^{commit}') | Out-Null
        $mainOrigin = Get-Origin $mainPath
    } catch { return 'Cannot verify the primary clone or its origin/main.' }
    if ((Get-Origin $at) -cne $mainOrigin) { return 'Origin differs from the primary clone.' }
    $status = Get-GitOutput $at @('status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none')
    if ($status) { return 'Working tree has changes or untracked files.' }
    # Git groups untracked ignored directories with a trailing slash. Only the
    # root dependency directory is reproducible; keep ignored local material elsewhere.
    $ignored = Get-GitOutput $at @('ls-files','--others','--ignored','--exclude-standard','--directory') |
        Where-Object { -not $_.StartsWith('node_modules/', [StringComparison]::Ordinal) } | Select-Object -First 1
    if ($ignored) { return 'Contains ignored local material outside root node_modules.' }
    $hidden = Get-GitOutput $at @('ls-files','-v') | Where-Object { $_ -cmatch '^[a-zS] ' } | Select-Object -First 1
    if ($hidden) { return 'Index flags prevent verification (skip-worktree or assume-unchanged).' }
    if (Get-GitOutput $at @('for-each-ref','--format=%(refname)','refs/stash')) { return 'Contains a stash.' }

    $head = Get-GitOutput $at @('rev-parse','--verify','HEAD^{commit}')
    $branches = @(Get-GitOutput $at @('for-each-ref','--format=%(objectname)','refs/heads'))
    $finished = Join-Path $meta 'my-day-finished'
    $confirmed = $false
    if (Test-Path -LiteralPath $finished) {
        Assert-PlainPath $finished -File
        $confirmed = (Get-Content -Raw -LiteralPath $finished).Trim() -ceq $head
    }
    foreach ($commit in (@($head) + $branches | Sort-Object -Unique)) {
        if (Test-Ancestor $at $commit 'refs/remotes/origin/main') { continue }
        if (Test-Ancestor $mainPath $commit 'refs/remotes/origin/main') { continue }
        if ($confirmed -and (Test-Ancestor $at $commit $head)) { continue }
        return 'HEAD or a local branch lacks confirmation in main.'
    }
}

function Get-QuarantineTarget([string]$Source, [string]$Task, [switch]$Create) {
    $parent = $Root
    foreach ($segment in @('quarantine',$day,$Source)) {
        $next = Join-Path $parent $segment
        if ([IO.Directory]::Exists($parent)) {
            Assert-PlainPath $parent
            $found = @(([IO.DirectoryInfo]$parent).GetFileSystemInfos($segment))
            if ($found.Count) { Assert-PlainPath $next }
            elseif ($Create) {
                [void][IO.Directory]::CreateDirectory($next)
                Assert-PlainPath $next
            }
        }
        $parent = $next
    }
    $target = Join-Path $parent $Task
    if ([IO.Directory]::Exists($parent)) {
        # Enumerating its parent also detects dangling links at the destination.
        foreach ($entry in ([IO.DirectoryInfo]$parent).EnumerateFileSystemInfos()) {
            if ($entry.Name -eq $Task) { throw 'Quarantine destination is occupied.' }
        }
    }
    return $target
}

if ($Root -notmatch '^[a-zA-Z]:[\\/]' -or $Root -match '(^|[\\/])\.\.([\\/]|$)') { throw 'Root must be an absolute local path.' }
$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\')
if ($Root.Length -le 2) { throw 'Specify a project root below the volume root.' }
Assert-PlainPath $Root
foreach ($name in @('GIT_DIR','GIT_COMMON_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_NAMESPACE','GIT_SHALLOW_FILE','GIT_GRAFT_FILE')) {
    if ([Environment]::GetEnvironmentVariable($name)) { throw "Cannot verify workspaces while $name is set." }
}
$projects = Join-Path $Root 'projects'
Assert-PlainPath $projects
$mainPath = Join-Path $Root 'main'

foreach ($source in Get-ChildItem -Directory -Force -LiteralPath $projects) {
    if ($source.Name -in @('main','test') -or ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    Assert-PlainPath $source.FullName
    foreach ($folder in Get-ChildItem -Directory -Force -LiteralPath $source.FullName) {
        $action = 'Kept'
        $reason = $null
        $destination = $null
        try {
            if ($folder.Name -in @('main','test')) { $reason = 'Protected directory name.' }
            else { $reason = Get-RetentionReason $folder $source.Name }
            if (-not $reason) {
                $destination = Get-QuarantineTarget $source.Name $folder.Name -Create:$Apply
                if ($Apply) {
                    $reason = Get-RetentionReason $folder $source.Name
                    if ($reason) { throw $reason }
                    # Same-volume Directory.Move refuses an existing target, even in a race.
                    Assert-PlainPath (Join-Path $folder.FullName '.git')
                    Assert-PlainPath ([IO.Path]::GetDirectoryName($destination))
                    if (Test-Path -LiteralPath (Join-Path $folder.FullName '.git\my-day-keep')) { throw 'Explicit keep marker.' }
                    [IO.Directory]::Move($folder.FullName, $destination)
                    $action = 'Moved'
                } else { $action = 'WouldMove' }
                $reason = 'Inactive for seven days and completion verified.'
            }
        } catch { $reason = $_.Exception.Message }
        [pscustomobject]@{ Action=$action; Source=$source.Name; Task=$folder.Name; Reason=$reason; Destination=$destination }
    }
}
