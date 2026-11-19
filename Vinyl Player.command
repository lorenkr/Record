#!/bin/bash
# Double-click to start the Vinyl Player. The first run sets everything up (about a minute).
cd "$(dirname "$0")" || exit 1
PY=".venv/bin/python"
if ! "$PY" -c "import sys" >/dev/null 2>&1; then
  echo "First run: setting things up…"
  rm -rf .venv
  python3 -m venv .venv || { echo "Python 3 is required: https://www.python.org/downloads/"; read -r; exit 1; }
fi
STAMP=".venv/.requirements.sha"
SUM=$(shasum requirements.txt | cut -d' ' -f1)
if [ "$(cat "$STAMP" 2>/dev/null)" != "$SUM" ]; then
  echo "Installing dependencies…"
  "$PY" -m pip install -q --disable-pip-version-check -r requirements.txt && echo "$SUM" > "$STAMP"
fi
# macOS sometimes flags files as "hidden"; Qt then can't find its plugins. Clear that flag.
PLUGIN=$(ls -d .venv/lib/python3*/site-packages/PySide6/Qt/plugins/platforms/libqcocoa.dylib 2>/dev/null | head -1)
if [ -n "$PLUGIN" ] && [ "$(stat -f %Sf "$PLUGIN")" != "-" ]; then
  chflags -R nohidden .venv
fi
exec "$PY" record.py "$@"
