@echo off
rem ======================================================================
rem  Double-click this file to start RDH5AxisSlicer on Windows.
rem  First run: creates a private Python environment in .venv and installs
rem  the libraries (a few minutes). Later runs start straight away.
rem  You can also drag an .stl or project .json onto this file.
rem ======================================================================
cd /d "%~dp0"

if not exist ".venv\Scripts\pythonw.exe" (
    echo First run: setting up RDH5AxisSlicer. This only happens once...
    py -3 -m venv .venv 2>nul || python -m venv .venv
    if not exist ".venv\Scripts\pythonw.exe" (
        echo.
        echo Could not find Python 3.11 or newer.
        echo Install it from https://www.python.org/downloads/
        echo and tick "Add python.exe to PATH" in the installer, then try again.
        pause
        exit /b 1
    )
)

rem Re-install libraries whenever requirements.txt has changed.
fc /b requirements.txt ".venv\installed-requirements.txt" >nul 2>&1
if errorlevel 1 (
    echo Installing libraries...
    ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo.
        echo Installing libraries failed - see the messages above.
        pause
        exit /b 1
    )
    copy /y requirements.txt ".venv\installed-requirements.txt" >nul
)

rem pythonw = no console window. Errors go to segslicer.log in this folder.
start "" ".venv\Scripts\pythonw.exe" -m segslicer %*
