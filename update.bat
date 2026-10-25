@echo off
REM ============================================================================
REM  PatchGoblin - updater
REM  Dubbelklik dit bestand om de laatste versie van GitHub op te halen.
REM  Het vervangt de bestanden in DEZE map. Herstart daarna Chrome
REM  (of klik het vernieuw-icoon op chrome://extensions bij de Weekplanner).
REM  Geen Git of installatie nodig - gebruikt alleen Windows PowerShell.
REM ============================================================================
echo === PatchGoblin bijwerken ===
echo Map: %~dp0
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $dest='%~dp0'; $zip=Join-Path $env:TEMP 'qwp-update.zip'; $tmp=Join-Path $env:TEMP 'qwp-update'; Write-Host 'Downloaden van GitHub...'; Invoke-WebRequest -Uri 'https://github.com/RareGoudvis/ce-questi-utility/archive/refs/heads/main.zip' -OutFile $zip; if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }; Expand-Archive -Path $zip -DestinationPath $tmp -Force; $src=Join-Path $tmp 'ce-questi-utility-main'; if (-not (Test-Path $src)) { throw 'Uitgepakte map niet gevonden.' }; Write-Host 'Bestanden vervangen...'; Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force; Remove-Item $zip -Force; Remove-Item $tmp -Recurse -Force; Write-Host 'OK.' } catch { Write-Host ('FOUT: ' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 (
  echo.
  echo Bijwerken MISLUKT. Controleer je internetverbinding en probeer opnieuw,
  echo of download de ZIP handmatig van GitHub.
) else (
  echo.
  echo Klaar! HERSTART Chrome om de nieuwe versie te laden.
  echo ^(of ga naar chrome://extensions en klik het vernieuw-icoon bij de Weekplanner^)
)
echo.
pause
