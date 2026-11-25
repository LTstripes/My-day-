#requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $Source,

    [Parameter(Mandatory)]
    [string] $Task,

    [string] $Root = 'D:\My day',

    [string] $BaseRef = 'origin/main'
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Assert-Slug([string] $Value, [string] $Name) {
    if ($Value.Length -gt 40 -or $Value -cnotmatch '\A[a-z0-9]+(?:-[a-z0-9]+)*\z' -or
        $Value -match '\A(?:con|prn|aux|nul|com[0-9]|lpt[0-9])\z') {
        throw "Для -$Name укажите от 1 до 40 строчных латинских букв, цифр или дефисов между ними. Системные имена Windows зарезервированы."
    }
}

function Get-LocalItem([string] $Path) {
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    } catch [System.Management.Automation.ItemNotFoundException] {
        return
    }
    if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Путь указывает на ссылку или точку подключения: $Path"
    }
    return $item
}

function Assert-Directory([string] $Path) {
    $item = Get-LocalItem $Path
    if (-not $item -or -not $item.PSIsContainer) {
        throw "Ожидалась существующая папка: $Path"
    }
}

function Assert-Root([string] $Path) {
    $parent = [System.IO.Directory]::GetParent($Path)
    if ($parent) {
        Assert-Root $parent.FullName
    }
    Assert-Directory $Path
}

function Invoke-WorkspaceGit([string] $Directory, [string] $Operation, [string[]] $Arguments) {
    # Git diagnostics can include the configured origin URL.
    $ErrorActionPreference = 'Continue'
    $result = & $git -C $Directory @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Git не смог выполнить операцию «$Operation» в папке $Directory (код $LASTEXITCODE)."
    }
    return $result
}

function Assert-StandaloneCheckout([string] $Directory) {
    Assert-Directory $Directory
    $gitDirectory = Join-Path $Directory '.git'
    Assert-Directory $gitDirectory
    $objects = Join-Path $gitDirectory 'objects'
    Assert-Directory $objects
    $objectsInfo = Join-Path $objects 'info'
    Assert-Directory $objectsInfo

    if ((Get-LocalItem (Join-Path $gitDirectory 'commondir')) -or
        (Get-LocalItem (Join-Path $objectsInfo 'alternates'))) {
        throw "Репозиторий должен хранить собственные Git-данные: $Directory"
    }

    $topLevel = Invoke-WorkspaceGit $Directory 'проверка рабочей папки' @('rev-parse', '--show-toplevel')
    if ([System.IO.Path]::GetFullPath($topLevel) -ine $Directory) {
        throw "Git определил другую рабочую папку: $Directory"
    }
    if ((Invoke-WorkspaceGit $Directory 'проверка истории Git' @('rev-parse', '--is-shallow-repository')) -ne 'false') {
        throw "В репозитории должна быть полная история: $Directory"
    }
}

