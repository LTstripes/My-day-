#requires -Version 5.1
[CmdletBinding()]
param([string]$ScratchParent = [IO.Path]::GetTempPath())

$ErrorActionPreference = 'Stop'
$runner = Join-Path (Split-Path $PSScriptRoot -Parent) 'Move-InactiveWorkspaces.ps1'
$scratchBase = (Get-Item -LiteralPath $ScratchParent).FullName
$scratch = Join-Path $scratchBase ('my-day-retention-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $scratch 'My day'
$seed = Join-Path $scratch 'synthetic-origin'
$projects = Join-Path $root 'projects\codex'
$old = [DateTime]::UtcNow.AddDays(-10)
$links = @()
$count = 0

function Invoke-TestGit([string]$At, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $out = & git -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgSign=false -C $At @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Fixture Git failed: $Arguments. $out" }
    $out
}
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:count++
}
function Add-Task([string]$Name) {
    $path = Join-Path $projects $Name
    Invoke-TestGit $scratch @('clone','--no-local','-q',$seed,$path)
    @{schema=1; source='codex'; task=$Name; createdUtc=$old.ToString('o')} | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $path '.git\my-day-workspace.json') -Encoding ASCII
    return $path
}
function Add-Commit([string]$At, [string]$Label) {
    Add-Content -LiteralPath (Join-Path $At 'note.txt') -Value $Label
    Invoke-TestGit $At @('commit','-qam',$Label)
}
function Set-OldTree([string]$Path) {
    # Called only on the private fixture, before adding junctions.
    $entries = @(Get-ChildItem -Force -LiteralPath $Path -Recurse) + @(Get-Item -Force -LiteralPath $Path)
    foreach ($entry in $entries) {
        $attributes = $entry.Attributes
        if ($attributes -band [IO.FileAttributes]::ReadOnly) {
            $entry.Attributes = $attributes -band (-bnot [IO.FileAttributes]::ReadOnly)
        }
        $entry.CreationTimeUtc = $old
        $entry.LastWriteTimeUtc = $old
        if ($entry.Attributes -ne $attributes) { $entry.Attributes = $attributes }
    }
}
function Assert-Actions($Rows, [string[]]$Eligible, [string]$Action) {
    Assert-True (@($Rows | Where-Object Action -eq $Action).Count -eq $Eligible.Count) "Unexpected $Action count: $($Rows | Out-String -Width 240)"
    foreach ($name in $tasks) {
        $row = @($Rows | Where-Object Task -eq $name)
        $expected = 'Kept'
        if ($name -in $Eligible) { $expected = $Action }
        Assert-True ($row.Count -eq 1 -and $row[0].Action -eq $expected) "Expected $name $expected. $($row | Out-String -Width 240)"
    }
}

