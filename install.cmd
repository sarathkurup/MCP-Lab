@echo off
setlocal EnableDelayedExpansion

rem ============================================================================
rem  MCPilot - build, package and install into VS Code.
rem
rem  Usage:
rem    install.cmd                  Install into VS Code (stable)
rem    install.cmd code-insiders    Install into VS Code Insiders
rem    install.cmd --uninstall      Remove the extension
rem
rem  Requires Node 20+ and npm. Packaging downloads @vscode/vsce on first run.
rem ============================================================================

cd /d "%~dp0"

set "EXT_ID=mcpilot.mcpilot"
set "VSIX=mcpilot.vsix"
set "CODE_CMD="
set "UNINSTALL="

rem --- arguments --------------------------------------------------------------
:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="--uninstall" (
    set "UNINSTALL=1"
) else if /i "%~1"=="-u" (
    set "UNINSTALL=1"
) else if /i "%~1"=="--help" (
    goto usage
) else if /i "%~1"=="-h" (
    goto usage
) else (
    set "CODE_CMD=%~1"
)
shift
goto parse_args
:args_done

rem --- locate the VS Code CLI -------------------------------------------------
if defined CODE_CMD goto verify_code

for %%C in (code.cmd) do set "CODE_CMD=%%~$PATH:C"
if defined CODE_CMD goto verify_code

rem Not on PATH: check the usual install locations.
for %%P in (
    "%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd"
    "%ProgramFiles%\Microsoft VS Code\bin\code.cmd"
    "%ProgramFiles(x86)%\Microsoft VS Code\bin\code.cmd"
    "%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd"
    "%ProgramFiles%\Microsoft VS Code Insiders\bin\code-insiders.cmd"
) do (
    if exist %%P (
        set "CODE_CMD=%%~P"
        goto verify_code
    )
)

echo [ERROR] Could not find the VS Code command line tool.
echo.
echo   Open VS Code, press Ctrl+Shift+P and run:
echo     Shell Command: Install 'code' command in PATH
echo.
echo   Then run this script again, or pass the path explicitly:
echo     install.cmd "C:\path\to\bin\code.cmd"
exit /b 1

:verify_code
call "%CODE_CMD%" --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] "%CODE_CMD%" did not run. Is that the VS Code CLI?
    exit /b 1
)
echo Using VS Code CLI: %CODE_CMD%

rem --- uninstall --------------------------------------------------------------
if defined UNINSTALL (
    echo Removing %EXT_ID% ...
    call "%CODE_CMD%" --uninstall-extension %EXT_ID%
    if errorlevel 1 (
        echo [ERROR] Uninstall failed. It may not have been installed.
        exit /b 1
    )
    echo Done. Restart VS Code to finish removing it.
    exit /b 0
)

rem --- toolchain --------------------------------------------------------------
where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm was not found on PATH. Install Node.js 20 or newer.
    exit /b 1
)

rem --- dependencies -----------------------------------------------------------
if not exist "node_modules" (
    echo Installing build dependencies ...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        exit /b 1
    )
)

rem --- build ------------------------------------------------------------------
echo Building extension, webview and CLI bundles ...
call npm run build
if errorlevel 1 (
    echo [ERROR] Build failed.
    exit /b 1
)

if not exist "dist\extension.js" (
    echo [ERROR] dist\extension.js is missing after the build.
    exit /b 1
)

rem --- package ----------------------------------------------------------------
rem  --no-dependencies:          everything is bundled by esbuild already
rem  --allow-missing-repository: this is a local build, not a marketplace one
echo Packaging %VSIX% ...
if exist "%VSIX%" del /q "%VSIX%"

call npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository -o "%VSIX%"
if errorlevel 1 (
    echo [ERROR] Packaging failed.
    echo         If this is a network problem, install vsce once with:
    echo           npm install -g @vscode/vsce
    exit /b 1
)

if not exist "%VSIX%" (
    echo [ERROR] %VSIX% was not produced.
    exit /b 1
)

rem --- install ----------------------------------------------------------------
echo Installing into VS Code ...
call "%CODE_CMD%" --install-extension "%CD%\%VSIX%" --force
if errorlevel 1 (
    echo [ERROR] Install failed.
    exit /b 1
)

echo.
echo ============================================================
echo  MCPilot installed.
echo.
echo  Restart VS Code, then open the MCPilot view in the
echo  activity bar, or run "MCP: Add Server" from the palette.
echo.
echo  To try it against the sample servers, open the demo folder:
echo    %CD%\demo
echo.
echo  To remove it:  install.cmd --uninstall
echo ============================================================
exit /b 0

:usage
echo MCPilot installer
echo.
echo   install.cmd                       Build, package and install into VS Code
echo   install.cmd code-insiders         Install into VS Code Insiders instead
echo   install.cmd "C:\...\code.cmd"     Use a specific VS Code CLI
echo   install.cmd --uninstall           Remove the extension
exit /b 0
