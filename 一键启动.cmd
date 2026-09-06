@echo off
setlocal EnableExtensions

chcp 65001 >nul 2>&1
cd /d "%~dp0"
title MusicGPT

echo.
echo ========================================
echo   MusicGPT one-click launcher
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found.
  echo Install Node.js 20 or newer, then run this file again:
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Reinstall Node.js and try again.
  echo.
  pause
  exit /b 1
)

if not exist "package.json" (
  echo [ERROR] package.json was not found next to this launcher.
  echo.
  pause
  exit /b 1
)

if not exist ".env" (
  if not exist ".env.example" (
    echo [ERROR] Neither .env nor .env.example was found.
    echo.
    pause
    exit /b 1
  )

  copy /y ".env.example" ".env" >nul
  echo [SETUP] Created .env from .env.example.
  echo [SETUP] Add your NCM_COOKIE and AI API key to .env when needed.
  echo.
)

if not exist "node_modules\NeteaseCloudMusicApi\app.js" (
  echo [SETUP] Installing dependencies. This can take a few minutes...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] Dependency installation failed. Check the output above.
    echo.
    pause
    exit /b 1
  )
  echo.
)

powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$ProgressPreference = 'SilentlyContinue'; try { $web = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:5173'; $health = Invoke-RestMethod -TimeoutSec 2 'http://127.0.0.1:8787/health'; if ($web.StatusCode -lt 500 -and $health.ok -eq $true -and $health.checkout -eq 'main') { exit 0 } } catch {}; exit 1" >nul 2>&1
if not errorlevel 1 (
  call node scripts\wait-for-ncm.mjs --once
  if errorlevel 1 (
    echo [REPAIR] MusicGPT is running, but its NCM API is down.
    echo [REPAIR] Starting and supervising the missing NCM API now...
    echo [STOP]   Press Ctrl+C in this window to stop the NCM supervisor.
    echo.
    start "" /b node scripts\repair-ncm-and-open.mjs
    call npm run dev:ncm
    exit /b %ERRORLEVEL%
  )

  call node scripts\ensure-ncm-login.mjs
  if errorlevel 1 (
    echo.
    echo [ERROR] NCM login recovery did not complete.
    echo.
    pause
    exit /b 1
  )

  echo [READY] MusicGPT and NCM are healthy. Opening the existing page...
  start "" "http://127.0.0.1:5173"
  timeout /t 2 /nobreak >nul
  exit /b 0
)

powershell.exe -NoLogo -NoProfile -NonInteractive -Command "$busy = @(); foreach ($port in 5173, 8787) { $client = [Net.Sockets.TcpClient]::new(); try { $client.Connect('127.0.0.1', $port); $busy += $port } catch {} finally { $client.Dispose() } }; if ($busy.Count -gt 0) { Write-Host ('[ERROR] Required port(s) already in use: ' + ($busy -join ', ')); exit 1 }"
if errorlevel 1 (
  echo [ERROR] Stop the program using the port, then run this launcher again.
  echo.
  pause
  exit /b 1
)

echo [START] Starting NCM API, MusicGPT server, and web app...
echo [START] The browser will open at http://127.0.0.1:5173
echo [STOP]  Press Ctrl+C in this window to stop all services.
echo.

start "" /b powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -Command "$ProgressPreference = 'SilentlyContinue'; $deadline = (Get-Date).AddMinutes(2); do { try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:5173'; if ($response.StatusCode -lt 500) { Start-Process 'http://127.0.0.1:5173'; exit 0 } } catch {}; Start-Sleep -Seconds 1 } while ((Get-Date) -lt $deadline)" >nul 2>&1

call npm run dev
set "MUSICGPT_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%MUSICGPT_EXIT_CODE%"=="0" (
  echo [ERROR] MusicGPT stopped with exit code %MUSICGPT_EXIT_CODE%.
) else (
  echo [DONE] MusicGPT has stopped.
)
echo.
pause
exit /b %MUSICGPT_EXIT_CODE%
