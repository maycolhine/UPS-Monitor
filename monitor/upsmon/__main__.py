"""Allows running the application with `python3 -m upsmon`."""
import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
