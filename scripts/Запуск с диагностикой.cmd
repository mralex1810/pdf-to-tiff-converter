@echo off
setlocal
cd /d "%~dp0"
set "PDFTIFF_LOGDIR=%LOCALAPPDATA%\PdfToTiff\Logs"
if not defined LOCALAPPDATA set "PDFTIFF_LOGDIR=%TEMP%\PdfToTiff\Logs"
if not exist "%PDFTIFF_LOGDIR%" mkdir "%PDFTIFF_LOGDIR%" 2>nul
if not exist "%PDFTIFF_LOGDIR%" (
    echo Cannot create the diagnostic folder.
    if /I not "%~1"=="--no-pause" pause
    exit /b 1
)
set "DOTNET_HOST_TRACE=1"
set "DOTNET_HOST_TRACE_VERBOSITY=4"
set "DOTNET_HOST_TRACEFILE=%PDFTIFF_LOGDIR%\host-startup.log"
set "COREHOST_TRACE=1"
set "COREHOST_TRACE_VERBOSITY=4"
set "COREHOST_TRACEFILE=%PDFTIFF_LOGDIR%\host-startup-legacy.log"
>"%PDFTIFF_LOGDIR%\launcher.log" echo Diagnostic launch: %DATE% %TIME%
>>"%PDFTIFF_LOGDIR%\launcher.log" ver
>>"%PDFTIFF_LOGDIR%\launcher.log" echo Process architecture: %PROCESSOR_ARCHITECTURE%
>>"%PDFTIFF_LOGDIR%\launcher.log" echo Application: %~dp0PdfToTiff.exe
if not exist "%~dp0PdfToTiff.exe" (
    echo PdfToTiff.exe is missing. Extract the entire ZIP first.
    >>"%PDFTIFF_LOGDIR%\launcher.log" echo PdfToTiff.exe is missing.
    if /I not "%~1"=="--no-pause" pause
    exit /b 1
)
echo Starting PDF to TIFF. Close the application to finish diagnostics.
start "" /wait "%~dp0PdfToTiff.exe" --diagnostic 1>"%PDFTIFF_LOGDIR%\stdout.log" 2>"%PDFTIFF_LOGDIR%\stderr.log"
set "PDFTIFF_EXIT=%ERRORLEVEL%"
>>"%PDFTIFF_LOGDIR%\launcher.log" echo Exit code: %PDFTIFF_EXIT%
echo Exit code: %PDFTIFF_EXIT%
echo Diagnostic files: "%PDFTIFF_LOGDIR%"
if /I not "%~1"=="--no-pause" explorer.exe "%PDFTIFF_LOGDIR%"
if /I not "%~1"=="--no-pause" pause
exit /b %PDFTIFF_EXIT%
