@echo off
rem Commits everything and force-pushes it to GitHub.
rem Pushes to the 'origin' remote when one is configured, otherwise to REPO_URL.
cd /d "%~dp0"

set "REPO_URL=https://github.com/unsuns06/ReplayTV-Stremio-JS"
set "BRANCH=main"

where git >nul 2>&1 || (
  echo Git is required but was not found on PATH.
  pause
  exit /b 1
)

if not exist ".git\" (
  echo This folder is not a git repository. Run: git init
  pause
  exit /b 1
)

rem An 'origin' remote wins over REPO_URL, so re-pointing the repo is a git
rem command rather than an edit to this file.
set "TARGET=%REPO_URL%"
for /f "delims=" %%r in ('git remote get-url origin 2^>nul') do set "TARGET=%%r"

echo Adding all files to git...
git add .

echo Creating a new commit...
git commit -m "Update project"

echo Force pushing to %TARGET% (%BRANCH%)...
git push --force "%TARGET%" %BRANCH%

echo.
echo Push complete.
pause
