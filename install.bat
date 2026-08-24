@echo off
rem Installs the dependencies into node_modules. Run once after cloning.
cd /d "%~dp0"

where npm >nul 2>&1 || (
  echo npm is required but was not found on PATH.
  echo Install Node.js from https://nodejs.org/ ^(version 18 or newer^).
  pause
  exit /b 1
)

echo Installing dependencies...
call npm install --no-audit --no-fund || (
  echo.
  echo Install failed.
  pause
  exit /b 1
)

echo.
echo Done. Run start-server.bat to start the addon.
