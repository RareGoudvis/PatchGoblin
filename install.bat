@echo off
REM ============================================================================
REM  PatchGoblin - installer
REM  Dubbelklik dit bestand. Het haalt PatchGoblin van GitHub, zet het in een vaste
REM  map, kopieert die map naar je klembord en opent de extensiepagina van je
REM  browser. Daar doe je zelf nog 1 klik: "Uitgepakt laden" + plakken.
REM  Staat PatchGoblin er al, dan werkt het bij (met back-up).
REM  Geen Git of installatie nodig - gebruikt alleen Windows PowerShell.
REM
REM  Geblokkeerd? Plak dan in PowerShell:
REM    irm https://raw.githubusercontent.com/RareGoudvis/PatchGoblin/main/install.ps1 | iex
REM ============================================================================
REM The work is done by install.ps1 (one installer for both routes), fetched fresh from GitHub.
setlocal
REM Welke versie: "main" = stabiel. Testers van een beta zetten hier de naam van die branch.
set "PG_BRANCH=main"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}; irm ('https://raw.githubusercontent.com/RareGoudvis/PatchGoblin/' + $env:PG_BRANCH + '/install.ps1') | iex"
echo.
pause
