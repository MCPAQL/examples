#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-$HOME/Applications/Shortcut Remote Kill Switch.app}"
LABEL="local.shortcut-remote.kill-switch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
EXECUTABLE="$APP_DIR/Contents/MacOS/ShortcutRemoteKillSwitch"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if [[ ! -x "$EXECUTABLE" ]]; then
  "$SCRIPT_DIR/build-kill-switch-app.sh" "$APP_DIR"
fi

mkdir -p "$HOME/Library/LaunchAgents"

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true

pgrep -f "$EXECUTABLE" 2>/dev/null | while read -r pid; do
  [[ -n "$pid" ]] || continue
  /bin/kill -TERM "$pid" 2>/dev/null || true
done

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$EXECUTABLE</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>/tmp/shortcut-remote-kill-switch.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/shortcut-remote-kill-switch.err.log</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST" >/dev/null

if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$APP_DIR" >/dev/null 2>&1 || true
fi

launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Installed LaunchAgent: $PLIST"
echo "Registered app: $APP_DIR"
launchctl print "gui/$(id -u)/$LABEL" | sed -n '1,18p'
