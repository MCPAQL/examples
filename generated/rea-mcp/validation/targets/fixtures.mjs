// Hand-built fixtures for the REA parity suite: small files in the formats REA's file
// inspectors read. Nothing here comes from a real device, app or capture. The capture-style
// fixtures (HAR, pcap, sigrok recording, core file) are recorded-fixture stand-ins, so their
// parity results are labeled fake-device. Run by build.sh; writes into the output directory.
// Usage: node fixtures.mjs <output directory>

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync, gzipSync } from "node:zlib";

const out = process.argv[2];
if (!out) throw new Error("usage: node fixtures.mjs <output directory>");
mkdirSync(out, { recursive: true });
const write = (name, data) => writeFileSync(join(out, name), data);

// HAR 1.2 with one request to a reserved .invalid host.
write("parity.har", JSON.stringify({
  log: {
    version: "1.2",
    creator: { name: "parity-fixture", version: "1" },
    entries: [{
      startedDateTime: "2026-01-01T00:00:00.000Z",
      time: 1,
      request: { method: "GET", url: "https://parity.invalid/api/status", httpVersion: "HTTP/1.1", headers: [{ name: "accept", value: "application/json" }], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
      response: { status: 200, statusText: "OK", httpVersion: "HTTP/1.1", headers: [{ name: "content-type", value: "application/json" }], cookies: [], content: { size: 11, mimeType: "application/json", text: "{\"ok\":true}" }, redirectURL: "", headersSize: -1, bodySize: 11 },
      cache: {},
      timings: { send: 0, wait: 1, receive: 0 },
    }],
  },
}, null, 2));

// Classic little-endian pcap, Ethernet, two UDP frames between TEST-NET-1 addresses.
function ipv4Checksum(header) {
  let sum = 0;
  for (let i = 0; i < header.length; i += 2) sum += header.readUInt16BE(i);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}
function udpFrame(src, dst, sport, dport, payload) {
  const eth = Buffer.from([2, 0, 0, 0, 0, dst, 2, 0, 0, 0, 0, src, 0x08, 0x00]);
  const udp = Buffer.alloc(8);
  udp.writeUInt16BE(sport, 0); udp.writeUInt16BE(dport, 2); udp.writeUInt16BE(8 + payload.length, 4);
  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0); ip.writeUInt16BE(20 + 8 + payload.length, 2); ip.writeUInt16BE(0x1234, 4);
  ip.writeUInt8(64, 8); ip.writeUInt8(17, 9);
  Buffer.from([192, 0, 2, src]).copy(ip, 12); Buffer.from([192, 0, 2, dst]).copy(ip, 16);
  ip.writeUInt16BE(ipv4Checksum(ip), 10);
  return Buffer.concat([eth, ip, udp, payload]);
}
const pcapGlobal = Buffer.alloc(24);
pcapGlobal.writeUInt32LE(0xa1b2c3d4, 0); pcapGlobal.writeUInt16LE(2, 4); pcapGlobal.writeUInt16LE(4, 6);
pcapGlobal.writeUInt32LE(65535, 16); pcapGlobal.writeUInt32LE(1, 20);
const frames = [
  udpFrame(1, 2, 40000, 9999, Buffer.from("parity ping")),
  udpFrame(2, 1, 9999, 40000, Buffer.from("parity pong")),
];
write("parity.pcap", Buffer.concat([pcapGlobal, ...frames.flatMap((frame, i) => {
  const record = Buffer.alloc(16);
  record.writeUInt32LE(1767225600 + i, 0); record.writeUInt32LE(frame.length, 8); record.writeUInt32LE(frame.length, 12);
  return [record, frame];
})]));

// WebAssembly: imports env.log (i32) -> (), exports parity_answer () -> i32 returning 42.
const name = (s) => [s.length, ...Buffer.from(s)];
const section = (id, bytes) => [id, bytes.length, ...bytes];
write("parity.wasm", Buffer.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, [2, 0x60, 1, 0x7f, 0, 0x60, 0, 1, 0x7f]),
  ...section(2, [1, ...name("env"), ...name("log"), 0x00, 0]),
  ...section(3, [1, 1]),
  ...section(7, [1, ...name("parity_answer"), 0x00, 1]),
  ...section(10, [1, 4, 0, 0x41, 42, 0x0b]),
]));

