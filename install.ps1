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

    $installDir = Join-Path $env:LOCALAPPDATA "clec\bin"
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    $exe = Join-Path $installDir "clec.exe"
    Copy-Item -Force $exeSource $exe

    $skillDir = Join-Path $HOME ".agents\skills\clec"
    New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
    $skill = Join-Path $skillDir "SKILL.md"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/SKILL.md" -OutFile $skill
    } catch {
        Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/$repo/main/skills/clec/SKILL.md" -OutFile $skill
    }
} finally {
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
