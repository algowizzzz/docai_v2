@echo off
REM Assembles the four per-component Playwright archives from the `deps`
REM GitHub release into the folder layout Playwright expects.
REM
REM Usage:
REM   1. Download into ONE folder (e.g. C:\riskgpt\pw-downloads):
REM        playwright-chromium-win64.zip
REM        playwright-chromium-headless-shell-win64.zip
REM        playwright-ffmpeg-win64.zip
REM        playwright-winldd-win64.zip
REM   2. Run:  scripts\assemble-pw-browsers.bat C:\riskgpt\pw-downloads C:\riskgpt\pw-browsers
REM   3. Use:  set PLAYWRIGHT_BROWSERS_PATH=C:\riskgpt\pw-browsers
REM
setlocal
if "%~2"=="" ( echo Usage: %~nx0 ^<download-folder^> ^<target-folder^> & exit /b 1 )
set SRC=%~1
set DST=%~2

for %%d in ("chromium-1234" "chromium_headless_shell-1234" "ffmpeg-1011" "winldd-1007") do mkdir "%DST%\%%~d" 2>nul

tar -xf "%SRC%\playwright-chromium-win64.zip"               -C "%DST%\chromium-1234"                 || goto :fail
tar -xf "%SRC%\playwright-chromium-headless-shell-win64.zip" -C "%DST%\chromium_headless_shell-1234" || goto :fail
tar -xf "%SRC%\playwright-ffmpeg-win64.zip"                  -C "%DST%\ffmpeg-1011"                  || goto :fail
tar -xf "%SRC%\playwright-winldd-win64.zip"                  -C "%DST%\winldd-1007"                  || goto :fail

REM markers Playwright checks before trusting a browser folder
for %%d in ("chromium-1234" "chromium_headless_shell-1234" "ffmpeg-1011" "winldd-1007") do type nul > "%DST%\%%~d\INSTALLATION_COMPLETE"

if exist "%DST%\chromium-1234\chrome-win64\chrome.exe" (
  echo OK - browsers assembled at %DST%
  echo Now set:  set PLAYWRIGHT_BROWSERS_PATH=%DST%
  exit /b 0
)
:fail
echo FAILED - check the four zips are present in %SRC%
exit /b 1