// EVM runtime bytecode, hex: dispatches selector 0x2e64cec1 (retrieve()) and returns 42.
write("parity-evm.hex", "60003560e01c80632e64cec114601457600080fd5b602a60005260206000f3\n");

// ELF64 AArch64 core: one NT_PRSTATUS and one NT_SIGINFO note (SIGSEGV), one small PT_LOAD.
function note(type, desc) {
  const header = Buffer.alloc(12);
  header.writeUInt32LE(5, 0); header.writeUInt32LE(desc.length, 4); header.writeUInt32LE(type, 8);
  const pad = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  return Buffer.concat([header, pad(Buffer.from("CORE\0")), pad(desc)]);
}
const prstatus = Buffer.alloc(392);
prstatus.writeInt32LE(11, 0); prstatus.writeInt16LE(11, 12);
prstatus.writeInt32LE(4242, 32); prstatus.writeInt32LE(1, 36); prstatus.writeInt32LE(4242, 40); prstatus.writeInt32LE(4242, 44);
prstatus.writeBigUInt64LE(0x7ff0000n, 112 + 31 * 8); prstatus.writeBigUInt64LE(0x400010n, 112 + 32 * 8);
const siginfo = Buffer.alloc(128);
siginfo.writeInt32LE(11, 0); siginfo.writeInt32LE(1, 8); siginfo.writeBigUInt64LE(0xdead0000n, 16);
const notes = Buffer.concat([note(1, prstatus), note(0x53494749, siginfo)]);
const elf = Buffer.alloc(64);
Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(elf, 0);
elf.writeUInt16LE(4, 16); elf.writeUInt16LE(183, 18); elf.writeUInt32LE(1, 20);
elf.writeBigUInt64LE(64n, 32); elf.writeUInt16LE(64, 52); elf.writeUInt16LE(56, 54); elf.writeUInt16LE(2, 56); elf.writeUInt16LE(64, 58);
const loadOffset = 0x1000, loadBytes = Buffer.alloc(64, 0xaa);
const phdr = (type, flags, offset, vaddr, size, align) => {
  const p = Buffer.alloc(56);
  p.writeUInt32LE(type, 0); p.writeUInt32LE(flags, 4); p.writeBigUInt64LE(BigInt(offset), 8);
  p.writeBigUInt64LE(BigInt(vaddr), 16); p.writeBigUInt64LE(BigInt(vaddr), 24);
  p.writeBigUInt64LE(BigInt(size), 32); p.writeBigUInt64LE(BigInt(size), 40); p.writeBigUInt64LE(BigInt(align), 48);
  return p;
};
const headers = Buffer.concat([elf, phdr(4, 4, 176, 0, notes.length, 4), phdr(1, 6, loadOffset, 0x400000, loadBytes.length, 0x1000)]);
const core = Buffer.alloc(loadOffset + loadBytes.length);
Buffer.concat([headers, notes]).copy(core, 0); loadBytes.copy(core, loadOffset);
write("parity-core", core);

// Firmware-style image: a header, padding and a gzip stream at 0x400.
const firmware = Buffer.alloc(8192);
Buffer.from("PARITYFW\x01\x00\x00\x00").copy(firmware, 0);
gzipSync(Buffer.from("parity firmware payload\n".repeat(8))).copy(firmware, 0x400);
write("parity-firmware.bin", firmware);

// sigrok session parts (build.sh zips them into parity.sr): one logic channel, RX, carrying
// "OK" as 8N1 UART at one sample per bit.
const sr = join(out, "parity-sr");
mkdirSync(sr, { recursive: true });
const bits = [1, 1, 1, 1];
for (const byte of Buffer.from("OK")) bits.push(0, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (byte >> i) & 1), 1, 1);
writeFileSync(join(sr, "version"), "2");
writeFileSync(join(sr, "metadata"), "[global]\nsigrok version=0.5.2\n\n[device 1]\ncapturefile=logic-1\ntotal probes=1\nsamplerate=9600 Hz\ntotal analog=0\nprobe1=RX\nunitsize=1\n");
writeFileSync(join(sr, "logic-1-1"), Buffer.from(bits));

