# XP-Pen Shortcut Remote — Decode Reference

Durable, version-controlled record of every fact derived during JIT discovery and config parsing. This file is the source of truth; the parser code (`tools/parse-xppen-config.js`) and decoded JSON (`adapter/src/xppen-mappings.json`) are mechanical derivations of what's documented here.

If you only have this file, you can rebuild the rest.

---

## 1. Device identification

| Field | Value |
|---|---|
| USB Vendor ID | `0x28bd` (10429 decimal) |
| USB Product ID | `0x0202` (514 decimal) |
| USB Vendor Name | Hanvon Ugee |
| USB Product Name | Shortcut Remote |
| XP-Pen retail name | XP-Pen Shortcut Remote |
| XP-Pen internal model code | `ACK05` |

The XP-Pen retail brand is owned by Hanvon Ugee (parent company); USB descriptors carry the manufacturer name "Hanvon Ugee" while user-facing software displays "XP-Pen". Both refer to the same device.

---

## 2. USB / HID interface layout

The device exposes three HID interfaces over USB. Enumerated via `node-hid` `HID.devices()` they appear as:

| Interface | usagePage | usage | Purpose | Should our adapter open? |
|---|---|---|---|---|
| 0 | `0x01` (Generic Desktop) | `0x02` (Mouse) | Mouse-class events | NO — owned by macOS |
| 1 | `0x0D` (Digitizer) | `0x02` (Pen) | Digitizer events | NO — owned by macOS |
| 2 | `0xFF0A` (Vendor-defined) | `0x01` | Custom button + wheel reports | YES — vendor page, no OS handler |

**Why we only open interface 2.** `node-hid` on macOS opens devices with `kIOHIDOptionsTypeSeizeDevice` (exclusive seize). If our adapter opens interface 0 or 1, macOS-level handling of the mouse / digitizer functionality is suppressed — and so is XP-Pen's keystroke synthesis (because XP-Pen's daemon also reads the vendor page). Restricting opens to `usagePage >= 0xFF00` cleanly isolates "our protocol" from "the OS's protocol."

---

## 3. Vendor-page HID report layout (interface 2, usagePage `0xFF0A`)

Every input report on the vendor page is **12 bytes**. Two report families share the layout, distinguished by byte 1.

### 3.1 Report header (bytes 0–1)

| Byte | Field | Notes |
|---|---|---|
| 0 | Report ID | Always `0x02` for this device. Distinct from the HID-spec 1-byte report ID prefix; here it is part of the 12-byte payload. |
| 1 | Report type | `0xf0` = button + wheel state. `0xf2` = battery heartbeat. Other values not observed. |

### 3.2 Button + wheel reports (`byte_1 == 0xf0`)

| Byte | Field |
|---|---|
| 2 | Primary button bitmap (8 bits, one per button — bit 0 = K1, bit 7 = K8) |
| 3 | Secondary button bitmap (3 bits observed: bit 0 = K9, bit 1 = K10, bit 2 = K11) |
| 4–6 | Reserved / always zero |
| 7 | Wheel direction (`0x01` = clockwise tick, `0x02` = counter-clockwise tick, `0x00` = idle) |
| 8–11 | Reserved / always zero |

Multiple buttons can be held simultaneously — observed during capture (e.g. `02 f0 22 00 …` = primary bits 1 and 5 held together, hex `0x22` = `0x02 | 0x20`).

A wheel tick fires once per detent of physical rotation (~60–90 ms apart in a normal spin).

The "release" event is just byte 2 + byte 3 returning to `0x00` after a held bit dropped — i.e. the report is `02 f0 00 00 00 00 00 00 00 00 00 00`. The adapter synthesizes a `button_release` event with the bits that just transitioned from held to not-held.

### 3.3 Battery heartbeat reports (`byte_1 == 0xf2`)

| Byte | Field |
|---|---|
| 2 | `0x01` — fixed marker |
| 3 | Battery percentage (`0x64` = 100, `0x32` = 50, etc.) |
| 4 | Charging flag (`0x01` = charging via USB cable, `0x00` = on battery) |
| 5–11 | Reserved / always zero |

Heartbeats arrive roughly every 5 seconds while the device is connected, regardless of activity.

---

## 4. K# to HID bit mapping (verified live)

XP-Pen's UI labels the 11 inputs K1 through K11. K11 is the button at the center of the wheel ring (the wheel itself does not press down — only the inner circle does).

