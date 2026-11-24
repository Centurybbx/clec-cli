#Requires -Version 5.1
# clec one-line installer for Windows.
$ErrorActionPreference = "Stop"

$repo = "Centurybbx/clec-cli"
if ($env:CLEC_VERSION) {
    $tag = $env:CLEC_VERSION
    if (-not $tag.StartsWith("v")) { $tag = "v$tag" }
    $base = "https://github.com/$repo/releases/download/$tag"
} else {
    $base = "https://github.com/$repo/releases/latest/download"
}

$target = "x86_64-pc-windows-msvc"
$archiveName = "clec-$target.zip"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("clec-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmp | Out-Null
$stagedExe = $null
$stagedSkill = $null
$backupSkill = $null
$lockDir = $null
$lockOwner = "$PID-" + [guid]::NewGuid().ToString("N")
$keepBackup = $false

try {
    $archive = Join-Path $tmp $archiveName
    $sums = Join-Path $tmp "SHA256SUMS.txt"
    Write-Host "Downloading $archiveName ..."
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$archiveName" -OutFile $archive
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS.txt" -OutFile $sums

    $pattern = "\s\*?$([regex]::Escape($archiveName))$"
    $line = Get-Content $sums | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if (-not $line) { throw "no checksum for $archiveName in SHA256SUMS.txt" }
    $expected = ($line -split '\s+')[0].ToUpperInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToUpperInvariant()
    if ($actual -ne $expected) {
        throw "checksum mismatch for $archiveName (expected $expected, got $actual)"
    }

    $dist = Join-Path $tmp "dist"
    Expand-Archive -Path $archive -DestinationPath $dist -Force
    $exeSource = Join-Path $dist "clec.exe"
    if (-not (Test-Path $exeSource)) { throw "archive did not contain clec.exe" }

    $installDir = $env:CLEC_INSTALL_DIR
    if (-not $installDir) { $installDir = Join-Path $env:LOCALAPPDATA "clec\bin" }
    $skillDir = Join-Path $HOME ".agents\skills\clec"
    New-Item -ItemType Directory -Force -Path $installDir, $skillDir | Out-Null

    $exe = Join-Path $installDir "clec.exe"
    $stagedExe = Join-Path $installDir (".clec.tmp.$PID.exe")
    Copy-Item -Force $exeSource $stagedExe

    $skillSource = Join-Path $tmp "SKILL.md"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SKILL.md" -OutFile $skillSource
    $skillPattern = "\s\*?SKILL\.md$"
    $skillLine = Get-Content $sums | Where-Object { $_ -match $skillPattern } | Select-Object -First 1
    if (-not $skillLine) { throw "no checksum for SKILL.md in SHA256SUMS.txt" }
    $skillExpected = ($skillLine -split '\s+')[0].ToUpperInvariant()
    $skillActual = (Get-FileHash -Algorithm SHA256 -Path $skillSource).Hash.ToUpperInvariant()
    if ($skillActual -ne $skillExpected) {
        throw "checksum mismatch for SKILL.md (expected $skillExpected, got $skillActual)"
    }
    $skill = Join-Path $skillDir "SKILL.md"
    $stagedSkill = Join-Path $skillDir (".SKILL.md.tmp.$PID")
    Copy-Item -Force $skillSource $stagedSkill

    $lockCandidate = Join-Path $skillDir ".clec-lock"
    if (Test-Path -LiteralPath $lockCandidate) {
        throw "install lock exists at $lockCandidate; if no installer is running, remove it and retry"
    }
    New-Item -ItemType Directory -Path $lockCandidate -ErrorAction Stop | Out-Null
    Set-Content -LiteralPath (Join-Path $lockCandidate "owner") -Value $lockOwner
    $lockDir = $lockCandidate

    $nullString = [System.Management.Automation.Language.NullString]::Value
    $skillExisted = Test-Path -LiteralPath $skill
    if ($skillExisted) {
        $backupSkill = Join-Path $skillDir (".SKILL.md.old.$PID")
        Copy-Item -Force $skill $backupSkill
        [System.IO.File]::Replace($stagedSkill, $skill, $nullString)
    } else {
        [System.IO.File]::Move($stagedSkill, $skill)
    }

    try {
        if (Test-Path -LiteralPath $exe) {
            [System.IO.File]::Replace($stagedExe, $exe, $nullString)
        } else {
            [System.IO.File]::Move($stagedExe, $exe)
        }
    } catch {
        $installError = $_
        $rollbackError = $null
        try {
            if ($skillExisted -and $backupSkill -and (Test-Path -LiteralPath $backupSkill)) {
                Copy-Item -Force $backupSkill $skill -ErrorAction Stop
            } elseif (-not $skillExisted -and (Test-Path -LiteralPath $skill)) {
                Remove-Item -LiteralPath $skill -Force -ErrorAction Stop
            }
        } catch {
            $rollbackError = $_
            $keepBackup = $true
        }
        if ($rollbackError) {
            [Console]::Error.WriteLine("clec install failed: $($installError.Exception.Message)")
            [Console]::Error.WriteLine("rollback also failed: $($rollbackError.Exception.Message)")
            if ($backupSkill) { [Console]::Error.WriteLine("previous skill backup kept at: $backupSkill") }
        }
        throw $installError
    }

    if ($backupSkill -and (Test-Path -LiteralPath $backupSkill)) {
        Remove-Item -LiteralPath $backupSkill -Force -ErrorAction SilentlyContinue
    }
    if ($lockDir -and (Test-Path -LiteralPath $lockDir)) {
        $owner = Get-Content (Join-Path $lockDir "owner") -ErrorAction SilentlyContinue
        if ($owner -eq $lockOwner) {
            Remove-Item -LiteralPath $lockDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        $lockDir = $null
    }
} finally {
    foreach ($path in @($stagedExe, $stagedSkill)) {
        if ($path -and (Test-Path -LiteralPath $path)) {
            Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
        }
    }
    if (-not $keepBackup -and $backupSkill -and (Test-Path -LiteralPath $backupSkill)) {
        Remove-Item -LiteralPath $backupSkill -Force -ErrorAction SilentlyContinue
    }
    if ($lockDir -and (Test-Path -LiteralPath $lockDir)) {
        $owner = Get-Content (Join-Path $lockDir "owner") -ErrorAction SilentlyContinue
        if ($owner -eq $lockOwner) {
            Remove-Item -LiteralPath $lockDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if ($env:CLEC_SKIP_SYNC -ne "1") {
    Write-Host "Downloading the latest index ..."
    & $exe sync
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "clec sync failed; run '$exe sync' later to install the index."
    }
}

Write-Host "Installed clec to $exe"
Write-Host "Installed agent skill to $skill"
Write-Host "Verify with: $exe stats"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -and (-not (($userPath -split ';') -contains $installDir))) {
    Write-Host "Add $installDir to PATH to run clec from any terminal."
}
