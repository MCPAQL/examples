#!/usr/bin/env node
// Silent fast recenter. Captures 0.8s of pose and writes /tmp/airpods-offsets.json.
// Plays a single confirmation chime at the end. No prompts, no countdown.
// Designed to be bound to a hardware button.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 47833;
const CAL_PATH = path.resolve(__dirname, '..', 'calibration.json');
const OFFSETS_PATH = '/tmp/airpods-offsets.json';
const SAMPLES = 20;
const CHIME = '/System/Library/Sounds/Tink.aiff';

const cal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
const ref = cal.points.find(p => p.id === 'main_center').summary;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = [...a].sort((x,y)=>x-y); return s.length%2 ? s[Math.floor(s.length/2)] : (s[s.length/2-1]+s[s.length/2])/2; };

(async () => {
  const sock = net.connect(PORT, HOST);
  sock.on('error', e => { process.stderr.write(`tcp: ${e.message}\n`); process.exit(1); });
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
        if (m.type === 'pose' && samples.length < SAMPLES) samples.push(m);
      } catch {}
    }
  });
  while (samples.length < SAMPLES) await sleep(40);
  sock.end();

  const yaw = median(samples.map(s => s.yaw));
  const pitch = median(samples.map(s => s.pitch));
  const offsetYaw = ref.yaw.median - yaw;
  const offsetPitch = ref.pitch.median - pitch;

  fs.writeFileSync(OFFSETS_PATH, JSON.stringify({
    offsetYaw, offsetPitch,
    capturedAt: new Date().toISOString(),
    capturedPose: { yaw, pitch },
    referencePose: { yaw: ref.yaw.median, pitch: ref.pitch.median },
  }, null, 2));

  spawn('afplay', [CHIME], { stdio: 'ignore', detached: true }).unref();
  process.stdout.write(`recenter: yaw_offset=${offsetYaw.toFixed(3)} pitch_offset=${offsetPitch.toFixed(3)}\n`);
  process.exit(0);
})();