try {
    [void][IO.Directory]::CreateDirectory($projects)
    [void][IO.Directory]::CreateDirectory($seed)
    Invoke-TestGit $seed @('init','-q','-b','main')
    Set-Content -LiteralPath (Join-Path $seed 'note.txt') -Value 'synthetic'
    $repository = Split-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) -Parent
    Copy-Item -LiteralPath (Join-Path $repository '.gitignore') -Destination $seed
    Invoke-TestGit $seed @('add','note.txt','.gitignore')
    Invoke-TestGit $seed @('commit','-qm','initial')
    Invoke-TestGit $scratch @('clone','--no-local','-q',$seed,(Join-Path $root 'main'))
    $tasks = @('merged','finished','confirmed-in-main','dirty','untracked','stash','detached','sibling','bad-stamp','keep',
        'fresh-file','fresh-git','fresh-marker','wrong-marker','collision','lock','merge','hidden','shared-tree','linked-tree','nested-link','main','test',
        'ignored-local','ignored-env','ignored-log','dependencies','nested-dependencies','foreign-origin','fresh-finish')
    $paths = @{}
    foreach ($name in $tasks) {
        if ($name -ne 'linked-tree') { $paths[$name] = Add-Task $name }
    }
    foreach ($name in @('finished','detached','sibling','bad-stamp','confirmed-in-main')) {
        Invoke-TestGit $paths[$name] @('switch','-qc','feature')
        Add-Commit $paths[$name] $name
    }
    $sha = Invoke-TestGit $paths.finished @('rev-parse','HEAD')
    Set-Content -LiteralPath (Join-Path $paths.finished '.git\my-day-finished') -Value $sha
    Set-Content -LiteralPath (Join-Path $paths.'bad-stamp' '.git\my-day-finished') -Value $sha
    Invoke-TestGit $paths.detached @('checkout','-q','--detach')
    Invoke-TestGit $paths.detached @('branch','-D','feature') | Out-Null
    Invoke-TestGit $paths.sibling @('switch','-q','main')
    Invoke-TestGit $paths.sibling @('rev-parse','HEAD') | Set-Content -LiteralPath (Join-Path $paths.sibling '.git\my-day-finished')
    Invoke-TestGit $seed @('fetch','-q',$paths.'confirmed-in-main','feature')
    Invoke-TestGit $seed @('merge','-q','--ff-only','FETCH_HEAD') | Out-Null
    Invoke-TestGit (Join-Path $root 'main') @('fetch','-q','origin')
    foreach ($name in @('dirty','stash','hidden')) { Add-Content -LiteralPath (Join-Path $paths[$name] 'note.txt') -Value 'edit' }
    Invoke-TestGit $paths.stash @('stash','push','-q')
    Invoke-TestGit $paths.hidden @('update-index','--assume-unchanged','note.txt')
    Set-Content -LiteralPath (Join-Path $paths.untracked 'draft.txt') -Value 'unsaved'
    Set-Content -LiteralPath (Join-Path $paths.keep '.git\my-day-keep') -Value ''
    Set-Content -LiteralPath (Join-Path $paths.lock '.git\index.lock') -Value ''
    [void][IO.Directory]::CreateDirectory((Join-Path $paths.'ignored-local' '.local'))
    Set-Content -LiteralPath (Join-Path $paths.'ignored-local' '.local\draft.txt') -Value 'synthetic local note'
    Set-Content -LiteralPath (Join-Path $paths.'ignored-env' '.env') -Value 'SYNTHETIC=fixture'
    Set-Content -LiteralPath (Join-Path $paths.'ignored-log' 'fixture.log') -Value 'synthetic log'
    [void][IO.Directory]::CreateDirectory((Join-Path $paths.dependencies 'node_modules\fixture'))
    Set-Content -LiteralPath (Join-Path $paths.dependencies 'node_modules\fixture\index.js') -Value 'export {}'
    [void][IO.Directory]::CreateDirectory((Join-Path $paths.'nested-dependencies' 'sub\node_modules'))
    Set-Content -LiteralPath (Join-Path $paths.'nested-dependencies' 'sub\node_modules\note.txt') -Value 'synthetic nested file'
    Invoke-TestGit $paths.'foreign-origin' @('remote','set-url','origin',(Join-Path $scratch 'another-origin'))
    Invoke-TestGit $paths.'foreign-origin' @('rev-parse','HEAD') | Set-Content -LiteralPath (Join-Path $paths.'foreign-origin' '.git\my-day-finished')
    Invoke-TestGit $paths.merge @('rev-parse','HEAD') | Set-Content -LiteralPath (Join-Path $paths.merge '.git\MERGE_HEAD')
    foreach ($name in @('fresh-marker','wrong-marker')) {
        $file = Join-Path $paths[$name] '.git\my-day-workspace.json'
        $mark = Get-Content -Raw -LiteralPath $file | ConvertFrom-Json
        if ($name -eq 'fresh-marker') { $mark.createdUtc = [datetime]::UtcNow.ToString('o') } else { $mark.source = 'wrong' }
        $mark | ConvertTo-Json | Set-Content -LiteralPath $file
    }
    Invoke-TestGit $paths.'shared-tree' @('worktree','add','-q','--detach',(Join-Path $projects 'linked-tree'))
    $quarantine = Join-Path $root ('quarantine\' + (Get-Date -Format yyyy-MM-dd) + '\codex')
    $outside = Join-Path $scratch 'outside'
    [void][IO.Directory]::CreateDirectory($outside)
    Set-OldTree $projects
    (Get-Item -LiteralPath (Join-Path $paths.'fresh-file' 'note.txt')).LastWriteTimeUtc = [DateTime]::UtcNow
    (Get-Item -LiteralPath (Join-Path $paths.'fresh-git' '.git\logs\HEAD')).LastWriteTimeUtc = [DateTime]::UtcNow
    Invoke-TestGit $paths.'fresh-finish' @('rev-parse','HEAD') | Set-Content -LiteralPath (Join-Path $paths.'fresh-finish' '.git\my-day-finished')
    Set-Content -LiteralPath (Join-Path $paths.merged '.git\FETCH_HEAD') -Value 'synthetic background fetch'
    $link = Join-Path $paths.'nested-link' 'outside'
    [void](New-Item -ItemType Junction -Path $link -Target $outside)
    $links += $link
    (Get-Item -LiteralPath $paths.'nested-link').LastWriteTimeUtc = $old

    $eligible = @('merged','finished','confirmed-in-main','dependencies')
    $preview = @(& $runner -Root $root)
    Assert-Actions $preview ($eligible + @('collision')) 'WouldMove'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $root 'quarantine'))) 'Dry run created the quarantine.'
    Assert-True (($preview | Where-Object Task -eq 'nested-link').Reason -match 'linked') 'Nested junction check was skipped.'
    Assert-True (($preview | Where-Object Task -eq 'foreign-origin').Reason -match 'Origin differs') 'Approved a foreign clone.'
    Assert-True (($preview | Where-Object Task -eq 'fresh-finish').Reason -match 'Recent') 'New completion stamp did not restart the clock.'
    foreach ($name in @('ignored-local','ignored-env','ignored-log','nested-dependencies')) {
        Assert-True (($preview | Where-Object Task -eq $name).Reason -match 'ignored local') "Unknown ignored file was missed: $name"
    }
    $main = Join-Path $root 'main'
    $mainAside = Join-Path $root 'main-aside'
    [IO.Directory]::Move($main, $mainAside)
    try {
        $withoutMain = @(& $runner -Root $root -Apply)
        Assert-True (@($withoutMain | Where-Object Action -eq 'Moved').Count -eq 0) 'Unverified main allowed a move.'
        Assert-True (-not (Test-Path -LiteralPath (Join-Path $root 'quarantine'))) 'Missing primary clone created quarantine.'
    } finally { [IO.Directory]::Move($mainAside, $main) }

    $redirect = Join-Path $root 'quarantine'
    [void](New-Item -ItemType Junction -Path $redirect -Target $outside)
    $links += $redirect
    $blocked = @(& $runner -Root $root -Apply)
    Assert-True (@($blocked | Where-Object Action -eq 'Moved').Count -eq 0) 'Moved through a quarantine junction.'
    Assert-True (@(Get-ChildItem -Force -LiteralPath $outside).Count -eq 0) 'Wrote outside quarantine.'
    [IO.Directory]::Delete($redirect)
    $links = @($link)
    $occupied = Join-Path $quarantine 'collision'
    [void][IO.Directory]::CreateDirectory($occupied)
    Set-Content -LiteralPath (Join-Path $occupied 'sentinel') -Value 'unchanged'
    $applied = @(& $runner -Root $root -Apply)
    Assert-Actions $applied $eligible 'Moved'
    foreach ($name in $eligible) {
        $dest = Join-Path $quarantine $name
        Assert-True (-not (Test-Path -LiteralPath $paths[$name])) "Original still present: $name"
        Assert-True (Test-Path -LiteralPath (Join-Path $dest '.git\my-day-workspace.json')) "Quarantined clone is incomplete: $name"
        Assert-True ([bool](Invoke-TestGit $dest @('rev-parse','--verify','HEAD'))) "Invalid preserved Git data: $name"
    }
    Assert-True ((Get-Content -LiteralPath (Join-Path $occupied 'sentinel')) -eq 'unchanged') 'Collision was overwritten.'
    Assert-True (@(& $runner -Root $root -Apply | Where-Object Action -eq 'Moved').Count -eq 0) 'Second run moved extra work.'
    # Insert a Git operation after eligibility was established, with no sleeps or timing assumptions.
    $race = Add-Task 'race'
    Set-OldTree $race
    $raceLock = Join-Path $race '.git\index.lock'
    $breakpoint = Set-PSBreakpoint -Script $runner -Command Get-QuarantineTarget -Action {
        if ($folder.Name -eq 'race') { [IO.File]::WriteAllText($raceLock, 'fixture') }
    }
    try {
        $row = & $runner -Root $root -Apply | Where-Object Task -eq 'race'
    } finally { Remove-PSBreakpoint -Breakpoint $breakpoint }
    Assert-True (Test-Path -LiteralPath $raceLock) 'Fixture did not start the concurrent Git operation.'
    Assert-True ($row.Action -eq 'Kept' -and $row.Reason -match 'lock') 'Move ignored the new Git operation.'
    Write-Output "PASS: $count retention assertions on PowerShell $($PSVersionTable.PSVersion)."
} finally {
    # Remove only the unique test directory and its known fixture junctions.
    $fullScratch = [IO.Path]::GetFullPath($scratch)
    if ([IO.Path]::GetDirectoryName($fullScratch) -eq $scratchBase.TrimEnd('\') -and
        [IO.Path]::GetFileName($fullScratch) -match '^my-day-retention-[a-f0-9]{32}$') {
        foreach ($link in $links) {
            if ([IO.Directory]::Exists($link)) { [IO.Directory]::Delete($link) }
        }
        if (Test-Path -LiteralPath $fullScratch) { Remove-Item -LiteralPath $fullScratch -Recurse -Force }
    }
}
