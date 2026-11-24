# AI Hub's packaged Windows installer. No compiler or administrator needed.
# Internal executable and icon names stay compatible with the upstream app.
function Install-AIHubPayload($Source, $Destination) {
    $ErrorActionPreference = "Stop"
    $Source = [IO.Path]::GetFullPath($Source)
    $Destination = [IO.Path]::GetFullPath($Destination)
    foreach ($name in @("herdr-app.exe", "herdr-app.svg", "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES")) {
        if (-not (Test-Path -LiteralPath (Join-Path $Source $name) -PathType Leaf)) {
            throw "AI Hub package is incomplete: $name is missing. Extract the entire ZIP first."
        }
    }
    if ($Source.TrimEnd("\") -ieq $Destination.TrimEnd("\")) { return }
    $stage = "$Destination.install-$([guid]::NewGuid().ToString('N'))"
    $backup = "$Destination.old-$([guid]::NewGuid().ToString('N'))"
    $installed = $false
    try {
        New-Item -ItemType Directory -Path $stage -Force | Out-Null
        Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $stage -Recurse -Force
        if (Test-Path -LiteralPath $Destination) {
            Rename-Item -LiteralPath $Destination -NewName (Split-Path $backup -Leaf)
        }
        try {
            Rename-Item -LiteralPath $stage -NewName (Split-Path $Destination -Leaf)
        } catch {
            $installError = $_
            if (Test-Path -LiteralPath $backup) {
                try { Rename-Item -LiteralPath $backup -NewName (Split-Path $Destination -Leaf) }
                catch { throw "Installation failed: $installError. Previous files remain at ${backup}: $_" }
            }
            throw $installError
        }
        $installed = $true
    } finally {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
        if ($installed -and (Test-Path -LiteralPath $backup)) {
            try { Remove-Item -LiteralPath $backup -Recurse -Force }
            catch { Write-Warning "Previous build remains at $backup. Remove it after quitting AI Hub." }
        }
    }
}

# Tests can load the transactional file operation without touching the desktop.
if ($MyInvocation.InvocationName -eq '.') { return }
$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "This installer requires Windows." }
$dir = Join-Path $env:LOCALAPPDATA "Programs\AI-Hub"
Install-AIHubPayload $PSScriptRoot $dir

$menu = Join-Path ([Environment]::GetFolderPath("Programs")) "AI Hub.lnk"
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($menu)
$link.TargetPath = Join-Path $dir "herdr-app.exe"
$link.WorkingDirectory = $env:USERPROFILE
$link.Description = "AI Hub - terminals and coding agents"
$link.Save()

# Preserve literal variables and the registry value type in the user's PATH.
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
try {
    $raw = [string]$key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $listed = $raw -split ";" | Where-Object { $_.Trim().TrimEnd("\") -ieq $dir.TrimEnd("\") }
    if (-not $listed) {
        $kind = if ($key.GetValueNames() -contains "Path") { $key.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $key.SetValue("Path", $(if ($raw) { "$($raw.TrimEnd(';'));$dir" } else { $dir }), $kind)
        [Environment]::SetEnvironmentVariable("AI_HUB_INSTALLING", "1", "User")
        [Environment]::SetEnvironmentVariable("AI_HUB_INSTALLING", $null, "User")
    }
} finally { $key.Close() }
if (($env:Path -split ";") -notcontains $dir) { $env:Path += ";$dir" }

# Runtime releases stay separate from AI Hub's application feed.
$core = Join-Path $env:LOCALAPPDATA "Programs\herdr-core\herdr-core.exe"
if (-not (Test-Path $core) -and -not (Get-Command herdr-core -ErrorAction SilentlyContinue)) {
    $coreReleases = if ($env:HERDR_RELEASES_URL) { $env:HERDR_RELEASES_URL.TrimEnd("/") } else { "https://releases.herdr.dev" }
    try { Invoke-RestMethod "$coreReleases/core/install.ps1" | Invoke-Expression }
    catch { Write-Warning "herdr-core did not install. AI Hub will offer it when it opens." }
}
Write-Host "AI Hub is installed. Open AI Hub from the Start menu."
