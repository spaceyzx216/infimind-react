@echo off
REM fafee AI admin console - Windows double-click entry.
REM Close this window to stop the SSH tunnel.
cd /d "%~dp0\..\.."
node scripts\ops\admin-open.mjs
set "ADMIN_OPEN_EXIT=%ERRORLEVEL%"
echo.
echo Close this window to stop the SSH tunnel.
pause
exit /b %ADMIN_OPEN_EXIT%
