@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set /p version="Enter version (e.g. 2.6.3): "
if "%version%"=="" (
  echo [OSE] Version is empty. Aborting.
  exit /b 1
)

rem Resolve the current version from package.json so a re-run stays safe.
set "current="
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "current=%%v"

if not "%version%"=="%current%" (
  rem Bumps package.json and package-lock.json without creating a commit/tag.
  npm version %version% --no-git-tag-version
  if errorlevel 1 goto :error
) else (
  echo [OSE] Already at v%version% - skipping npm version bump.
)

rem Keep the version in sync across docs. PowerShell handles UTF-8 (no BOM).
set "OSE_VERSION=%version%"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$v=$env:OSE_VERSION; $d=(Get-Date).ToString('yyyy-MM-dd'); $enc=New-Object System.Text.UTF8Encoding($false); $r=[System.IO.File]::ReadAllText('README.md'); $r=$r -replace '\*\*[0-9]+\.[0-9]+\.[0-9]+\*\*\.',('**'+$v+'**.'); [System.IO.File]::WriteAllText('README.md',$r,$enc); $u=[System.IO.File]::ReadAllText('discord-update.txt'); $u=$u -replace '[0-9]+\.[0-9]+\.[0-9]+',$v; [System.IO.File]::WriteAllText('discord-update.txt',$u,$enc); $c=[System.IO.File]::ReadAllText('CHANGELOG.md'); $h='## ['+$v+'] '; if ($c.IndexOf($h) -lt 0) { $i=$c.IndexOf('## ['); $c=$c.Substring(0,$i)+$h+[char]0x2014+' '+$d+[Environment]::NewLine+[Environment]::NewLine+$c.Substring($i) }; [System.IO.File]::WriteAllText('CHANGELOG.md',$c,$enc);"
if errorlevel 1 goto :error

git add .
if errorlevel 1 goto :error

rem Use commit.txt as the message when present (multi-line friendly);
rem otherwise prompt, with Enter keeping the default.
if exist commit.txt (
  git commit -F commit.txt
  if errorlevel 1 goto :error
) else (
  set "commitMsg=chore: release v%version%"
  set /p commitMsg="Commit message [%commitMsg%]: "
  git commit -m "%commitMsg%"
  if errorlevel 1 goto :error
)

git push origin main
if errorlevel 1 goto :error

rem Create and push the tag only if it does not exist yet.
git rev-parse -q --verify "v%version%" >nul 2>nul
if errorlevel 1 (
  git tag "v%version%"
  if errorlevel 1 goto :error
  git push origin "v%version%"
  if errorlevel 1 goto :error
) else (
  echo [OSE] Tag v%version% already exists - pushing it.
  git push origin "v%version%"
  if errorlevel 1 goto :error
)

echo [OSE] Version v%version% successfully pushed to GitHub Actions!
exit /b 0

:error
echo [OSE] Release failed. Aborting.
exit /b 1