Assert-Slug $Source 'Source'
Assert-Slug $Task 'Task'
if ($BaseRef -cnotmatch '\Aorigin/(?<branch>[a-zA-Z0-9][a-zA-Z0-9._/-]*)\z' -or $BaseRef -ceq 'origin/HEAD') {
    throw '-BaseRef должен указывать на ветку origin, например origin/main.'
}
$baseBranch = $Matches.branch
if ($Root -notmatch '\A[a-zA-Z]:[\\/][^:]*\z') {
    throw '-Root должен быть абсолютным путём на локальном диске Windows.'
}
$rootPath = [System.IO.Path]::GetFullPath($Root)
if ($rootPath.Length -gt [System.IO.Path]::GetPathRoot($rootPath).Length) {
    $rootPath = $rootPath.TrimEnd('\', '/')
}

foreach ($name in @('GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
        'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH')) {
    if ([Environment]::GetEnvironmentVariable($name)) {
        throw "Переменная $name переопределяет расположение Git-данных. Запустите скрипт в обычном PowerShell."
    }
}
$git = (Get-Command git.exe -CommandType Application -TotalCount 1 -ErrorAction Stop).Source

Assert-Root $rootPath
$mainPath = Join-Path $rootPath 'main'
$projectsPath = Join-Path $rootPath 'projects'
Assert-StandaloneCheckout $mainPath
Assert-Directory $projectsPath

$remoteRef = "refs/remotes/$BaseRef"
Invoke-WorkspaceGit $mainPath 'проверка имени базовой ветки' @('check-ref-format', "refs/heads/$baseBranch") | Out-Null
$sourcePath = Join-Path $projectsPath $Source
$taskPath = Join-Path $sourcePath $Task
$sourceItem = Get-LocalItem $sourcePath
$existingTask = $null
if ($sourceItem) {
    Assert-Directory $sourcePath
    $existingTask = Get-LocalItem $taskPath
}

if ($existingTask) {
    $existingGit = $null
    if ($existingTask.PSIsContainer) {
        $existingGit = Get-LocalItem (Join-Path $taskPath '.git')
    }
    if ($existingGit -and $existingGit.PSIsContainer) {
        $markerPath = Join-Path $existingGit.FullName 'my-day-workspace.json'
        $marker = Get-LocalItem $markerPath
        if ($marker -and -not $marker.PSIsContainer) {
            try {
                $metadata = [System.IO.File]::ReadAllText($markerPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            } catch {
                throw "Не удалось прочитать метку рабочего каталога: $markerPath"
            }
            if ($metadata.schema -eq 1 -and $metadata.source -ceq $Source -and $metadata.task -ceq $Task) {
                Assert-StandaloneCheckout $taskPath
                Write-Output "Рабочий каталог уже существует: $taskPath"
                return
            }
        }
    }
    throw "Путь уже занят другой копией: $taskPath"
}

$originUrls = @(Invoke-WorkspaceGit $mainPath 'чтение адреса origin' @('config', '--local', '--get-all', 'remote.origin.url'))
if ($originUrls.Count -ne 1 -or $originUrls[0] -match '[\x00-\x1f"]|\A[a-zA-Z]:(?![\\/])' -or
    $originUrls[0] -notmatch '\A(?:[a-zA-Z]:[\\/]|\\\\|[a-zA-Z][a-zA-Z0-9+.-]*://|[^:\s/\\]+:)') {
    throw 'В main должен быть задан один абсолютный адрес origin.'
}

$upstreamRefspec = "+refs/heads/${baseBranch}:$remoteRef"
Invoke-WorkspaceGit $mainPath 'обновление базовой ветки из origin' @(
    'fetch', '--no-tags', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', '--no-auto-gc',
    '--no-write-fetch-head', '--refmap=', 'origin', $upstreamRefspec
) | Out-Null
$baseCommit = Invoke-WorkspaceGit $mainPath 'чтение базового коммита' @('rev-parse', '--verify', "$remoteRef^{commit}")

Assert-Root $projectsPath
if (-not (Get-LocalItem $sourcePath)) {
    [System.IO.Directory]::CreateDirectory($sourcePath) | Out-Null
}
Assert-Directory $sourcePath
if (Get-LocalItem $taskPath) {
    throw "Путь уже занят: $taskPath. Повторите запуск, чтобы проверить метку каталога."
}

# A unique sibling keeps incomplete Git data out of the final task directory.
$stagingPath = Join-Path $sourcePath ('.my-day-' + [Guid]::NewGuid().ToString('N'))
[System.IO.Directory]::CreateDirectory($stagingPath) | Out-Null
try {
    Invoke-WorkspaceGit $stagingPath 'создание отдельного репозитория' @('init', '--quiet', '--template=') | Out-Null
    Invoke-WorkspaceGit $stagingPath 'настройка origin' @('remote', 'add', '--', 'origin', $originUrls[0]) | Out-Null
    Invoke-WorkspaceGit $stagingPath 'копирование истории базовой ветки из main' @(
        'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', $mainPath, "${remoteRef}:$remoteRef"
    ) | Out-Null
    $clonedBase = Invoke-WorkspaceGit $stagingPath 'проверка скопированного коммита' @('rev-parse', '--verify', "$remoteRef^{commit}")
    if ($clonedBase -cne $baseCommit) {
        throw 'Базовая ветка изменилась во время создания рабочего каталога. Запустите скрипт ещё раз.'
    }

    $branch = "work/$Source/$Task"
    Invoke-WorkspaceGit $stagingPath 'создание рабочей ветки' @('checkout', '--quiet', '--no-track', '-b', $branch, $clonedBase) | Out-Null
    Assert-StandaloneCheckout $stagingPath

    $metadata = [ordered]@{
        schema = 1
        source = $Source
        task = $Task
        createdUtc = [DateTime]::UtcNow.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
    } | ConvertTo-Json
    $markerPath = Join-Path $stagingPath '.git\my-day-workspace.json'
    [System.IO.File]::WriteAllText($markerPath, $metadata + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

    Assert-Root $sourcePath
    [System.IO.Directory]::Move($stagingPath, $taskPath)
} catch {
    throw "$($_.Exception.Message)`nВременная копия сохранена: $stagingPath"
}

Write-Output "Рабочий каталог создан: $taskPath"
Write-Output "Ветка: $branch ($BaseRef)"
