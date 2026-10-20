#!/usr/bin/env bash
# Builds the REA parity targets from the sources in this directory. Run it inside the
# isolated VM, not on a developer host. Needs clang (Xcode Command Line Tools), sqlite3, node and
# zip. go is optional: without it there are no Go, PE or ELF targets, and the suite skips the
# operations that read them.
# Usage: ./build.sh [output directory, default ./build]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-$here/build}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

clang -O0 -o "$out/parity-native" "$here/parity.c"
if command -v go >/dev/null 2>&1; then
  (cd "$here" && CGO_ENABLED=0 go build -o "$out/parity-go" main.go)
  # The same program as a Windows PE and a Linux ELF, for the PE and ELF inspectors.
  (cd "$here" && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o "$out/parity-pe.exe" main.go)
  (cd "$here" && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags=-s -o "$out/parity-pe-stripped.exe" main.go)
  (cd "$here" && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -o "$out/parity-elf" main.go)
else
  echo "go not found: skipping the Go, PE and ELF targets" >&2
fi

# Hand-built fixtures (see fixtures.mjs), then the two native fixtures that use them.
node "$here/fixtures.mjs" "$out"
clang -O0 -I "$out" -o "$out/parity-audit" "$here/parity-audit.c"
clang -O0 -o "$out/parity-fuses" "$here/parity-fuses.c"
cp "$out/parity-native" "$out/parity.app/Contents/MacOS/parity-native"
resources="$out/parity.app/Contents/Resources"
plutil -convert binary1 -o "$resources/parity.archive" "$resources/parity.archive.xml"
plutil -convert binary1 -o "$resources/Base.lproj/Main.nib" "$resources/Base.lproj/Main.nib.xml"
rm "$resources/parity.archive.xml" "$resources/Base.lproj/Main.nib.xml"
rm -f "$out/parity.sr"
(cd "$out/parity-sr" && zip -q -X "$out/parity.sr" version metadata logic-1-1)

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
