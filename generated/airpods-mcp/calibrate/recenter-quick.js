#!/usr/bin/env node
// Silent fast recenter. Captures ~0.8s of pose and writes the offsets file.
// Plays a confirmation chime ONLY on a verified successful write; a distinct
// error tone otherwise. No prompts, no countdown. Bound to a hardware button,
// so it must never hang (zombie node per press) or lie about success.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Honor the same overrides the adapter/sidecar use, so relocating the motion
// source or the calibration/offsets files doesn't silently break recenter.
const HOST = process.env.AIRPODS_SOURCE_HOST || '127.0.0.1';
const PORT = Number(process.env.AIRPODS_SOURCE_PORT) || 47833;
const CAL_PATH = process.env.AIRPODS_CALIBRATION_PATH || process.env.AIRPODS_CAL_PATH
  || path.resolve(__dirname, '..', 'calibration.json');
const OFFSETS_PATH = process.env.AIRPODS_OFFSETS_PATH || '/tmp/airpods-offsets.json';
const SAMPLES = 20;
const CAPTURE_TIMEOUT_MS = 3000;
const OK_CHIME = '/System/Library/Sounds/Tink.aiff';
const ERR_CHIME = '/System/Library/Sounds/Basso.aiff';

function tone(file) { spawn('afplay', [file], { stdio: 'ignore', detached: true }).unref(); }
function fail(msg) { process.stderr.write(`recenter-quick: ${msg}\n`); tone(ERR_CHIME); process.exit(1); }

let cal;
try {
  cal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
} catch {
  fail(`cannot read calibration at ${CAL_PATH} — run calibrate/calibrate.js`);
}
const refPoint = cal.points && cal.points.find(p => p.id === 'main_center');
if (!refPoint || !refPoint.summary) fail("calibration has no 'main_center' anchor — re-run calibrate.js");
const ref = refPoint.summary;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[Math.floor(s.length / 2)] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

(async () => {
  const sock = net.connect(PORT, HOST);
  let done = false;
  const finish = (fn) => { if (!done) { done = true; sock.destroy(); fn(); } };
  sock.on('error', e => finish(() => fail(`tcp: ${e.message}`)));
  sock.on('close', () => finish(() => fail('motion source closed before capture completed')));

  let buf = '';
  const samples = [];
  sock.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.type === 'pose' && Number.isFinite(m.yaw) && Number.isFinite(m.pitch) && samples.length < SAMPLES) {
          samples.push(m);
        }
      } catch {}
    }
  });

  const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
  while (samples.length < SAMPLES && !done) {
    if (Date.now() > deadline) finish(() => fail(`timed out waiting for pose (${samples.length}/${SAMPLES}) — is the motion source running?`));
    await sleep(40);
  }
  if (done) return;
  done = true;
  sock.destroy();

  const yaw = median(samples.map(s => s.yaw));
  const pitch = median(samples.map(s => s.pitch));
  const offsetYaw = ref.yaw.median - yaw;
  const offsetPitch = ref.pitch.median - pitch;

  try {
    fs.writeFileSync(OFFSETS_PATH, JSON.stringify({
      offsetYaw, offsetPitch,
      capturedAt: new Date().toISOString(),
      capturedPose: { yaw, pitch },
      referencePose: { yaw: ref.yaw.median, pitch: ref.pitch.median },
    }, null, 2));
  } catch (e) {
    fail(`cannot write ${OFFSETS_PATH}: ${e.message}`);
  }

  // Only now — write confirmed — signal success.
  tone(OK_CHIME);
  process.stdout.write(`recenter: yaw_offset=${offsetYaw.toFixed(3)} pitch_offset=${offsetPitch.toFixed(3)}\n`);
  process.exit(0);
})();
