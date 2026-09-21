$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_ENVIRONMENT -ne "github-hosted" `
  -or $env:GITHUB_REPOSITORY -ne "qinghui316/beaver-code" `
  -or $env:GITHUB_REF -notin @("refs/heads/master", "refs/heads/codex/aho-windows-github-independent-update-signing-v1", "refs/heads/codex/aho-windows-desktop-update-auto-relaunch-v1") `
  -or $env:GITHUB_SHA -ne $env:BEAVER_UPDATE_ACCEPTANCE_SHA `
  -or $env:RUNNER_OS -ne "Windows" -or $env:BEAVER_UPDATE_ACCEPTANCE -ne "1") {
  throw "Windows update acceptance is restricted to a disposable GitHub-hosted Windows runner."
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$runnerRoot = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path
$acceptanceRoot = Join-Path $runnerRoot "beaver-update-acceptance"
$oldRoot = Join-Path $acceptanceRoot "old"
$newRoot = Join-Path $acceptanceRoot "new"
$installRoot = Join-Path $acceptanceRoot "installed with spaces"
$fixtureHome = Join-Path $env:USERPROFILE ".beaver-code-update-test\data"
$fixtureProject = Join-Path $acceptanceRoot "project"
$feedReady = Join-Path $acceptanceRoot "feed-ready.txt"
$resultPath = Join-Path $acceptanceRoot "result.json"
$codePfx = Join-Path $acceptanceRoot "code-signing.pfx"
$tlsPfx = Join-Path $acceptanceRoot "localhost-tls.pfx"
$publisher = "CN=BeaverCodeUpdateTest-$($env:GITHUB_RUN_ID)"
$tlsSubject = "CN=BeaverCodeUpdateTLS-$($env:GITHUB_RUN_ID)"
$rootSubject = "CN=BeaverCodeUpdateRoot-$($env:GITHUB_RUN_ID)"
$feedPort = 8443
$feedUrl = "https://localhost:$feedPort/"
$oldVersion = "0.1.2"
$newVersion = "0.1.3"
$codeCert = $null
$tlsCert = $null
$feedProcess = $null
$certificateThumbprints = @()
$certificateSubjects = @($publisher, $tlsSubject, $rootSubject)
$passedResult = $null
$script:updateInstallerProcess = $null

function Assert-RunnerChild([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path)
  $prefix = $runnerRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Acceptance target is outside RUNNER_TEMP."
  }
  return $full
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code ${LASTEXITCODE}: $Command" }
}

function Add-MachineCertificate(
  [Security.Cryptography.X509Certificates.X509Certificate2]$Certificate,
  [string]$StoreName
) {
  $store = [Security.Cryptography.X509Certificates.X509Store]::new(
    $StoreName,
    [Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
  )
  try {
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $store.Add($Certificate)
  } finally {
    $store.Close()
    $store.Dispose()
  }
}

function Invoke-HiddenProcess([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds, [string]$Label) {
  $logToken = [Guid]::NewGuid().ToString("N")
  $stdoutPath = Join-Path $acceptanceRoot "process-$logToken.stdout.log"
  $stderrPath = Join-Path $acceptanceRoot "process-$logToken.stderr.log"
  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "$Label exceeded its ${TimeoutSeconds}-second limit."
    }
    if ($process.ExitCode -ne 0) {
      foreach ($path in @($stdoutPath, $stderrPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        foreach ($line in @(Get-Content -LiteralPath $path -Tail 120 -Encoding UTF8)) {
          $safeLine = [string]$line
          if ($passwordText) { $safeLine = $safeLine.Replace($passwordText, "[REDACTED]") }
          Write-Output $safeLine
        }
      }
      throw "$Label failed with exit code $($process.ExitCode)."
    }
  } finally {
    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Wait-Until([scriptblock]$Condition, [int]$TimeoutSeconds, [string]$Failure) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    if (& $Condition) { return }
    [System.Threading.Thread]::Sleep(1000)
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $Failure
}

function Get-AcceptanceProcesses {
  @(Get-Process -Name "BeaverCodeUpdateTest" -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and [System.IO.Path]::GetFullPath($_.Path).StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase) }
    catch { $false }
  })
}

