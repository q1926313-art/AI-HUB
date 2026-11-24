@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1"
if errorlevel 1 (
  echo AI Hub installation failed. See the message above.
  pause
  exit /b 1
)
echo You can now open AI Hub from the Start menu.
pause
