@echo off
rem Starts the addon. Close this window to stop it.
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

echo.
echo Catch-up TV ^& More - starting on http://localhost:7860
echo Add http://localhost:7860/manifest.json as an addon in Stremio.
echo.
node server.js

rem Only reached if the server exits on its own, which means something failed.
echo.
echo The server stopped.
pause
