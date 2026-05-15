#!/usr/bin/env node
// Walks through 10 calibration points (5 per screen) by countdown.
// Connects to airpods-mcp server on TCP 47833, averages 25 samples per point,
// writes calibration.json with mean yaw/pitch/roll for each anchor.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TICK   = '/System/Library/Sounds/Tink.aiff';
const CHIME  = '/System/Library/Sounds/Glass.aiff';
const DONE   = '/System/Library/Sounds/Hero.aiff';

function play(file) {
  spawn('afplay', [file], { stdio: 'ignore', detached: true }).unref();
}

function speak(text) {
  return new Promise(resolve => {
    const p = spawn('say', ['-r', '210', text], { stdio: 'ignore' });
    p.on('exit', () => resolve());
    p.on('error', () => resolve());
  });
}

// Honor the same overrides the adapter/sidecar use, so a relocated motion
// source or calibration path doesn't silently capture against the wrong place.
const HOST = process.env.AIRPODS_SOURCE_HOST || '127.0.0.1';
const PORT = Number(process.env.AIRPODS_SOURCE_PORT) || 47833;
const SAMPLES_PER_POINT = 25;
const SETTLE_SECONDS = 4;
const CAPTURE_TIMEOUT_MS = 15000;
const OUT_PATH = process.env.AIRPODS_CALIBRATION_PATH || process.env.AIRPODS_CAL_PATH
  || path.resolve(__dirname, '..', 'calibration.json');

const POINTS = [
  // Screen layout per Mick: portrait (secondary) on LEFT, landscape 4K (main) on RIGHT.
  { id: 'main_center',      label: 'CENTER of MAIN (4K landscape) monitor' },
  { id: 'main_top_left',    label: 'TOP-LEFT corner of MAIN monitor' },
  { id: 'main_top_right',   label: 'TOP-RIGHT corner of MAIN monitor' },
  { id: 'main_bot_left',    label: 'BOTTOM-LEFT corner of MAIN monitor' },
  { id: 'main_bot_right',   label: 'BOTTOM-RIGHT corner of MAIN monitor' },
  { id: 'left_center',      label: 'CENTER of LEFT (portrait) monitor' },
  { id: 'left_top_left',    label: 'TOP-LEFT corner of LEFT monitor' },
  { id: 'left_top_right',   label: 'TOP-RIGHT corner of LEFT monitor' },
  { id: 'left_bot_left',    label: 'BOTTOM-LEFT corner of LEFT monitor' },
  { id: 'left_bot_right',   label: 'BOTTOM-RIGHT corner of LEFT monitor' },
];

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarize(samples) {
  const yaws = samples.map(s => s.yaw);
  const pitches = samples.map(s => s.pitch);
  const rolls = samples.map(s => s.roll);
  return {
    n: samples.length,
    yaw:   { median: median(yaws),   min: Math.min(...yaws),   max: Math.max(...yaws) },
    pitch: { median: median(pitches), min: Math.min(...pitches), max: Math.max(...pitches) },
    roll:  { median: median(rolls),  min: Math.min(...rolls),  max: Math.max(...rolls) },
  };
}

const sock = net.connect(PORT, HOST, () => process.stdout.write(`Connected to airpods-mcp ${HOST}:${PORT}\n`));
let aborted = false;
function abort(msg) {
  if (aborted) return;
  aborted = true;
  sock.destroy();
  console.error(msg);
  process.exit(1);
}
sock.on('error', e => abort(`Connection error: ${e.message}`));
sock.on('close', () => { if (!aborted) abort('motion source closed before calibration completed'); });

let buffer = '';
let collecting = false;
let captureBuf = [];
sock.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === 'pose' && collecting
        && Number.isFinite(msg.yaw) && Number.isFinite(msg.pitch) && Number.isFinite(msg.roll)) {
      captureBuf.push(msg);
    }
  }
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function capturePoint(p, index, total) {
  process.stdout.write(`\n[${index + 1}/${total}] → ${p.label}\n`);
  await speak(`Point ${index + 1} of ${total}. Look at ${p.label}.`);
  for (let s = SETTLE_SECONDS; s >= 1; s--) {
    process.stdout.write(`  Capturing in ${s}…\r`);
    play(TICK);
    await sleep(1000);
  }
  play(CHIME);
  process.stdout.write(`  Capturing now — hold still…              \n`);
  captureBuf = [];
  collecting = true;
  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  while (captureBuf.length < SAMPLES_PER_POINT && !aborted) {
    if (Date.now() > deadline) abort(`Timed out capturing '${p.id}' (${captureBuf.length}/${SAMPLES_PER_POINT} samples) — is the motion source streaming?`);
    await sleep(50);
  }
  collecting = false;
  const got = captureBuf.slice(0, SAMPLES_PER_POINT);
  const summary = summarize(got);
  process.stdout.write(`  ✓ captured ${got.length} samples — yaw_med=${summary.yaw.median.toFixed(3)} pitch_med=${summary.pitch.median.toFixed(3)} (rad)\n`);
  return { id: p.id, label: p.label, summary, raw: got.map(s => ({ t: s.t, yaw: s.yaw, pitch: s.pitch, roll: s.roll })) };
}

(async () => {
  process.stdout.write('\n=== AirPods Head-Tracking Calibration ===\n');
  process.stdout.write(`Will capture ${POINTS.length} points (${SETTLE_SECONDS}s settle + ~1s capture each).\n`);
  process.stdout.write('Sit in your normal working position. Wear AirPods. Look only with your head, not your eyes.\n');
  process.stdout.write('\n');
  process.stdout.write('NOTE: This script assumes a specific dual-monitor layout —\n');
  process.stdout.write('      portrait secondary on the LEFT, 4K landscape main on the RIGHT.\n');
  process.stdout.write('      Edit the POINTS array at the top of this file if your layout differs.\n');
  process.stdout.write('\n');
  await speak(`AirPods head tracking calibration. Ten points, five per screen. Beginning in three seconds.`);
  await sleep(1500);

  const results = [];
  for (let i = 0; i < POINTS.length; i++) results.push(await capturePoint(POINTS[i], i, POINTS.length));

  const out = {
    captured_at: new Date().toISOString(),
    units: 'radians',
    layout_note: 'portrait (secondary) on LEFT, landscape 4K (main) on RIGHT',
    points: results,
  };
  try {
    fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  } catch (e) {
    // All 10 points were captured — don't lose the work to a silent throw.
    console.error(`\nERROR: cannot write ${OUT_PATH}: ${e.message}`);
    console.error('Captured data (copy/save manually):');
    console.error(JSON.stringify(out));
    sock.destroy();
    process.exit(1);
  }
  play(DONE);
  await speak('Calibration complete.');
  process.stdout.write(`\n✓ Wrote ${OUT_PATH}\n`);
  sock.destroy();
  process.exit(0);
})();
