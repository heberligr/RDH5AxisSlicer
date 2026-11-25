"""Start the app.

Usually you just double-click a launcher in the repo folder:
    Windows: RDH5AxisSlicer.bat     macOS: RDH5AxisSlicer.command     Linux: RDH5AxisSlicer.sh

From a terminal you can also run:
    python -m segslicer [model.stl | project.json] [--machine machine.yaml]
"""

from __future__ import annotations

import argparse
import sys
import traceback
from pathlib import Path

from .config import DEFAULT_MACHINE_PATH, DEFAULT_SETTINGS_PATH, load_machine, load_settings

# When started without a console (double-click on Windows), print() and error
# messages have nowhere to go, so we write them to this file instead.
LOG_PATH = Path(__file__).resolve().parent.parent / "segslicer.log"


def _redirect_output_if_no_console() -> None:
    if sys.stdout is None or sys.stderr is None:
        log = open(LOG_PATH, "w", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or log
        sys.stderr = sys.stderr or log


def main() -> None:
    _redirect_output_if_no_console()
    parser = argparse.ArgumentParser(description="Segmented 3+2 slicer for a 5-axis FDM printer")
    parser.add_argument("model", nargs="?", help="STL file or project .json to open")
    parser.add_argument("--machine", default=str(DEFAULT_MACHINE_PATH), help="machine.yaml to use")
    parser.add_argument("--settings", default=str(DEFAULT_SETTINGS_PATH), help="settings.yaml to use")
    args = parser.parse_args()

    try:
        machine = load_machine(args.machine)
        settings = load_settings(args.settings)
        print(f"Machine: {machine.name} ({machine.firmware}), pivot {machine.kinematics.pivot.tolist()}")

        # Import here so `--help` works even if the GUI library has issues.
        from .viewer import SlicerViewer

        SlicerViewer(machine, settings, args.model).run()
    except Exception:
        # Make sure a crash is never silent, even with no console window.
        traceback.print_exc()
        print(
            f"\nsegslicer crashed. Details are above (also saved to {LOG_PATH.name} "
            "if it was started by double-clicking).",
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
