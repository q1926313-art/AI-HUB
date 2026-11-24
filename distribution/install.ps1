# Modified for AI Hub: download only this fork's GitHub release; herdr-core
# remains a separate upstream runtime installed by the packaged installer.
#
# powershell -c "irm https://github.com/q1926313-art/AI-HUB/releases/latest/download/install.ps1 | iex"
# AI_HUB_RELEASES_URL overrides the directory containing latest.json.

# Keep variables out of the caller's session when used through `irm | iex`.
& {
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
function Fail($why) { throw "AI Hub: $why" }

$releases = if ($env:AI_HUB_RELEASES_URL) { $env:AI_HUB_RELEASES_URL.TrimEnd("/") } else { "https://github.com/q1926313-art/AI-HUB/releases/latest/download" }
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($arch -ne "AMD64") { Fail "no build for $arch Windows yet (x64 only)" }
$target = "windows-x86_64"
$tar = Join-Path $env:SystemRoot "System32\tar.exe"
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue) -or -not (Test-Path $tar)) {
    Fail "needs curl.exe and tar.exe (Windows 10 1803 or newer)"
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) "ai-hub-install-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    curl.exe -fsSL "$releases/latest.json" -o "$tmp\latest.json"
    if ($LASTEXITCODE) { Fail "cannot read an AI Hub release at $releases" }
    $manifest = Get-Content -Raw "$tmp\latest.json" | ConvertFrom-Json
    $targetRelease = $manifest.targets.$target
    if (-not $targetRelease.url -or -not $targetRelease.sha256) { Fail "no build for $target yet" }
    Write-Host "Installing AI Hub $($manifest.version) for $target..."
    # Use the exact immutable asset URL from the manifest, including any query.
    curl.exe -fsSL $targetRelease.url -o "$tmp\app.tar.gz"
    if ($LASTEXITCODE) { Fail "download failed: $($targetRelease.url)" }
    $stream = [IO.File]::OpenRead("$tmp\app.tar.gz")
    try { $got = -join ([Security.Cryptography.SHA256]::Create().ComputeHash($stream) | ForEach-Object { $_.ToString("x2") }) } finally { $stream.Close() }
    if ($got -ne $targetRelease.sha256) { Fail "the download is damaged (checksum mismatch); try again" }
    & $tar -xzf "$tmp\app.tar.gz" -C $tmp
    $installer = Join-Path $tmp "herdr-app\Install.ps1"
    if ($LASTEXITCODE -or -not (Test-Path "$tmp\herdr-app\herdr-app.exe") -or -not (Test-Path $installer)) {
        Fail "the download holds no complete AI Hub app"
    }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
    if ($LASTEXITCODE) { Fail "the local installer failed (exit $LASTEXITCODE)" }
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
}