function Get-AcceptanceMainProcesses {
  @(Get-CimInstance Win32_Process -Filter "Name='BeaverCodeUpdateTest.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.Equals($installedExecutable, [System.StringComparison]::OrdinalIgnoreCase) `
      -and $_.CommandLine -notmatch '--type='
  })
}

function Capture-UpdateInstallerProcess {
  if ($script:updateInstallerProcess) { return }
  $matches = @(Get-CimInstance Win32_Process -Filter "Name='$newInstallerName'" -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -match '--updated' -and $_.CommandLine -match '/S'
  })
  if ($matches.Count -gt 1) { throw "More than one update installer started." }
  if ($matches.Count -eq 1) {
    $script:updateInstallerProcess = [System.Diagnostics.Process]::GetProcessById($matches[0].ProcessId)
    $null = $script:updateInstallerProcess.Handle
  }
}

function Stop-AcceptanceApplication([bool]$RequireGraceful) {
  $processes = @(Get-AcceptanceProcesses)
  if ($processes.Count -eq 0) { return }
  $requested = $false
  foreach ($process in $processes) {
    try { if ($process.CloseMainWindow()) { $requested = $true } } catch { }
  }
  if ($RequireGraceful -and -not $requested) { throw "The installed acceptance app did not expose a closable main window." }
  $deadline = [DateTime]::UtcNow.AddSeconds(35)
  do {
    if (@(Get-AcceptanceProcesses).Count -eq 0) { return }
    [System.Threading.Thread]::Sleep(1000)
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($RequireGraceful) { throw "The installed acceptance app did not complete graceful shutdown." }
  foreach ($process in @(Get-AcceptanceProcesses)) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}

function Install-TestPackage([string]$Installer) {
  $arguments = @("/S", "/currentuser", "/D=$installRoot")
  Invoke-HiddenProcess $Installer $arguments 180 "NSIS installation"
}

function Verify-Fixture([string]$ElectronExecutable, [string]$RuntimeRoot) {
  $previous = $env:ELECTRON_RUN_AS_NODE
  try {
    $env:ELECTRON_RUN_AS_NODE = "1"
    Invoke-Checked $ElectronExecutable @(
      (Join-Path $repoRoot "scripts\desktop-update-acceptance-fixture.mjs"),
      "verify", $fixtureHome, $fixtureProject, $RuntimeRoot
    )
  } finally {
    if ($null -eq $previous) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    else { $env:ELECTRON_RUN_AS_NODE = $previous }
  }
}

function Start-And-AssertHealthy([string]$Executable, [string]$ExpectedVersion, [string]$ExpectedCommit) {
  $desktopLog = Join-Path $env:USERPROFILE ".beaver-code-update-test\desktop\desktop.log"
  if (Test-Path -LiteralPath $desktopLog -PathType Leaf) { Remove-Item -LiteralPath $desktopLog -Force }
  # Repair/reinstall acceptance must exercise the real window-close lifecycle.
  # A hidden top-level window does not expose a reliable CloseMainWindow handle.
  $process = Start-Process -FilePath $Executable -PassThru
  Wait-Until {
    if (-not (Test-Path -LiteralPath $desktopLog -PathType Leaf)) { return $false }
    $content = Get-Content -LiteralPath $desktopLog -Raw -Encoding UTF8
    return $content.Contains("workbench-ready version=$ExpectedVersion commit=$ExpectedCommit")
  } 120 "The installed application did not load its packaged Workbench runtime."
  return $process
}

function Write-SafeUpdateLogEvidence {
  $desktopLog = Join-Path $env:USERPROFILE ".beaver-code-update-test\desktop\desktop.log"
  if (-not (Test-Path -LiteralPath $desktopLog -PathType Leaf)) {
    Write-Output "acceptance-update-log: [missing]"
    return
  }
  $paths = @($repoRoot, $acceptanceRoot, $installRoot, $env:USERPROFILE) | Where-Object { $_ }
  $lines = @(Get-Content -LiteralPath $desktopLog -Tail 120 -Encoding UTF8 | Where-Object {
    $_ -match " (build|workbench-ready|update|update-failed|startup-failed|utility-exit) "
  })
  foreach ($line in $lines) {
    $safe = $line
    foreach ($path in $paths) { $safe = $safe.Replace($path, "[PATH]") }
    Write-Output "acceptance-update-log: $safe"
  }
}

function Get-PersistedDataDigest {
  $files = @(Get-ChildItem -LiteralPath $fixtureHome -Recurse -File | Sort-Object FullName)
  if ($files.Count -eq 0) { throw "The acceptance data root is empty." }
  $parts = foreach ($file in $files) {
    "$($file.FullName.Substring($fixtureHome.Length)):$((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash)"
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($parts -join "`n"))
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
}

try {
  $null = Assert-RunnerChild $acceptanceRoot
  if (-not (Test-Path -LiteralPath $acceptanceRoot -PathType Container) `
    -or (Test-Path -LiteralPath (Split-Path -Parent $fixtureHome))) { throw "The disposable acceptance roots are invalid." }
  foreach ($path in @($codePfx, $tlsPfx, (Join-Path $acceptanceRoot "root-ca.cer"), `
    (Join-Path $acceptanceRoot "code-signing.cer"), `
    (Join-Path $acceptanceRoot "localhost-tls.cer"))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "A disposable acceptance certificate is missing." }
  }
  New-Item -ItemType Directory -Path $oldRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $newRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null

  Write-Output "acceptance-stage: certificates"
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "The disposable GitHub-hosted Windows runner is not elevated."
  }
  $passwordText = $env:BEAVER_ACCEPTANCE_CERT_PASSWORD
  if (-not $passwordText -or $passwordText.Length -lt 32 -or [regex]::IsMatch($passwordText, "[\r\n\0]")) {
    throw "The disposable certificate password is invalid."
  }
  Write-Output "::add-mask::$passwordText"
  $codeCertificatePath = Join-Path $acceptanceRoot "code-signing.cer"
  $tlsCertificatePath = Join-Path $acceptanceRoot "localhost-tls.cer"
  $rootCertificatePath = Join-Path $acceptanceRoot "root-ca.cer"
  $rootCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
    [IO.File]::ReadAllBytes($rootCertificatePath)
  )
  $codeCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
    [IO.File]::ReadAllBytes($codeCertificatePath)
  )
  $tlsCertificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new(
    [IO.File]::ReadAllBytes($tlsCertificatePath)
  )
  Add-MachineCertificate $rootCertificate "Root"
  Add-MachineCertificate $codeCertificate "TrustedPublisher"
  $certificateThumbprints = @($rootCertificate.Thumbprint, $codeCertificate.Thumbprint, $tlsCertificate.Thumbprint) | Select-Object -Unique
  $rootCertificate.Dispose()
  $codeCertificate.Dispose()
  $tlsCertificate.Dispose()

  Push-Location $repoRoot
  try {
    Write-Output "acceptance-stage: build-and-seed"
    Invoke-HiddenProcess "npm.cmd" @("run", "build") 300 "Acceptance build"
    Invoke-Checked "node.exe" @(
      "scripts/desktop-update-acceptance-fixture.mjs", "seed", $fixtureHome, $fixtureProject
    )

    $env:BEAVER_BUILD_CHANNEL = "test"
    $env:BEAVER_TEST_UPDATE_URL = $feedUrl
    $env:BEAVER_PUBLISHER_SUBJECT = $publisher
    $env:CSC_LINK = $codePfx
    $env:CSC_KEY_PASSWORD = $passwordText

    $env:BEAVER_TEST_VERSION = $oldVersion
    Write-Output "acceptance-stage: package-old"
    Invoke-HiddenProcess "npm.cmd" @("run", "package:desktop:win") 1200 "Old signed package build"
    $oldBuiltInstaller = Join-Path $repoRoot "release\desktop\test\Beaver-Code-Test-Setup-$oldVersion-win-x64.exe"
    Copy-Item -LiteralPath $oldBuiltInstaller -Destination $oldRoot -Force

    $env:BEAVER_TEST_VERSION = $newVersion
    Write-Output "acceptance-stage: package-new"
    Invoke-HiddenProcess "npm.cmd" @("run", "package:desktop:win") 1200 "New signed package build"
    $newBuiltInstallerName = "Beaver-Code-Test-Setup-$newVersion-win-x64.exe"
    Copy-Item -LiteralPath (Join-Path $repoRoot "release\desktop\test\$newBuiltInstallerName") -Destination $newRoot -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot "release\desktop\test\$newBuiltInstallerName.blockmap") -Destination $newRoot -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot "release\desktop\test\latest.yml") -Destination $newRoot -Force
  } finally {
    Pop-Location
  }

  $oldInstaller = Join-Path $oldRoot "Beaver-Code-Test-Setup-$oldVersion-win-x64.exe"
  $newInstallerName = "Beaver-Code-Test-Setup-$newVersion-win-x64.exe"
  $newInstaller = Join-Path $newRoot $newInstallerName
  $newBlockmapName = "$newInstallerName.blockmap"
  foreach ($path in @($oldInstaller, $newInstaller, (Join-Path $newRoot "latest.yml"), (Join-Path $newRoot $newBlockmapName))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required acceptance artifact is missing." }
  }

  foreach ($name in @("CSC_LINK", "CSC_KEY_PASSWORD")) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  $env:BEAVER_UPDATE_FEED_ROOT = $newRoot
  $env:BEAVER_UPDATE_FEED_READY = $feedReady
  $env:BEAVER_UPDATE_TLS_PFX = $tlsPfx
  $env:BEAVER_UPDATE_TLS_PASSWORD = $passwordText
  $env:BEAVER_UPDATE_FEED_PORT = "$feedPort"
  $env:BEAVER_UPDATE_INSTALLER_NAME = $newInstallerName
  $env:BEAVER_UPDATE_BLOCKMAP_NAME = $newBlockmapName
  Write-Output "acceptance-stage: start-feed"
  $feedProcess = Start-Process -FilePath "node.exe" -ArgumentList @((Join-Path $repoRoot "scripts\serve-desktop-update-fixture.mjs")) `
    -WindowStyle Hidden -PassThru
  Wait-Until { Test-Path -LiteralPath $feedReady -PathType Leaf } 30 "The isolated HTTPS update feed did not start."
  foreach ($name in @("BEAVER_UPDATE_TLS_PFX", "BEAVER_UPDATE_TLS_PASSWORD")) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }

  Write-Output "acceptance-stage: install-old"
  Install-TestPackage $oldInstaller
  $installedExecutable = Join-Path $installRoot "BeaverCodeUpdateTest.exe"
  $installedRuntime = Join-Path $installRoot "resources\app.asar\dist"
  $expectedCommit = (& git -C $repoRoot rev-parse HEAD).Trim()
  if (-not (Test-Path -LiteralPath $installedExecutable -PathType Leaf)) { throw "The old test application was not installed." }

  $desktopLog = Join-Path $env:USERPROFILE ".beaver-code-update-test\desktop\desktop.log"
  if (Test-Path -LiteralPath $desktopLog -PathType Leaf) { Remove-Item -LiteralPath $desktopLog -Force }
  $env:BEAVER_TEST_AUTO_ACCEPT_UPDATE = "1"
  Write-Output "acceptance-stage: prompted-update"
  $oldProcess = Start-Process -FilePath $installedExecutable -WindowStyle Hidden -PassThru
  Wait-Until {
    Capture-UpdateInstallerProcess
    if (-not (Test-Path -LiteralPath $desktopLog -PathType Leaf)) { return $false }
    $content = Get-Content -LiteralPath $desktopLog -Raw -Encoding UTF8
    if ($content.Contains(" update failed")) { throw "The installed application reported an update failure." }
    if (-not ($content.Contains("update installing") `
      -and $content.Contains("workbench-ready version=$newVersion commit=$expectedCommit"))) { return $false }
    $oldProcess.Refresh()
    if (-not $oldProcess.HasExited) { return $false }
    $newMain = @(Get-AcceptanceMainProcesses | Where-Object ProcessId -NE $oldProcess.Id)
    return $newMain.Count -eq 1
  } 600 "The signed prompted update did not install and restart the application."

  if (-not $script:updateInstallerProcess) { throw "The update installer process was not observed." }
  Wait-Until {
    $script:updateInstallerProcess.Refresh()
    return $script:updateInstallerProcess.HasExited
  } 60 "The update installer did not exit after relaunch."
  $installerStart = $script:updateInstallerProcess.StartTime.ToUniversalTime()
  $installerExit = $script:updateInstallerProcess.ExitTime.ToUniversalTime()
  $installerExitCode = $script:updateInstallerProcess.ExitCode
  if ($installerExitCode -ne 0) { throw "The update installer exited with a failure code." }

  $newMain = @(Get-AcceptanceMainProcesses | Where-Object ProcessId -NE $oldProcess.Id)
  if ($newMain.Count -ne 1) { throw "The updated application does not have exactly one live main process." }
  $oldExit = $oldProcess.ExitTime.ToUniversalTime()
  $newStart = $newMain[0].CreationDate.ToUniversalTime()
  if ($newStart -lt $oldExit) { throw "The updated application started before the old process exited." }
  if ($installerStart -gt $newStart -or $installerExit -lt $newStart) {
    throw "The updated application did not start during the update installer process."
  }
  Write-Output "acceptance-relaunch: oldPid=$($oldProcess.Id) oldExitUtc=$($oldExit.ToString('o')) installerPid=$($script:updateInstallerProcess.Id) installerStartUtc=$($installerStart.ToString('o')) newPid=$($newMain[0].ProcessId) newStartUtc=$($newStart.ToString('o')) installerExitUtc=$($installerExit.ToString('o')) installerExitCode=$installerExitCode"

  $version = (Get-Item -LiteralPath $installedExecutable).VersionInfo.ProductVersion
  if ($version -ne "${newVersion}.0" -and $version -ne $newVersion) { throw "Installed executable version is not the update version." }
  $log = Get-Content -LiteralPath $desktopLog -Raw -Encoding UTF8
  foreach ($state in @("checking", "downloading", "preparing", "stopping", "installing")) {
    if (-not $log.Contains("update $state")) { throw "Prompted update did not record the $state state." }
  }
  if (-not $oldProcess.HasExited) {
    Wait-Until { $oldProcess.Refresh(); $oldProcess.HasExited } 60 "The old application process did not exit after authorizing the installer."
  }
  [System.Threading.Thread]::Sleep(8000)
  Stop-AcceptanceApplication $true
  Write-Output "acceptance-stage: verify-updated-data"
  Verify-Fixture $installedExecutable $installedRuntime

  Write-Output "acceptance-stage: inject-install-fault"
  $installedAsar = Assert-RunnerChild (Join-Path $installRoot "resources\app.asar")
  $corruptedAsar = Assert-RunnerChild (Join-Path $installRoot "resources\app.asar.acceptance-corrupt")
  if (-not (Test-Path -LiteralPath $installedAsar -PathType Leaf)) { throw "The installed application payload is missing before fault injection." }
  if (Test-Path -LiteralPath $corruptedAsar) { throw "The controlled corruption marker already exists." }
  $expectedAsarHash = (Get-FileHash -LiteralPath $installedAsar -Algorithm SHA256).Hash
  $dataDigestBeforeRepair = Get-PersistedDataDigest
  Move-Item -LiteralPath $installedAsar -Destination $corruptedAsar
  if ((Test-Path -LiteralPath $installedAsar -PathType Leaf) -or -not (Test-Path -LiteralPath $corruptedAsar -PathType Leaf)) {
    throw "The controlled application payload fault was not established."
  }

  Write-Output "acceptance-stage: repair-corrupted-install"
  Install-TestPackage $newInstaller
  if (-not (Test-Path -LiteralPath $installedAsar -PathType Leaf)) { throw "Repair did not restore the application payload." }
  if ((Get-FileHash -LiteralPath $installedAsar -Algorithm SHA256).Hash -ne $expectedAsarHash) {
    throw "Repair restored an unexpected application payload."
  }
  if ((Get-PersistedDataDigest) -ne $dataDigestBeforeRepair) { throw "Repair changed persisted acceptance data." }
  if (Test-Path -LiteralPath $corruptedAsar) { throw "Repair left the controlled corrupted payload behind." }
  $repairProcess = Start-And-AssertHealthy $installedExecutable $newVersion $expectedCommit
  Stop-AcceptanceApplication $true
  Verify-Fixture $installedExecutable $installedRuntime

  $uninstaller = Get-ChildItem -LiteralPath $installRoot -Filter "Uninstall*.exe" -File | Select-Object -First 1
  if (-not $uninstaller) { throw "The installed uninstaller was not found." }
  $dataDigestBeforeUninstall = Get-PersistedDataDigest
  Write-Output "acceptance-stage: uninstall"
  Invoke-HiddenProcess $uninstaller.FullName @("/S", "/currentuser") 180 "NSIS uninstall"
  Wait-Until { -not (Test-Path -LiteralPath $installedExecutable -PathType Leaf) } 60 "Uninstall did not remove the application binary."
  if ((Get-PersistedDataDigest) -ne $dataDigestBeforeUninstall) { throw "Uninstall changed persisted acceptance data." }

  Write-Output "acceptance-stage: reinstall"
  Install-TestPackage $newInstaller
  $reinstallProcess = Start-And-AssertHealthy $installedExecutable $newVersion $expectedCommit
  Stop-AcceptanceApplication $true
  Verify-Fixture $installedExecutable $installedRuntime

  $passedResult = [ordered]@{
    schema = 1
    result = "passed"
    oldVersion = $oldVersion
    newVersion = $newVersion
    commit = (& git -C $repoRoot rev-parse HEAD).Trim()
    signedPublisher = $publisher
    promptedUpdate = $true
    explicitInstallEntryPointObserved = $true
    oldMainPid = $oldProcess.Id
    updateInstallerPid = $script:updateInstallerProcess.Id
    newMainPid = $newMain[0].ProcessId
    oldExitUtc = $oldExit.ToString("o")
    installerStartUtc = $installerStart.ToString("o")
    newStartUtc = $newStart.ToString("o")
    installerExitUtc = $installerExit.ToString("o")
    installerExitCode = $installerExitCode
    spacedCustomInstallPath = $true
    persistedConversation = $true
    persistedDraft = $true
    persistedQueue = $true
    repairInstall = $true
    repairRecoveredCorruptedApp = $true
    uninstallPreservedData = $true
    reinstallReadData = $true
  }
} catch {
  Write-SafeUpdateLogEvidence
  if (Test-Path -LiteralPath $acceptanceRoot -PathType Container) {
    [ordered]@{
      schema = 1
      result = "failed"
      oldVersion = $oldVersion
      newVersion = $newVersion
      commit = (& git -C $repoRoot rev-parse HEAD).Trim()
    } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $resultPath -Encoding UTF8
  }
  throw
} finally {
  try { Stop-AcceptanceApplication $false } catch { }
  if ($feedProcess -and -not $feedProcess.HasExited) { Stop-Process -Id $feedProcess.Id -Force -ErrorAction SilentlyContinue }
  foreach ($thumbprint in $certificateThumbprints) {
    foreach ($store in @("My", "Root", "TrustedPublisher")) {
      $target = "Cert:\LocalMachine\$store\$thumbprint"
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue }
    }
  }
  foreach ($subject in $certificateSubjects) {
    foreach ($store in @("My", "Root", "TrustedPublisher")) {
      Get-ChildItem "Cert:\LocalMachine\$store" -ErrorAction SilentlyContinue | Where-Object Subject -EQ $subject | `
        Remove-Item -Force -ErrorAction SilentlyContinue
    }
  }
  foreach ($thumbprint in $certificateThumbprints) {
    foreach ($store in @("My", "Root", "TrustedPublisher")) {
      if (Test-Path -LiteralPath "Cert:\LocalMachine\$store\$thumbprint") {
        throw "A disposable acceptance certificate was not removed."
      }
    }
  }
  foreach ($subject in $certificateSubjects) {
    foreach ($store in @("My", "Root", "TrustedPublisher")) {
      if (Get-ChildItem "Cert:\LocalMachine\$store" -ErrorAction SilentlyContinue | Where-Object Subject -EQ $subject) {
        throw "A disposable acceptance certificate subject was not removed."
      }
    }
  }
  foreach ($name in @(
    "BEAVER_BUILD_CHANNEL", "BEAVER_TEST_VERSION", "BEAVER_TEST_UPDATE_URL", "BEAVER_PUBLISHER_SUBJECT",
    "CSC_LINK", "CSC_KEY_PASSWORD", "BEAVER_UPDATE_FEED_ROOT", "BEAVER_UPDATE_FEED_READY",
    "BEAVER_UPDATE_TLS_PFX", "BEAVER_UPDATE_TLS_PASSWORD", "BEAVER_UPDATE_FEED_PORT",
    "BEAVER_UPDATE_INSTALLER_NAME", "BEAVER_UPDATE_BLOCKMAP_NAME", "BEAVER_ACCEPTANCE_CERT_PASSWORD",
    "BEAVER_TEST_AUTO_ACCEPT_UPDATE"
  )) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
}

if ($passedResult) {
  $passedResult | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $resultPath -Encoding UTF8
  Write-Output "Windows update acceptance passed."
}
