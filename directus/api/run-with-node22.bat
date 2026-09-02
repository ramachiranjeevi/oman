@echo off
rem Directus's isolated-vm native module is prebuilt against Node 22's ABI.
rem The system/global Node may be a different major version, which crashes
rem on startup with ERR_DLOPEN_FAILED (NODE_MODULE_VERSION mismatch). Pin
rem the bundled Node 22 here so `pnpm dev` always uses a matching runtime.
set "NODE_HOME=%~dp0..\..\.tools\node-v22.22.0-win-x64"
set "PATH=%NODE_HOME%;%PATH%"
cd /d "%~dp0"
call pnpm run dev
