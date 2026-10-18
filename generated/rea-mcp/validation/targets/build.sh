#!/usr/bin/env bash
# Builds the REA parity targets from the sources in this directory. Run it inside the
# isolated VM, not on a developer host. Needs clang (Xcode Command Line Tools) and sqlite3;
# go is optional (without it there is no Go target, and the suite skips inspect_go_binary).
# Usage: ./build.sh [output directory, default ./build]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/build}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

clang -O0 -o "$out/parity-native" "$here/parity.c"
if command -v go >/dev/null 2>&1; then
  (cd "$here" && CGO_ENABLED=0 go build -o "$out/parity-go" main.go)
else
  echo "go not found: skipping the Go target" >&2
fi

cat > "$out/parity.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>org.mcpaql.parity-fixture</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>ParityFlags</key>
  <array>
    <string>alpha</string>
    <string>beta</string>
  </array>
</dict>
</plist>
PLIST

rm -f "$out/parity.sqlite"
sqlite3 "$out/parity.sqlite" <<'SQL'
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings VALUES ('mode', 'parity'), ('retries', '3');
CREATE INDEX settings_value ON settings (value);
SQL

echo "built parity targets in $out"
ls -l "$out"
