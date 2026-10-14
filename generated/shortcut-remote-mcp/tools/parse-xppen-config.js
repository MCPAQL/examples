#!/usr/bin/env node
// Parse ~/.xppen/config.xml and extract the Shortcut Remote (ACK05) mappings
// across all four layers (Layer I = <K>, II = <K_1>, III = <K_2>, IV = <K_3>).
// Emit a clean JSON file the adapter and HUD can consume.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.XPPEN_CONFIG ?? `${process.env.HOME}/.xppen/config.xml`;
const OUT_PATH = process.env.OUT_PATH ?? join(__dirname, "..", "adapter", "src", "xppen-mappings.json");

const xml = readFileSync(CONFIG_PATH, "utf8");

// Find the <ACK05>...</ACK05> block.
const ack05Match = xml.match(/<ACK05>([\s\S]*?)<\/ACK05>/);
if (!ack05Match) {
  console.error("No <ACK05> block found in config — Shortcut Remote not configured?");
  process.exit(1);
}
const ack05 = ack05Match[1];

// Find the CommonAPP block (the device-default mappings, used when no per-app override).
const commonAppMatch = ack05.match(/<CommonAPP>([\s\S]*?)<\/CommonAPP>/);
if (!commonAppMatch) {
  console.error("No <CommonAPP> in ACK05 block.");
  process.exit(1);
}
const commonApp = commonAppMatch[1];

// Layers: <K id="1">...</K> is Layer I, <K_1>...</K_1> is II, <K_2> is III, <K_3> is IV.
const LAYER_TAGS = [
  { tag: "K",   layer: "I"   },
  { tag: "K_1", layer: "II"  },
  { tag: "K_2", layer: "III" },
  { tag: "K_3", layer: "IV"  },
];

function parseKEntry(line) {
  // Examples:
  //   <K1 id="0" Show="1" Actid="110" Motid="1"/>
  //   <K3 id="1" Show="1" Actid="24" Motid="3">1|Claude Desktop|Control+Option+Command+2|16777249:59+16777251:58+16777250:55+50:19</K3>
  //   <K10 id="1" Show="1" Actid="8" Motid="10">1|Apple Dictation||63289:71</K10>
  const m = line.match(/<K(\d+) id="(\d+)" Show="(\d+)" Actid="(\d+)" Motid="(\d+)"(?:\/>|>([^<]*)<\/K\d+>)/);
  if (!m) return null;
  const [, num, id, show, actid, motid, payload] = m;
  const out = {
    k_index: Number(num),
    motid: Number(motid),
    actid: Number(actid),
    show: show === "1",
    customized: id === "1",
  };
  if (payload) {
    // payload format: "<type>|<label>|<human_shortcut>|<encoded_keys>"
    // or for modifier holds: "2|Option|2"
    // or with empty human-shortcut: "1|Apple Dictation||63289:71"
    const parts = payload.split("|");
    out.action_type = parts[0]; // "1" = keystroke combo, "2" = modifier hold, etc.
    out.label = parts[1] ?? null;
    out.human_shortcut = parts[2] ?? null;
    out.encoded_keys = parts[3] ?? null;
    out.keystrokes = parseEncodedKeys(out.encoded_keys);
  } else {
    // No payload — uses XP-Pen built-in default for the Actid (not extractable from XML).
    out.label = null;
    out.human_shortcut = null;
    out.encoded_keys = null;
    out.keystrokes = null;
    out.note = "uses built-in default action (definition lives in XP-Pen app binary, not in config)";
  }
  return out;
}

// Decode "16777251:58+16777250:55+49:18" → [{qt:16777251, mac:58}, ...]
function parseEncodedKeys(s) {
  if (!s) return null;
  return s.split("+").map((pair) => {
    const [qt, mac] = pair.split(":").map(Number);
    return { qt, mac, name: macKeycodeName(mac), qt_name: qtKeyName(qt) };
  });
}

