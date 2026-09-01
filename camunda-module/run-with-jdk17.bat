@echo off
set "JAVA_HOME=C:\Users\HYADMIN\Desktop\projects\oman\.tools\jdk-17.0.13+11"
set "PATH=%JAVA_HOME%\bin;%PATH%"
cd /d "%~dp0"
call "%~dp0internal\run.bat" start
