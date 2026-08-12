#!/bin/bash
# Start the server-side Baron map. Creates a virtual environment on first run.
set -euo pipefail

cd "$(dirname "$0")"

# Python 3.10 or newer is required, and the failure without this check is
# thoroughly misleading. The code uses `str | None` annotations at module
# scope, which 3.9 evaluates at import and rejects with a TypeError — but pip
# fails first, saying it cannot find uvicorn==0.42.0, which reads as a broken
# package index or a typo'd pin rather than "your Python is too old". macOS
# still ships 3.9 as /usr/bin/python3, so this is the default first-run path
# for anyone without pyenv.
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  echo "Error: Python 3.10 or newer is required."
  echo "       Found $(python3 --version 2>&1) at $(command -v python3)."
  echo
  echo "       Install a newer Python, or point this script at one:"
  echo "         PATH=/path/to/python3.11/bin:\$PATH ./run.sh"
  exit 1
fi

if [ ! -d venv ]; then
  echo "Creating the virtual environment…"
  python3 -m venv venv
fi

source venv/bin/activate
pip install -q -r requirements.txt

if [ ! -f .env ]; then
  # A warning rather than an exit. The server starts, serves the page, and
  # shows the setup message in the panel; exiting here would hide that path
  # and make a missing .env look like a broken app.
  echo
  echo "WARNING: no .env found. Copy env.example to .env and add your key."
  echo "         The map will load without weather until you do."
  echo
fi

echo "Serving on http://localhost:8000/  (Ctrl-C to stop)"
exec uvicorn main:app --port 8000 --reload
