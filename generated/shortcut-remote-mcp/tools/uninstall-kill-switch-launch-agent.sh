#!/usr/bin/env bash
set -euo pipefail

LABEL="local.shortcut-remote.kill-switch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
launchctl disable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Removed LaunchAgent: $PLIST"
echo "The app bundle is left in ~/Applications so you can still launch it manually."