// A small JavaScript application directory, and a second version of it with one more export,
// for the operations that compare two applications.
function javascriptApplication(dir, version) {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "parity-js", version, main: "src/index.js", type: "module" }, null, 2));
  const extra = version === "1.0.0" ? "" : "\nexport function parityAudit(input) {\n  return { input, audited: true };\n}\n";
  writeFileSync(join(dir, "src", "feature.js"), `export function parityFeature(input) {\n  return \`parity feature: \${input}\`;\n}\n${extra}`);
  writeFileSync(join(dir, "src", "index.js"), "import { parityFeature } from \"./feature.js\";\n\nexport const PARITY_FLAG = \"authorization failed\";\n\nexport function main(argv) {\n  return parityFeature(argv[0] ?? PARITY_FLAG);\n}\n");
}
javascriptApplication(join(out, "parity-js"), "1.0.0");
javascriptApplication(join(out, "parity-js-v2"), "1.1.0");

// An .app bundle skeleton (build.sh adds the executable and converts the archives to binary
// plists). Keyed archives are written as XML with CF$UID references, which plutil turns into UIDs.
const uid = (n) => ({ "CF$UID": n });
function plistXml(value) {
  const encode = (v, indent) => {
    const pad = "  ".repeat(indent);
    if (typeof v === "string") return `${pad}<string>${v}</string>`;
    if (typeof v === "number") return `${pad}<integer>${v}</integer>`;
    if (typeof v === "boolean") return `${pad}<${v}/>`;
    if (Array.isArray(v)) return `${pad}<array>\n${v.map((item) => encode(item, indent + 1)).join("\n")}\n${pad}</array>`;
    const entries = Object.entries(v).map(([key, item]) => `${pad}  <key>${key}</key>\n${encode(item, indent + 1)}`);
    return `${pad}<dict>\n${entries.join("\n")}\n${pad}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${encode(value, 0)}\n</plist>\n`;
}
const keyedArchive = (top, objects) => ({ $archiver: "NSKeyedArchiver", $version: 100000, $top: top, $objects: ["$null", ...objects] });
const app = join(out, "parity.app", "Contents");
mkdirSync(join(app, "MacOS"), { recursive: true });
mkdirSync(join(app, "Resources", "Base.lproj"), { recursive: true });
writeFileSync(join(app, "Info.plist"), plistXml({
  CFBundleExecutable: "parity-native",
  CFBundleIdentifier: "org.mcpaql.parity-app",
  CFBundleName: "Parity",
  CFBundlePackageType: "APPL",
  CFBundleShortVersionString: "1.0",
  CFBundleVersion: "1",
  NSMainNibFile: "Main",
}));
// An archived NSDictionary: { mode: "parity", retries: 3 }.
writeFileSync(join(app, "Resources", "parity.archive.xml"), plistXml(keyedArchive({ root: uid(1) }, [
  { "NS.keys": [uid(2), uid(3)], "NS.objects": [uid(4), uid(5)], $class: uid(6) },
  "mode", "retries", "parity", 3,
  { $classname: "NSDictionary", $classes: ["NSDictionary", "NSObject"] },
])));
// A minimal nib-shaped archive: an IB object-data root holding one custom object.
writeFileSync(join(app, "Resources", "Base.lproj", "Main.nib.xml"), plistXml(keyedArchive({ "IB.objectdata": uid(1) }, [
  { NSRoot: uid(2), NSConnections: uid(4), $class: uid(6) },
  { NSClassName: uid(3), $class: uid(5) },
  "NSApplication",
  { "NS.objects": [], $class: uid(7) },
  { $classname: "NSCustomObject", $classes: ["NSCustomObject", "NSObject"] },
  { $classname: "NSIBObjectData", $classes: ["NSIBObjectData", "NSObject"] },
  { $classname: "NSMutableArray", $classes: ["NSMutableArray", "NSArray", "NSObject"] },
])));

// cargo-auditable style dependency list for parity-audit.c: zlib-compressed JSON as a C array.
const audit = deflateSync(Buffer.from(JSON.stringify({
  packages: [
    { name: "parity", version: "0.1.0", source: "local", root: true, dependencies: [1] },
    { name: "parity-dep", version: "1.2.3", source: "crates.io" },
  ],
})));
write("parity-audit-data.h", `static const unsigned char parity_dep_v0[] __attribute__((used, section("__DATA,.dep-v0"))) = {\n  ${[...audit].join(", ")}\n};\n`);

console.log(`wrote fixtures to ${out}`);
