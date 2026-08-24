@echo off
rem Build every Vigil release artifact into the release\ folder:
rem   Vigil-<version>-Setup.exe     assisted installer with the start-at-login page
rem   Vigil-<version>-Portable.exe  single-file portable build, no install needed
rem   Vigil-<version>-win.zip       plain zip of the unpacked app
rem
rem Needs Node.js on this machine (the machine that builds, not the machines
rem that install). Bump "version" in package.json before a new release.

cd /d "%~dp0.."
echo === Installing dependencies...
call npm install || goto :fail
echo === Building release artifacts...
call npx electron-builder --win || goto :fail
echo.
echo === Done. Artifacts are in the release\ folder:
dir /b release\Vigil-*
pause
exit /b 0

:fail
echo.
echo === BUILD FAILED, see output above.
pause
exit /b 1
