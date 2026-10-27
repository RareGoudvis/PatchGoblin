# ============================================================================
#  PatchGoblin - installeren of bijwerken ZONDER .bat
#  Voor een pc waar install.bat / update.bat geblokkeerd is (SmartScreen, de
#  browser weigert de download, of school blokkeert .bat). Er wordt niets
#  gedownload dat je moet openen: plak deze ene regel in PowerShell
#  (Start > typ "PowerShell" > Enter) en druk Enter:
#
#    irm https://raw.githubusercontent.com/RareGoudvis/PatchGoblin/main/install.ps1 | iex
#
#  Staat PatchGoblin al in %LOCALAPPDATA%\PatchGoblin, dan werkt het bij - met
#  dezelfde controle, back-up en terugzetten als update.bat. Anders installeert het.
#  Andere map of beta-branch: zet eerst $env:PG_DEST / $env:PG_BRANCH.
# ============================================================================
# Runs through iex in the user's own session: everything sits in one script block (no leaked
# variables or $ErrorActionPreference) and it never calls `exit` (that would close their window).
# Cmdlets only, no .NET static calls outside a try: school PCs may run PowerShell in Constrained
# Language Mode. Keep the checks in step with update.bat.
& {
  $ErrorActionPreference = 'Stop'
  $branch = if ($env:PG_BRANCH) { $env:PG_BRANCH } else { 'main' }
  $dest = if ($env:PG_DEST) { $env:PG_DEST.TrimEnd('\') } else { Join-Path $env:LOCALAPPDATA 'PatchGoblin' }
  $repo = 'https://github.com/RareGoudvis/PatchGoblin/archive/refs/heads/' + $branch + '.zip'
  $isUpdate = Test-Path (Join-Path $dest 'manifest.json')
  $work = Join-Path $env:TEMP ('pg-install-' + (Get-Random))
  $bak = $null
  function Version-Of($file) { (Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json).version }
  Write-Host ('=== PatchGoblin ' + $(if ($isUpdate) { 'bijwerken' } else { 'installeren' }) + ' (versie: ' + $branch + ') ===')
  Write-Host ('Map: ' + $dest)
  Write-Host ''
  try {
    New-Item -ItemType Directory -Path $work | Out-Null
    $zip = Join-Path $work 'pg.zip'
    Write-Host 'Downloaden van GitHub...'
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
    Invoke-WebRequest -UseBasicParsing -Uri $repo -OutFile $zip
    # Expand-Archive is a script module a locked-down PC may refuse to load; tar.exe (Windows 10+) unpacks a ZIP too.
    try { Expand-Archive -Path $zip -DestinationPath (Join-Path $work 'x') -Force }
    catch { New-Item -ItemType Directory -Force -Path (Join-Path $work 'x') | Out-Null; tar -xf $zip -C (Join-Path $work 'x'); if ($LASTEXITCODE) { throw 'uitpakken mislukt' } }
    $src = @(Get-ChildItem (Join-Path $work 'x') -Directory)[0].FullName

    # 1. Controle: niets wordt vervangen tenzij de download compleet en consistent is.
    foreach ($f in 'manifest.json', 'version.json', 'planner.js', 'lessons.js', 'content.js', 'background.js', 'opstap-bridge.js') {
      if (-not (Test-Path (Join-Path $src $f))) { throw ('download onvolledig: ' + $f + ' ontbreekt - er is niets vervangen') }
    }
    $new = Version-Of (Join-Path $src 'manifest.json')
    $vj = Version-Of (Join-Path $src 'version.json')
    if (-not $new -or $new -ne $vj) { throw ('versies kloppen niet (manifest ' + $new + ', version.json ' + $vj + ') - er is niets vervangen') }
    $old = '?'
    if ($isUpdate) { try { $old = Version-Of (Join-Path $dest 'manifest.json') } catch {} }
    if ($isUpdate) { Write-Host ('Huidige versie: ' + $old + '   nieuwe versie: ' + $new) } else { Write-Host ('Versie: ' + $new) }

    # 2. Back-up van de huidige map (de laatste 3 blijven bewaard).
    if ($isUpdate) {
      $root = Join-Path $env:LOCALAPPDATA 'PatchGoblin-backups'
      $bak = Join-Path $root ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-v' + $old)
      New-Item -ItemType Directory -Path $bak -Force | Out-Null
      Copy-Item -Path (Join-Path $dest '*') -Destination $bak -Recurse -Force
      Get-ChildItem $root -Directory | Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Recurse -Force
      Write-Host ('Back-up: ' + $bak)
    }

    # 3. Plaatsen, en nakijken dat de nieuwe versie er echt staat.
    Write-Host 'Bestanden plaatsen...'
    try {
      New-Item -ItemType Directory -Force -Path $dest | Out-Null
      Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force
      if ((Version-Of (Join-Path $dest 'manifest.json')) -ne $new) { throw 'na het kopieren staat er niet de nieuwe versie' }
    } catch {
      if (-not $bak) { throw }
      Write-Host ('Vervangen mislukt (' + $_.Exception.Message + ') - back-up wordt teruggezet...') -ForegroundColor Yellow
      Copy-Item -Path (Join-Path $bak '*') -Destination $dest -Recurse -Force
      throw ('vervangen mislukt, de vorige versie (' + $old + ') staat terug')
    }

    Write-Host ''
    if ($isUpdate) {
      Write-Host ('Klaar! PatchGoblin ' + $new + ' staat klaar.') -ForegroundColor Green
      Write-Host 'Ga naar chrome://extensions en klik het vernieuw-icoon bij PatchGoblin (of herstart Chrome),'
      Write-Host 'en herlaad daarna je Questi-tabblad.'
    } else {
      Write-Host ('Geinstalleerd in: ' + $dest) -ForegroundColor Green
      try { Set-Clipboard -Value $dest; Write-Host 'Die map staat nu op je klembord.' } catch { Write-Host 'Kopieer die map zelf (selecteren + Ctrl+C).' }
      $opened = $false
      foreach ($b in @(@('chrome', 'chrome://extensions'), @('msedge', 'edge://extensions'), @('brave', 'brave://extensions'))) {
        if (-not $opened) { try { Start-Process $b[0] $b[1]; $opened = $true; Write-Host ('Extensiepagina geopend in ' + $b[0] + '.') } catch {} }
      }
      if (-not $opened) { Write-Host 'Open zelf je browser en typ chrome://extensions (Edge: edge://extensions).' -ForegroundColor Yellow }
      Write-Host ''
      Write-Host 'Nog 3 klikken in de browser:'
      Write-Host '  1. Zet "Ontwikkelaarsmodus" aan (rechtsboven; in Edge links).'
      Write-Host '  2. Klik "Uitgepakt laden".'
      Write-Host '  3. Klik in het adresvak bovenaan, plak (Ctrl+V), druk Enter en kies "Map selecteren".'
      Write-Host 'Daarna: herlaad je Questi-agenda.'
    }
    Write-Host 'Bijwerken later: plak dezelfde regel opnieuw in PowerShell.'
  } catch {
    Write-Host ''
    Write-Host ('MISLUKT: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Controleer je internetverbinding en probeer opnieuw, of installeer handmatig:'
    Write-Host '  https://raregoudvis.github.io/PatchGoblin/#handmatig'
    if ($bak) { Write-Host ('Back-up van je vorige versie: ' + $bak) }
  } finally {
    if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
