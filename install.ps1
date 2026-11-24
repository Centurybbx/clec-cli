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
$staged = $null

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
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $exe = Join-Path $installDir "clec.exe"
    $staged = Join-Path $installDir (".clec.tmp.$PID.exe")
    Copy-Item -Force $exeSource $staged
    try {
        Move-Item -LiteralPath $staged -Destination $exe -Force
    } catch {
        Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
        Move-Item -LiteralPath $staged -Destination $exe -Force
    }

    $skillDir = Join-Path $HOME ".agents\skills\clec"
    New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
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
    Remove-Item -LiteralPath $skill -Force -ErrorAction SilentlyContinue
    Copy-Item -Force $skillSource $skill
} finally {
    if ($staged -and (Test-Path -LiteralPath $staged)) {
        Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
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
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($userPath -split ';') -contains $installDir)) {
    Write-Host "Add $installDir to PATH to run clec from any terminal."
}
