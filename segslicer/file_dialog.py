"""Native "Open file" / "Save file" dialogs, so you never have to type paths.

Polyscope (our 3D window) has no file dialog, so we borrow Tkinter's, which
ships with the standard Python installers for Windows and macOS.

Why a separate process? Tkinter and Polyscope both want to own the GUI event
loop, and on macOS running both in one process can crash. Starting a tiny
helper Python that shows only the dialog and prints the chosen path avoids
that completely. The 3D window waits while the dialog is open.

If Tkinter isn't installed (some Linux Pythons), these functions return None
and the UI falls back to the path text boxes.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

# Code run by the helper process. Arguments: mode, title, filetypes (JSON),
# start folder. Prints the chosen path (empty if cancelled).
_HELPER = r"""
import json, sys
import tkinter as tk
from tkinter import filedialog
mode, title, filetypes, start = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), sys.argv[4]
root = tk.Tk()
root.withdraw()
root.attributes("-topmost", True)  # show the dialog in front of the 3D window
kwargs = dict(title=title, filetypes=[tuple(f) for f in filetypes], initialdir=start, parent=root)
if mode == "save":
    path = filedialog.asksaveasfilename(defaultextension=filetypes[0][1].lstrip("*"), **kwargs)
else:
    path = filedialog.askopenfilename(**kwargs)
print(path or "")
"""


class DialogUnavailable(RuntimeError):
    """Raised when no file dialog can be shown (e.g. Tkinter is missing)."""


def _run(mode: str, title: str, filetypes: list[tuple[str, str]], start_dir: str | Path) -> str | None:
    extra = {}
    if sys.platform == "win32":
        extra["creationflags"] = subprocess.CREATE_NO_WINDOW  # no black console flash
    try:
        result = subprocess.run(
            [sys.executable, "-c", _HELPER, mode, title, json.dumps(filetypes), str(start_dir)],
            capture_output=True,
            text=True,
            **extra,
        )
    except OSError as exc:
        raise DialogUnavailable(str(exc)) from exc
    if result.returncode != 0:
        raise DialogUnavailable(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "unknown error")
    path = result.stdout.strip()
    return path or None  # None = user pressed Cancel


def ask_open(title: str, filetypes: list[tuple[str, str]], start_dir: str | Path = ".") -> str | None:
    """Show an Open dialog. Returns the path, or None if cancelled."""
    return _run("open", title, filetypes, start_dir)


def ask_save(title: str, filetypes: list[tuple[str, str]], start_dir: str | Path = ".") -> str | None:
    """Show a Save As dialog. Returns the path, or None if cancelled."""
    return _run("save", title, filetypes, start_dir)


STL_TYPES = [("3D models", "*.stl *.obj *.3mf *.ply"), ("All files", "*.*")]
PROJECT_TYPES = [("Slicer project", "*.json"), ("All files", "*.*")]
