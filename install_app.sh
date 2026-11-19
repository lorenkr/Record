#!/bin/bash
# Installs Vinyl Player as a Mac app.
#
#   ./install_app.sh              install the app + open it automatically whenever Spotify opens
#   ./install_app.sh --no-auto    install the app only (open it yourself from Launchpad/Spotlight)
#   ./install_app.sh --uninstall  remove everything
#
# The app gets its own copy of the code in ~/Library/Application Support/Vinyl Player,
# so it keeps working even if this project folder is moved or deleted.
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
HOME_DIR="$HOME/Library/Application Support/Vinyl Player"
APP="$HOME/Applications/Vinyl Player.app"
LABEL="com.lorenkr.vinylplayer"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/VinylPlayer.log"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

if [ "$1" = "--uninstall" ]; then
  rm -rf "$APP" "$AGENT" "$HOME_DIR"
  echo "Vinyl Player removed."
  exit 0
fi

# 1. Copy the code (and your Spotify keys / login) to a stable place.
mkdir -p "$HOME_DIR"
cp "$SRC/record.py" "$SRC/spotifyPlay.py" "$SRC/requirements.txt" "$SRC/Vinyl Player.command" "$HOME_DIR/"
[ -f "$SRC/.env" ] && cp "$SRC/.env" "$HOME_DIR/.env"
[ -f "$SRC/.cache" ] && [ ! -f "$HOME_DIR/.cache" ] && cp "$SRC/.cache" "$HOME_DIR/.cache"
chmod +x "$HOME_DIR/Vinyl Player.command"

# 2. Install dependencies there and render the icon.
echo "Installing (first time takes about a minute)…"
"$HOME_DIR/Vinyl Player.command" --icon "$HOME_DIR/icon.png"

# 3. Build the .app. Python itself is copied inside the bundle, so macOS shows
#    "Vinyl Player" with its own icon in the Dock instead of "Python".
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
PYAPP_BIN="$("$HOME_DIR/.venv/bin/python" -c 'import sys; print(sys.base_prefix)')/Resources/Python.app/Contents/MacOS/Python"
SITE="$("$HOME_DIR/.venv/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
cp "$PYAPP_BIN" "$APP/Contents/MacOS/Vinyl Player"
cat > "$HOME_DIR/launch.py" <<PY
# Starts record.py with the app's own packages (used by Vinyl Player.app).
import runpy, site, sys
site.addsitedir("$SITE")
sys.path.insert(0, "$HOME_DIR")
runpy.run_path("$HOME_DIR/record.py", run_name="__main__")
PY
cat > "$APP/Contents/MacOS/VinylPlayer" <<SH
#!/bin/bash
# Opened by hand: show the player now (it keeps following Spotify afterwards).
# Started at login (--background): stay hidden until Spotify opens.
cd "$HOME_DIR"
ARGS=(--follow-spotify --show)
[ "\$1" = "--background" ] && ARGS=(--follow-spotify)
BIN="$APP/Contents/MacOS/Vinyl Player"
if [ "\$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
  exec arch -arm64 "\$BIN" "$HOME_DIR/launch.py" "\${ARGS[@]}" >> "$LOG" 2>&1
fi
exec "\$BIN" "$HOME_DIR/launch.py" "\${ARGS[@]}" >> "$LOG" 2>&1
SH
chmod +x "$APP/Contents/MacOS/VinylPlayer"

ICONSET="$(mktemp -d)/icon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$HOME_DIR/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$HOME_DIR/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Vinyl Player</string>
  <key>CFBundleDisplayName</key><string>Vinyl Player</string>
  <key>CFBundleIdentifier</key><string>$LABEL.app</string>
  <key>CFBundleExecutable</key><string>VinylPlayer</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.1</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSArchitecturePriority</key><array><string>arm64</string><string>x86_64</string></array>
</dict></plist>
PLIST
codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
echo "Installed: $APP"

# 4. Background helper: starts at login, shows the player whenever Spotify opens.
rm -f "$AGENT"
if [ "$1" != "--no-auto" ]; then
  mkdir -p "$(dirname "$AGENT")"
  cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$APP/Contents/MacOS/VinylPlayer</string>
    <string>--background</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PLIST
  launchctl bootstrap "gui/$(id -u)" "$AGENT"
  echo "It will now appear on top whenever you open Spotify (also after restarting the Mac)."
fi
