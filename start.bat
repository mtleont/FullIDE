@echo off
cd /d "%~dp0"
start "" "http://localhost:6248"
node server.js
