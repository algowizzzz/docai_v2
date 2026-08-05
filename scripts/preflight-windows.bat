@echo off
REM RiskGPT on-prem preflight (Windows Server). Run in an ADMIN cmd:
REM    scripts\preflight-windows.bat
REM Prints PASS/FAIL/WARN per dependency. Fix every FAIL before installing.
setlocal enabledelayedexpansion
echo === RiskGPT preflight %DATE% %TIME% ===

net session >nul 2>&1 && (echo PASS  running as Administrator) || (echo FAIL  NOT elevated - reopen cmd as Administrator)

for /f "tokens=*" %%i in ('ver') do echo INFO  %%i
echo INFO  arch: %PROCESSOR_ARCHITECTURE%
if /i not "%PROCESSOR_ARCHITECTURE%"=="AMD64" echo FAIL  Document Server needs 64-bit x86

where node >nul 2>&1 && (for /f %%v in ('node -v') do echo PASS  node %%v  ^(need v22.5+^)) || echo FAIL  node not installed
where python >nul 2>&1 && (for /f "tokens=2" %%v in ('python -V 2^>^&1') do echo PASS  python %%v ^(optional^)) || echo WARN  no python - PDF tables degraded ^(optional^)

for %%p in (80 3001 3999) do (
  netstat -ano | findstr ":%%p " | findstr LISTENING >nul && (echo FAIL  port %%p IN USE) || (echo PASS  port %%p free)
)

for /f "tokens=3" %%s in ('dir /-c c:\ ^| findstr /C:"bytes free"') do set FREE=%%s
echo INFO  free bytes on C: %FREE%   ^(need ~10 GB / 10000000000^)
wmic ComputerSystem get TotalPhysicalMemory /value 2>nul | findstr =

curl -s -o NUL -w "PASS  github.com HTTP %%{http_code}\n" -m 15 https://github.com 2>nul || echo FAIL  github.com unreachable - set HTTPS_PROXY
curl -s -o NUL -w "INFO  api.deepseek.com HTTP %%{http_code} (optional)\n" -m 15 https://api.deepseek.com 2>nul || echo WARN  deepseek unreachable - LLM answers will be mocked

if exist "C:\Program Files\ONLYOFFICE\DocumentServer" (echo WARN  Document Server already installed) else (echo PASS  no existing Document Server)
sc query postgresql* >nul 2>&1 && echo WARN  existing PostgreSQL service found ^(installer may conflict^)

echo === done. Fix every FAIL, then follow ONPREM-DEPLOY.md ===
endlocal
