#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="Shortcut Remote Kill Switch"
APP_DIR="${1:-$HOME/Applications/$APP_NAME.app}"
BIN_NAME="ShortcutRemoteKillSwitch"

mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

swiftc "$SCRIPT_DIR/ShortcutRemoteKillSwitch.swift" \
  -framework AppKit \
  -o "$APP_DIR/Contents/MacOS/$BIN_NAME"

cp "$SCRIPT_DIR/kill-shortcut-remote-mcp.sh" "$APP_DIR/Contents/Resources/kill-shortcut-remote-mcp.sh"
chmod +x "$APP_DIR/Contents/MacOS/$BIN_NAME" "$APP_DIR/Contents/Resources/kill-shortcut-remote-mcp.sh"

cat > "$APP_DIR/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$BIN_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>local.shortcut-remote.kill-switch</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>ShortcutRemoteMCPRoot</key>
  <string>$ROOT_DIR</string>
</dict>
</plist>
EOF

/usr/bin/codesign --force --sign - "$APP_DIR" >/dev/null 2>&1 || true

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$APP_DIR" >/dev/null 2>&1 || true
fi

echo "Built $APP_DIR"
echo "Open it with: open \"$APP_DIR\""
