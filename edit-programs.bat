@echo off
rem Starts the addon and opens the shows editor. Close the server window to stop.
cd /d "%~dp0"

where node >nul 2>&1 || (
  echo Node.js is required but was not found on PATH.
  echo Install it from https://nodejs.org/ ^(version 18 or newer^).
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Dependencies are missing - running install.bat first...
  call "%~dp0install.bat" || exit /b 1
)

start "Catch-up TV ^& More (JS)" node server.js
rem the app loads credentials and binds before it can answer
timeout /t 3 /nobreak >nul
start "" http://localhost:7860
