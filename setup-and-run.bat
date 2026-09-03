@echo off
rem Fully automated setup + run for a fresh checkout of this repo, on
rem Windows. Batch has no native way to download files or extract zips,
rem so this is a thin wrapper around setup-and-run.ps1, which does the
rem actual work (see that file for exactly what it does).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-and-run.ps1"
