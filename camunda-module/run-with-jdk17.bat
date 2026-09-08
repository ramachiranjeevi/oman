@echo off
rem Pin JDK 17 from the repo's .tools/ folder (relative to this script),
rem so the path stays valid after the project is moved between machines.
set "JAVA_HOME=%~dp0..\.tools\jdk-17.0.13+11"
if not exist "%JAVA_HOME%\bin\java.exe" (
  echo JAVA_HOME "%JAVA_HOME%" path doesn't exist
  exit /b 1
)
set "PATH=%JAVA_HOME%\bin;%PATH%"
cd /d "%~dp0"
call "%~dp0internal\run.bat" start