| XP-Pen label | HID bit | Hex mask in vendor report |
|---|---|---|
| K1 | primary bit 0 | `0x01` in byte 2 |
| K2 | primary bit 1 | `0x02` in byte 2 |
| K3 | primary bit 2 | `0x04` in byte 2 |
| K4 | primary bit 3 | `0x08` in byte 2 |
| K5 | primary bit 4 | `0x10` in byte 2 |
| K6 | primary bit 5 | `0x20` in byte 2 |
| K7 | primary bit 6 | `0x40` in byte 2 |
| K8 | primary bit 7 | `0x80` in byte 2 |
| K9 | secondary bit 0 | `0x01` in byte 3 |
| K10 | secondary bit 1 | `0x02` in byte 3 |
| K11 | secondary bit 2 | `0x04` in byte 3 |

Verified by Mick on 2026-04-28 by pressing each labeled physical button and confirming which bit transitioned.

---

## 5. Physical layout of the keypad

Per XP-Pen's app graphic (with rotation set to 90°, which is Mick's configured orientation). The wheel is at the top; the K-grid below it.

```
                ┌─────────────────┐
                │      WHEEL      │
                │   (with K11     │
                │   button in     │
                │   the center)   │
                └─────────────────┘

         ┌─────┐  ┌─────┐  ┌─────┐
         │ K8  │  │ K4  │  │ K1  │
         └─────┘  └─────┘  └─────┘
         ┌─────┐  ┌─────┐  ┌─────┐
         │     │  │ K5  │  │ K2  │
         │ K9  │  └─────┘  └─────┘
         │(tall│  ┌─────┐  ┌─────┐
         │ on  │  │ K6  │  │ K3  │
         │ left│  └─────┘  └─────┘
         └─────┘
         ┌─────┐  ┌─────────────┐
         │ K10 │  │     K7      │
         └─────┘  └─────────────┘
```

K9 is a single tall button on the left. K7 is a single wide button at the bottom-right. The other 8 keys are unit-sized.

---

## 6. XP-Pen config storage on macOS

User-customized button mappings are written to the file:

```
~/.xppen/config.xml
```

Format: UTF-8 XML. Single root element `<PenTableLists version="4.0.0">`. Inside the root, one child element per device model XP-Pen supports — about 60 device sections in total. Most are templates that exist whether or not the user owns that device.

**Active device sections use internal model codes**, not retail names. The Shortcut Remote's section is `<ACK05>`. There is also a `<ShortcutRemote>` element in the same file — that one is a **stale legacy template** and does NOT carry user customizations. Verify by checking which one has `id="1"` on its K entries.

The pen tablet model `<LDN1302F-A>` and similar entries are likewise either templates or correspond to other XP-Pen products.

---

## 7. Layer encoding inside `<ACK05>`

The Shortcut Remote supports four "profiles" or "layers" in XP-Pen's UI (labeled I, II, III, IV). They are stored under sequentially-suffixed XML element names, all inside `<ACK05><CommonAPP>`:

| UI label | XML element | XML attribute conventions |
|---|---|---|
| Layer I | `<K id="…">…</K>` | `id="1"` if user has any custom entry in this layer |
| Layer II | `<K_1 id="…">…</K_1>` | same |
| Layer III | `<K_2 id="…">…</K_2>` | same |
| Layer IV | `<K_3 id="…">…</K_3>` | same |

Each K-block contains 11 child elements `<K1>`–`<K11>` in sequence.

There are equivalent ring sections for the wheel: `<R>`, `<R_1>`, `<R_2>`, `<R_3>`. Each contains four `<W1>` through `<W4>` elements representing wheel-rotation actions in different ring modes.

---

## 8. Per-key entry XML format

Inside any layer's K-block, each key element looks like one of these two shapes.

### 8.1 Default (no user override)

```xml
<K1 id="0" Show="1" Actid="110" Motid="1"/>
```

| Attribute | Meaning |
|---|---|
| `id="0"` | No user override; key uses XP-Pen's built-in default action for this `Actid`. |
| `Show="1"` | Visible in the XP-Pen UI (always 1 for this device). |
| `Actid="110"` | XP-Pen's internal action ID — index into a built-in action table that lives in the XP-Pen app binary, NOT in this XML. |
| `Motid="1"` | Physical position number XP-Pen assigns to the key. Stable across layers and across devices in the same family. |

