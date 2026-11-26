@echo off
cd /d "%~dp0"
title Snagly - local playlist downloader
node server.js
echo.
echo Snagly stopped.
pause
