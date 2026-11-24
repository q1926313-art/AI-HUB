# Modified for AI Hub: verify replacement in the fork's install directory.
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\install-windows.ps1"

function Assert($Condition, $Message) {
    if (-not $Condition) { throw $Message }
}

$tmp = Join-Path ([IO.Path]::GetTempPath()) "herdr-install-test-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
    $binary = Join-Path $tmp "build.exe"
    $icon = Join-Path $tmp "icon.svg"
    $destination = Join-Path $tmp "Programs\AI-Hub"
    Set-Content -LiteralPath $binary -Value "first build"
    Set-Content -LiteralPath $icon -Value "icon"
    Install-HerdrAppFiles $binary $icon $destination
    Assert ((Get-Content "$destination\herdr-app.exe") -eq "first build") "First install lost the binary"
    Assert ((Get-Content "$destination\herdr-app.svg") -eq "icon") "First install lost the icon"

    Set-Content -LiteralPath $binary -Value "new build"
    Install-HerdrAppFiles $binary $icon $destination
    Assert ((Get-Content "$destination\herdr-app.exe") -eq "new build") "Replacement kept the old binary"
    Assert ((Get-ChildItem (Split-Path $destination)).Count -eq 1) "Replacement left temporary files"

    # Fail the promotion, then the rollback too, using real moves otherwise.
    function Rename-Item {
        param($LiteralPath, $NewName)
        $script:moves++
        if ($script:failMoves -contains $script:moves) { throw "injected move failure $script:moves" }
        Microsoft.PowerShell.Management\Rename-Item -LiteralPath $LiteralPath -NewName $NewName
    }
    foreach ($failures in @(@(2), @(2, 3))) {
        $script:moves = 0
        $script:failMoves = $failures
        $errorText = $null
        try { Install-HerdrAppFiles $binary $icon $destination }
        catch { $errorText = $_.ToString() }
        Assert ($null -ne $errorText) "Failed installation reported success"
        if ($failures.Count -eq 1) {
            Assert ((Get-Content "$destination\herdr-app.exe") -eq "new build") "Rollback lost the previous build"
        } else {
            $backup = Get-ChildItem (Split-Path $destination) -Directory -Filter "AI-Hub.old-*"
            Assert ($backup.Count -eq 1) "Failed rollback lost the backup"
            Assert ($errorText.Contains($backup.FullName)) "Failed rollback did not report the backup path"
            Assert ((Get-Content "$($backup.FullName)\herdr-app.exe") -eq "new build") "Failed rollback damaged the backup"
        }
        Assert (-not (Get-ChildItem (Split-Path $destination) -Directory -Filter "AI-Hub.install-*")) "Failed install left staging files"
    }
    Write-Host "Installer file replacement and rollback checks passed."
} finally {
    Remove-Item Function:Rename-Item -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tmp -Recurse -Force
}

# The ZIP installer must preserve notices and reject an incomplete extraction
# before touching a previously installed build. These checks stay in temp dirs.
. "$PSScriptRoot\..\distribution\install-local.ps1"
$tmp = Join-Path ([IO.Path]::GetTempPath()) "ai-hub-payload-test-$([guid]::NewGuid().ToString('N'))"
$source = Join-Path $tmp "package"
$destination = Join-Path $tmp "Programs\AI-Hub"
New-Item -ItemType Directory -Path $source -Force | Out-Null
try {
    foreach ($name in @("herdr-app.exe", "herdr-app.svg", "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES", "Install.ps1", "Install.cmd")) {
        Set-Content -LiteralPath (Join-Path $source $name) -Value "payload $name"
    }
    Install-AIHubPayload $source $destination
    Assert ((Get-Content "$destination\NOTICE") -eq "payload NOTICE") "ZIP installer lost fork attribution"
    Assert (Test-Path "$destination\Install.cmd") "ZIP installer lost its shortcut installer"
    Set-Content -LiteralPath "$source\herdr-app.exe" -Value "updated binary"
    Install-AIHubPayload $source $destination
    Assert ((Get-Content "$destination\herdr-app.exe") -eq "updated binary") "ZIP installer kept the old build"
    Remove-Item -LiteralPath "$source\NOTICE"
    $errorText = $null
    try { Install-AIHubPayload $source $destination } catch { $errorText = $_.ToString() }
    Assert ($errorText -and $errorText.Contains("NOTICE is missing")) "Incomplete extraction was accepted"
    Assert ((Get-Content "$destination\herdr-app.exe") -eq "updated binary") "Incomplete extraction changed the installed build"
    Write-Host "Packaged AI Hub installer integrity checks passed."
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force
}