Self-closing tag, no inner text. The actual keystroke that fires when pressed is determined by `Actid` against XP-Pen's binary table — **not extractable from the config file alone**.

### 8.2 Customized (user has set a value)

```xml
<K6 id="1" Show="1" Actid="3" Motid="6">1|ChatGPT|Option+Command+1|16777251:58+16777250:55+49:18</K6>
```

Inner text follows a pipe-separated format with up to four fields:

```
<action_type>|<label>|<human_shortcut>|<encoded_keys>
```

| Field | Meaning |
|---|---|
| `action_type` | `1` = keystroke combo (chord). `2` = modifier hold (sticky). Other values not observed. |
| `label` | User-given description shown in XP-Pen UI ("ChatGPT", "Claude Desktop", etc.). May be empty. |
| `human_shortcut` | Human-readable shortcut form ("Option+Command+1"). May be empty for some action types. |
| `encoded_keys` | The actual machine-readable keystroke encoding. See section 9. |

For modifier-hold actions (`action_type == 2`) only the first three pipe-fields are used and `encoded_keys` is omitted entirely (e.g. `2|Option|2`).

---

## 9. Encoded keystroke format

The fourth pipe-field is a `+`-separated list of `<Qt key code>:<macOS virtual keycode>` pairs. Modifiers are listed first, terminal keys last.

Example: `16777251:58+16777250:55+49:18`

Decoded:

| Pair | Qt Key | macOS keycode | Resolves to |
|---|---|---|---|
| `16777251:58` | `Qt::Key_Alt` | 58 | macOS Option key |
| `16777250:55` | `Qt::Key_Meta` | 55 | macOS Command key |
| `49:18` | Qt ASCII `1` | 18 | macOS keycode for the "1" digit |

Combined: **Option + Command + 1**.

### 9.1 Qt key constants observed in this device's config

| Qt code | Name | macOS key |
|---|---|---|
| 16777216 | `Qt::Key_Escape` | Escape |
| 16777217 | `Qt::Key_Tab` | Tab |
| 16777248 | `Qt::Key_Shift` | Shift |
| 16777249 | `Qt::Key_Control` | Control (the actual macOS Control key, not Cmd) |
| 16777250 | `Qt::Key_Meta` | Command (Cmd) on macOS |
| 16777251 | `Qt::Key_Alt` | Option (Alt) |
| 63289 | (Apple Dictation modifier, fn key) | fn |
| 32–126 | ASCII printable | as-is |

### 9.2 macOS virtual keycode reference (subset relevant to this device)

These are the values that may appear after the `:` in encoded_keys pairs. Source: HIToolbox.framework's `Events.h`.

