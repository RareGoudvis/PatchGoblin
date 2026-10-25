@echo off
REM ============================================================================
REM  UnQuesti - installer
REM  Dubbelklik dit bestand. Het haalt UnQuesti van GitHub, zet het in een vaste
REM  map, kopieert die map naar je klembord en opent de extensiepagina van je
REM  browser. Daar doe je zelf nog 1 klik: "Uitgepakt laden" + plakken.
REM  Geen Git of installatie nodig - gebruikt alleen Windows PowerShell.
REM ============================================================================
setlocal
REM Welke versie: "main" = stabiel. Testers van een beta zetten hier de naam van die branch.
set "UQ_BRANCH=unquesti"
echo === UnQuesti installeren (versie: %UQ_BRANCH%) ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "try {" ^
  "  $branch=$env:UQ_BRANCH; $dest=Join-Path $env:LOCALAPPDATA 'UnQuesti';" ^
  "  $zip=Join-Path $env:TEMP 'unquesti-install.zip'; $tmp=Join-Path $env:TEMP 'unquesti-install';" ^
  "  Write-Host ('Downloaden van GitHub (' + $branch + ')...');" ^
  "  Invoke-WebRequest -Uri ('https://github.com/RareGoudvis/ce-questi-utility/archive/refs/heads/' + $branch + '.zip') -OutFile $zip;" ^
  "  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force };" ^
  "  Expand-Archive -Path $zip -DestinationPath $tmp -Force;" ^
  "  $src=Get-ChildItem $tmp -Directory | Select-Object -First 1;" ^
  "  if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'manifest.json'))) { throw 'Uitgepakte map zonder manifest.json.' };" ^
  "  New-Item -ItemType Directory -Force -Path $dest | Out-Null;" ^
  "  Copy-Item -Path (Join-Path $src.FullName '*') -Destination $dest -Recurse -Force;" ^
  "  Remove-Item $zip -Force; Remove-Item $tmp -Recurse -Force;" ^
  "  Set-Clipboard -Value $dest;" ^
  "  Write-Host ''; Write-Host ('Geinstalleerd in: ' + $dest) -ForegroundColor Green;" ^
  "  Write-Host 'Die map staat nu op je klembord.';" ^
  "  $opened=$false;" ^
  "  foreach ($b in @(@('chrome','chrome://extensions'), @('msedge','edge://extensions'), @('brave','brave://extensions'))) {" ^
  "    if (-not $opened) { try { Start-Process $b[0] $b[1]; $opened=$true; Write-Host ('Extensiepagina geopend in ' + $b[0] + '.') } catch {} } };" ^
  "  if (-not $opened) { Write-Host 'Open zelf je browser en typ chrome://extensions (Edge: edge://extensions, Brave: brave://extensions).' -ForegroundColor Yellow }" ^
  "} catch { Write-Host ('FOUT: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 (
  echo.
  echo Installeren MISLUKT. Controleer je internetverbinding en probeer opnieuw.
  echo.
  pause
  exit /b 1
)
echo.
echo ============================================================================
echo  Nog 3 klikken in de browser:
echo   1. Zet "Ontwikkelaarsmodus" aan (rechtsboven; in Edge links).
echo   2. Klik "Uitgepakt laden".
echo   3. Klik in het adresvak bovenaan, plak (Ctrl+V), druk Enter en kies "Map selecteren".
echo.
echo  Daarna: herlaad je Questi-agenda. Je ziet de knop "UnQuesti" in de werkbalk.
echo  Bijwerken later: dubbelklik update.bat in %LOCALAPPDATA%\UnQuesti
echo ============================================================================
echo.
pause
