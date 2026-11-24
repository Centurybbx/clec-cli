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
$lockStream = $null
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

    $lockPath = Join-Path $skillDir ".clec-lock"
    try {
        $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::DeleteOnClose)
    } catch [System.IO.IOException] {
        throw "install lock exists at $lockPath; if no installer is running, remove it and retry"
    }
    $lockBytes = [System.Text.Encoding]::UTF8.GetBytes("$PID")
    $lockStream.Write($lockBytes, 0, $lockBytes.Length)
    $lockStream.Flush()

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
    if ($lockStream) {
        $lockStream.Close()
        $lockStream = $null
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
    if ($lockStream) {
        $lockStream.Close()
        $lockStream = $null
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
