@echo off
REM ============================================================
REM  RiskGPT — start script for Windows (no Docker)
REM  Run this from the repository root folder (the folder that
REM  contains webapp\ and mock-platform\).
REM
REM  Prerequisites (see BMO-AGENT-SETUP.md):
REM    - ONLYOFFICE Document Server installed and running (port 80 or 8090)
REM    - Node.js installed
REM    - "npm install" already run inside webapp\
REM ============================================================

REM Where the BROWSER reaches Document Server (change 80 -> 8090 if you
REM chose port 8090 during the Document Server install):
set DS_PUBLIC=http://localhost:80

REM Where DOCUMENT SERVER reaches this app (same machine, no Docker):
set APP_FOR_DS=http://localhost:3001

start "RiskGPT app (port 3001)" cmd /k "cd /d %~dp0..\webapp && node server.js"
start "Mock auth platform (port 3999)" cmd /k "cd /d %~dp0.. && node mock-platform\server.js"

echo.
echo Two windows opened: the app (3001) and the mock auth platform (3999).
echo Sign in at:  http://localhost:3999
echo.
pause