// macOS virtual keycode → friendly name (kHIDUsage_Keyboard_*).
const MAC_KEYCODE = {
  0: "a", 1: "s", 2: "d", 3: "f", 4: "h", 5: "g", 6: "z", 7: "x", 8: "c", 9: "v",
  11: "b", 12: "q", 13: "w", 14: "e", 15: "r", 16: "y", 17: "t",
  18: "1", 19: "2", 20: "3", 21: "4", 22: "6", 23: "5",
  24: "=", 25: "9", 26: "7", 27: "-", 28: "8", 29: "0",
  30: "]", 31: "o", 32: "u", 33: "[", 34: "i", 35: "p",
  36: "Return", 37: "l", 38: "j", 39: "'", 40: "k", 41: ";",
  42: "\\", 43: ",", 44: "/", 45: "n", 46: "m", 47: ".",
  48: "Tab", 49: "Space", 50: "`", 51: "Delete",
  53: "Escape", 55: "Cmd", 56: "Shift", 58: "Option", 59: "Ctrl", 60: "RightShift",
  61: "RightOption", 62: "RightCtrl", 63: "Function", 64: "F17", 65: "KP_Decimal",
  67: "KP_Multiply", 69: "KP_Plus", 71: "KP_Clear", 75: "KP_Divide",
  76: "KP_Enter", 78: "KP_Minus", 79: "F18", 80: "F19", 81: "KP_Equals",
  82: "KP_0", 83: "KP_1", 84: "KP_2", 85: "KP_3", 86: "KP_4", 87: "KP_5", 88: "KP_6",
  89: "KP_7", 91: "KP_8", 92: "KP_9", 96: "F5", 97: "F6", 98: "F7",
  99: "F3", 100: "F8", 101: "F9", 103: "F11", 105: "F13", 107: "F14",
  109: "F10", 111: "F12", 113: "F15", 114: "Help", 115: "Home",
  116: "PageUp", 117: "ForwardDelete", 118: "F4", 119: "End", 120: "F2",
  121: "PageDown", 122: "F1",
  123: "LeftArrow", 124: "RightArrow", 125: "DownArrow", 126: "UpArrow",
};
function macKeycodeName(code) {
  return MAC_KEYCODE[code] ?? `unknown(${code})`;
}

// Qt::Key_* constants for modifiers and a few special keys we see in XP-Pen output.
const QT_KEY = {
  16777216: "Escape",
  16777217: "Tab",
  16777248: "Shift",
  16777249: "Control", // on macOS this is the Mac Control key (the actual ctrl)
  16777250: "Meta",    // on macOS this is the Cmd key
  16777251: "Alt",     // on macOS this is the Option key
  63289: "Apple_Dictation_Fn", // observed for K10 dictation
};
function qtKeyName(qt) {
  if (QT_KEY[qt]) return QT_KEY[qt];
  if (qt >= 32 && qt <= 126) return String.fromCharCode(qt); // ASCII printable
  return `unknown(${qt})`;
}

// Parse each layer.
const layers = {};
for (const { tag, layer } of LAYER_TAGS) {
  const re = new RegExp(`<${tag} id="(\\d+)">([\\s\\S]*?)</${tag}>`);
  const m = commonApp.match(re);
  if (!m) continue;
  const [, layerId, layerBody] = m;
  const enabled = layerId === "1";
  const keys = {};
  // Each line in layerBody is a K# entry.
  for (const line of layerBody.split("\n").map((l) => l.trim())) {
    if (!line.startsWith("<K")) continue;
    const parsed = parseKEntry(line);
    if (parsed) keys[`K${parsed.k_index}`] = parsed;
  }
  layers[layer] = { enabled, layer_id: Number(layerId), keys };
}

// Parse the Ring (wheel) section.
const ringSections = {};
for (const tag of ["R", "R_1", "R_2", "R_3"]) {
  const re = new RegExp(`<${tag} id="(\\d+)">([\\s\\S]*?)</${tag}>`);
  const m = commonApp.match(re);
  if (!m) continue;
  const [, ringId, ringBody] = m;
  const wheels = {};
  for (const line of ringBody.split("\n").map((l) => l.trim())) {
    const m2 = line.match(/<W(\d+) id="(\d+)"\s*\/?>(?:([^<]*)<\/W\d+>)?/);
    if (m2) wheels[`W${m2[1]}`] = { id: Number(m2[2]), payload: m2[3] ?? null };
  }
  ringSections[tag] = { ring_id: Number(ringId), wheels };
}

const out = {
  source: "~/.xppen/config.xml — <ACK05> (XP-Pen Shortcut Remote)",
  extracted_at: new Date().toISOString(),
  device: { internal_name: "ACK05", display_name: "Shortcut Remote", keys_per_layer: 11, ring_count: 1 },
  layers,
  ring_sections: ringSections,
  legend: {
    motid: "Physical position number XP-Pen assigns each key (stable across layers and devices in the family)",
    actid: "XP-Pen action ID — index into a built-in action table; the table is NOT in this config file",
    customized: "true = user-set keystroke (payload present); false = uses XP-Pen default for that Actid",
    encoded_keys: "Sequence of <Qt::Key>:<macOS_VK> pairs joined with '+' (modifiers first, terminal key last)",
  },
};

writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`wrote ${OUT_PATH}`);
console.log(`layers: ${Object.keys(layers).join(", ")}`);
for (const [layer, { enabled, keys }] of Object.entries(layers)) {
  const customized = Object.values(keys).filter((k) => k.customized).length;
  const total = Object.keys(keys).length;
  console.log(`  Layer ${layer}: enabled=${enabled}, ${customized}/${total} keys customized`);
}
