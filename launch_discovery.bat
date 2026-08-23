@echo off
title Guided Discovery - Live Flow Recording
cd /d "c:\AI-Testing\ai-admin-module-py"
set CASE_ID=%1
if "%CASE_ID%"=="" set CASE_ID=1
echo ===================================================
echo Starting Guided Discovery for Test Case ID %CASE_ID%...
echo ===================================================
python app/services/automation/guided_discovery_runner.py %CASE_ID%
echo.
echo Discovery session completed. Objects saved to database.
pause
