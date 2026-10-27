@echo off
REM ============================================================================
REM  PatchGoblin - updater
REM  Dubbelklik dit bestand om de laatste versie van GitHub op te halen.
REM  1. downloadt naar een tijdelijke map en CONTROLEERT die (manifest.json en
REM     version.json moeten hetzelfde versienummer hebben, kernbestanden aanwezig);
REM  2. maakt een back-up van deze map (%LOCALAPPDATA%\PatchGoblin-backups, laatste 3);
REM  3. vervangt de bestanden - lukt dat niet, dan zet het de back-up terug.
REM  Geen Git of installatie nodig - gebruikt alleen Windows PowerShell.
REM
REM  Alles staat op EEN regel hieronder: het bestand vervangt zichzelf tijdens het
REM  bijwerken, en cmd leest een .bat regel per regel terwijl het loopt.
REM ============================================================================
set "PG_DEST=%~dp0" & set "PG_SELF=%~f0" & powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=Get-Content -Raw -LiteralPath $env:PG_SELF; iex $s.Substring($s.LastIndexOf('#=P'+'S=') + 5)" & pause & exit /b

#=PS=
$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/RareGoudvis/PatchGoblin/archive/refs/heads/main.zip'
$dest = $env:PG_DEST.TrimEnd('\')
Write-Host '=== PatchGoblin bijwerken ==='
Write-Host ('Map: ' + $dest)
Write-Host ''
$work = Join-Path $env:TEMP ('pg-update-' + (Get-Random))
$bak = $null
function Version-Of($file) { (Get-Content -Raw -Encoding UTF8 $file | ConvertFrom-Json).version }
try {
  New-Item -ItemType Directory -Path $work | Out-Null
  $zip = Join-Path $work 'pg.zip'
  Write-Host 'Downloaden van GitHub...'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}   # not allowed in Constrained Language Mode
  Invoke-WebRequest -UseBasicParsing -Uri $repo -OutFile $zip
  # Expand-Archive is a script module a locked-down PC may refuse to load; tar.exe (Windows 10+) unpacks a ZIP too.
  try { Expand-Archive -Path $zip -DestinationPath (Join-Path $work 'x') -Force }
  catch { New-Item -ItemType Directory -Force -Path (Join-Path $work 'x') | Out-Null; tar -xf $zip -C (Join-Path $work 'x'); if ($LASTEXITCODE) { throw 'uitpakken mislukt' } }
  # The ZIP holds one folder named after the repo and branch; take it whatever it is called.
  $src = @(Get-ChildItem (Join-Path $work 'x') -Directory)[0].FullName

  # 1. Controle: niets wordt vervangen tenzij de download compleet en consistent is.
  foreach ($f in 'manifest.json', 'version.json', 'planner.js', 'lessons.js', 'content.js', 'background.js', 'opstap-bridge.js') {
    if (-not (Test-Path (Join-Path $src $f))) { throw ('download onvolledig: ' + $f + ' ontbreekt - er is niets vervangen') }
  }
  $new = Version-Of (Join-Path $src 'manifest.json')
  $vj = Version-Of (Join-Path $src 'version.json')
  if (-not $new -or $new -ne $vj) { throw ('versies kloppen niet (manifest ' + $new + ', version.json ' + $vj + ') - er is niets vervangen') }
  $old = '?'
  if (Test-Path (Join-Path $dest 'manifest.json')) { try { $old = Version-Of (Join-Path $dest 'manifest.json') } catch {} }
  Write-Host ('Huidige versie: ' + $old + '   nieuwe versie: ' + $new)

  # 2. Back-up van de huidige map (de laatste 3 blijven bewaard).
  $root = Join-Path $env:LOCALAPPDATA 'PatchGoblin-backups'
  $bak = Join-Path $root ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-v' + $old)
  New-Item -ItemType Directory -Path $bak -Force | Out-Null
  Copy-Item -Path (Join-Path $dest '*') -Destination $bak -Recurse -Force
  Get-ChildItem $root -Directory | Sort-Object Name -Descending | Select-Object -Skip 3 | Remove-Item -Recurse -Force
  Write-Host ('Back-up: ' + $bak)

  # 3. Vervangen, en nakijken dat de nieuwe versie er echt staat.
  Write-Host 'Bestanden vervangen...'
  try {
    Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force
    if ((Version-Of (Join-Path $dest 'manifest.json')) -ne $new) { throw 'na het kopieren staat er niet de nieuwe versie' }
  } catch {
    Write-Host ('Vervangen mislukt (' + $_.Exception.Message + ') - back-up wordt teruggezet...') -ForegroundColor Yellow
    Copy-Item -Path (Join-Path $bak '*') -Destination $dest -Recurse -Force
    throw ('vervangen mislukt, de vorige versie (' + $old + ') staat terug')
  }
  Write-Host ''
  Write-Host ('Klaar! PatchGoblin ' + $new + ' staat klaar.') -ForegroundColor Green
  Write-Host 'Ga naar chrome://extensions en klik het vernieuw-icoon bij PatchGoblin (of herstart Chrome),'
  Write-Host 'en herlaad daarna je Questi-tabblad.'
} catch {
  Write-Host ''
  Write-Host ('Bijwerken MISLUKT: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host 'Controleer je internetverbinding en probeer opnieuw, of download de ZIP handmatig van GitHub.'
  if ($bak) { Write-Host ('Back-up van je vorige versie: ' + $bak) }
} finally {
  if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Host ''
