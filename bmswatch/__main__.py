"""Allow `python -m bmswatch` as well as `python -m bmswatch.cli`."""

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
