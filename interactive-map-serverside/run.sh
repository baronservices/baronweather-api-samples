#!/bin/bash
# Start the server-side Baron map. Creates a virtual environment on first run.
set -euo pipefail

cd "$(dirname "$0")"

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
