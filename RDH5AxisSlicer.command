#!/bin/bash
# ======================================================================
#  Double-click this file to start RDH5AxisSlicer on macOS
#  (RDH5AxisSlicer.sh is the same script for Linux).
#  First run: creates a private Python environment in .venv and installs
#  the libraries (a few minutes). Later runs start straight away.
# ======================================================================
cd "$(dirname "$0")" || exit 1

fail() {
    echo
    echo "$1"
    read -r -p "Press Enter to close..."
    exit 1
}

if [ ! -x .venv/bin/python ]; then
    echo "First run: setting up RDH5AxisSlicer. This only happens once..."
    python3 -m venv .venv || fail "Could not find Python 3.11 or newer. Install it from https://www.python.org/downloads/ and try again."
fi

# Re-install libraries whenever requirements.txt has changed.
if ! cmp -s requirements.txt .venv/installed-requirements.txt; then
    echo "Installing libraries..."
    .venv/bin/python -m pip install --upgrade pip >/dev/null
    .venv/bin/python -m pip install -r requirements.txt || fail "Installing libraries failed - see the messages above."
    cp requirements.txt .venv/installed-requirements.txt
fi

.venv/bin/python -m segslicer "$@" || fail "RDH5AxisSlicer stopped with an error (details above)."
