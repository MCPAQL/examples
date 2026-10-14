#!/usr/bin/env node
// Observational HID discovery tool.
// Lists matching devices, opens each, streams raw input reports to stdout as JSON.
// Used by the JIT discovery loop: a human oracle presses buttons; we record byte layouts.

import HID from "node-hid";

const VENDOR_ID = 0x28bd;
const PRODUCT_ID = 0x0202;

const all = HID.devices();
const matches = all.filter((d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID);

if (matches.length === 0) {
  console.error(JSON.stringify({ event: "no_devices_found", vendor_id: VENDOR_ID, product_id: PRODUCT_ID }));
  process.exit(1);
}

// Dedupe by path — node-hid lists one entry per usage_page+usage advertised on each interface,
// but each unique path is a single openable HID handle.
const seen = new Set();
const uniqueByPath = matches.filter((d) => (seen.has(d.path) ? false : (seen.add(d.path), true)));

// SAFETY: by default only open vendor-defined pages (>= 0xFF00). Opening generic-desktop or
// digitizer interfaces would steal HID input from the OS and break the device's normal use.
// Override with MCPAQL_HID_OPEN_ALL=1 (don't, unless you know what that means).
const openAll = process.env.MCPAQL_HID_OPEN_ALL === "1";
const safeToOpen = openAll
  ? uniqueByPath
  : uniqueByPath.filter((d) => (d.usagePage ?? 0) >= 0xff00);

console.error(JSON.stringify({
  event: "devices_found",
  total_listings: matches.length,
  unique_paths: uniqueByPath.length,
  filtered_to_open: safeToOpen.length,
  policy: openAll ? "open_all" : "vendor_pages_only",
}));
for (const d of uniqueByPath) {
  const willOpen = safeToOpen.includes(d);
  console.error(JSON.stringify({ event: "device", will_open: willOpen, info: d }));
}
const matchesToOpen = safeToOpen;

const handles = [];
for (const info of matchesToOpen) {
  try {
    const dev = new HID.HID(info.path);
    const tag = `usagePage=0x${(info.usagePage ?? 0).toString(16)} usage=0x${(info.usage ?? 0).toString(16)} interface=${info.interface}`;
    console.error(JSON.stringify({ event: "opened", path: info.path, tag }));
    dev.on("data", (buf) => {
      const bytes = Array.from(buf);
      const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
      const record = {
        event: "input_report",
        ts: Date.now(),
        path: info.path,
        usage_page: info.usagePage,
        usage: info.usage,
        interface: info.interface,
        length: bytes.length,
        bytes,
        hex,
      };
      // stdout = data, stderr = log — clean separation for piping into jq.
      process.stdout.write(JSON.stringify(record) + "\n");
    });
    dev.on("error", (err) => {
      console.error(JSON.stringify({ event: "error", path: info.path, message: String(err) }));
    });
    handles.push(dev);
  } catch (err) {
    console.error(JSON.stringify({ event: "open_failed", path: info.path, message: String(err) }));
  }
}

console.error(JSON.stringify({ event: "ready", handles: handles.length, instruction: "Press buttons. Each press emits an input_report on stdout." }));

const shutdown = () => {
  for (const dev of handles) { try { dev.close(); } catch {} }
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