| Code | Key | Code | Key |
|---|---|---|---|
| 0 | a | 36 | Return |
| 1 | s | 48 | Tab |
| 2 | d | 49 | Space |
| 6 | z | 51 | Delete |
| 7 | x | 53 | Escape |
| 8 | c | 55 | Cmd |
| 9 | v | 56 | Shift |
| 11 | b | 58 | Option |
| 12 | q | 59 | Ctrl |
| 13 | w | 60 | Right Shift |
| 14 | e | 61 | Right Option |
| 15 | r | 63 | Function |
| 16 | y | 71 | Keypad Clear |
| 17 | t | 76 | Keypad Enter |
| 18 | 1 | 96 | F5 |
| 19 | 2 | 97 | F6 |
| 20 | 3 | 99 | F3 |
| 21 | 4 | 122 | F1 |
| 22 | 6 | 120 | F2 |
| 23 | 5 | 118 | F4 |
| 24 | = | 98 | F7 |
| 25 | 9 | 100 | F8 |
| 26 | 7 | 101 | F9 |
| 27 | - | 109 | F10 |
| 28 | 8 | 103 | F11 |
| 29 | 0 | 111 | F12 |
| 30 | ] | 105 | F13 |
| 31 | o | 107 | F14 |
| 32 | u | 113 | F15 |
| 33 | [ | 79 | F18 |
| 34 | i | 80 | F19 |
| 35 | p | 64 | F17 |
| 37 | l | 116 | PageUp |
| 38 | j | 121 | PageDown |
| 39 | ' | 115 | Home |
| 40 | k | 119 | End |
| 41 | ; | 117 | ForwardDelete |
| 42 | \\ | 123 | LeftArrow |
| 43 | , | 124 | RightArrow |
| 44 | / | 125 | DownArrow |
| 45 | n | 126 | UpArrow |
| 46 | m |  |  |
| 47 | . |  |  |
| 50 | ` |  |  |

For the full table see `Events.h` in HIToolbox or Apple's developer documentation. The parser in `tools/parse-xppen-config.js` carries the same table for symbolic name resolution.

---

## 10. Mick's Layer I config (snapshot 2026-04-28)

Extracted from `~/.xppen/config.xml` `<ACK05><CommonAPP><K id="1">`. This is a point-in-time snapshot — re-derive by re-running the parser if the user has edited their XP-Pen config since.

| K | id | Actid | Label | Human shortcut | Encoded keys |
|---|---|---|---|---|---|
| K1 | 0 | 110 | (default — keystroke unknown without binary inspection) | — | — |
| K2 | 0 | 111 | (default — keystroke unknown without binary inspection) | — | — |
| K3 | 1 | 24 | Claude Desktop | Control+Option+Command+2 | `16777249:59+16777251:58+16777250:55+50:19` |
| K4 | 1 | 201 | Option (modifier hold) | — | `2|Option|2` |
| K5 | 1 | 204 | Command (modifier hold) | — | `2|Command|3` |
| K6 | 1 | 3 | ChatGPT | Option+Command+1 | `16777251:58+16777250:55+49:18` |
| K7 | 1 | 5 | SuperWhisper | Option+Command+3 | `16777251:58+16777250:55+51:20` |
| K8 | 1 | 6 | Escape | ⎋ | `16777216:53` |
| K9 | 1 | 4 | Tab | ⇥ | `16777217:48` |
| K10 | 1 | 8 | Apple Dictation | (no human shortcut) | `63289:71` |
| K11 | 0 | 105 | (default — keystroke unknown without binary inspection) | — | — |

Layer II (`<K_1>`) had K3 = `Command+Shift+R`, K4 = `Command+W`, others at default. Layer III (`<K_2>`) had K3 = `Command+Shift+R`, K7 = `Handy / Option+Command+4`, K8 = `Escape`, others at default. Layer IV (`<K_3>`) had no customizations.

---

## 11. The Actid limitation and recovery paths

When a key entry has `id="0"`, only `Actid` and `Motid` are stored in the config. **The actual keystroke that XP-Pen synthesizes for that Actid lives in the XP-Pen app binary's static action table, not in this XML.** The parser and this reference can show "Actid 110" but cannot show "what Actid 110 means."

To populate those defaults, two paths:

1. **Force-customize.** Click "Save" on each default-setting button in XP-Pen's UI. This materializes the entry in the XML with the full payload and rolls forward through future re-reads automatically.
2. **Empirical capture.** Temporarily hold both interface 0 (keyboard) and interface 2 (vendor page) simultaneously. Press each default-mapped button once. The keyboard interface emits the synthesized keystroke; the vendor page emits the raw bit. Pair them by timestamp to recover the Actid → keystroke mapping. Once captured, the result can be saved as a "snapshot defaults" file in this directory.

Empirical capture is more thorough but requires temporarily disabling normal XP-Pen functionality (because seizing interface 0 also stops XP-Pen synthesizing to the OS during the capture window). Force-customize is non-disruptive but requires manual UI clicking for every default-mapped button.

---

## 12. Discovery method (how this reference was built)

1. **HID enumeration.** `node-hid HID.devices()` filtered to vendor `0x28bd` product `0x0202`, deduplicated by path, then filtered to `usagePage >= 0xFF00` for safe opens (see section 2).
2. **Observational capture.** Open the vendor-page interface, pipe input reports to a JSONL log, ask the user to press every button and rotate the wheel. ~235 reports captured across two sessions.
3. **Mechanical inference.** Count distinct payloads, look for monotonic single-bit changes per action, derive the report layout in section 3.
4. **K# correlation.** User presses each XP-Pen-labeled K-button in known order while the adapter is running; resulting bit transitions establish the mapping in section 4.
5. **Config decode.** Parser walks `~/.xppen/config.xml` ACK05 section and emits a clean JSON. Pipe-separated payload format reverse-engineered by inspecting customized vs. default entries.

No part of this required vendor SDK access, kernel extension authoring, or binary reverse-engineering. The XP-Pen app binary's action table (section 11) remains the only opaque part.
