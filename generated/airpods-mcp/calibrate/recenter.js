#!/usr/bin/env node
// Recenter tool: captures current pose while user looks at MAIN center,
// computes offset against calibration.json, writes /tmp/airpods-offsets.json.
// Sidecar watches that file and adopts the offsets live.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 47833;
const CAL_PATH = path.resolve(__dirname, '..', 'calibration.json');
const OFFSETS_PATH = '/tmp/airpods-offsets.json';
const SAMPLES = 25;

const cal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
const calMainCenter = cal.points.find(p => p.id === 'main_center').summary;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const speak = text => new Promise(resolve => {
  const p = spawn('say', ['-r', '210', text], { stdio: 'ignore' });
  p.on('exit', () => resolve());
  p.on('error', () => resolve());
});
const play = file => spawn('afplay', [file], { stdio: 'ignore', detached: true }).unref();
const TICK = '/System/Library/Sounds/Tink.aiff';
const CHIME = '/System/Library/Sounds/Glass.aiff';

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[Math.floor(s.length/2)] : (s[s.length/2 - 1] + s[s.length/2]) / 2;
}

(async () => {
  console.log('Recenter against MAIN center');
  await speak('Look at the center of main monitor.');
  for (let s = 3; s >= 1; s--) {
    process.stdout.write(`Capturing in ${s}…\r`);
    play(TICK);
    await sleep(1000);
  }
  play(CHIME);
  process.stdout.write('Capturing now — hold still…       \n');

  const sock = net.connect(PORT, HOST);
  sock.on('error', e => { console.error('TCP error:', e.message); process.exit(1); });

  let buf = '';
  const samples = [];
  sock.on('data', chunk => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.type === 'pose' && samples.length < SAMPLES) samples.push(m);
      } catch {}
    }
  });

  while (samples.length < SAMPLES) await sleep(50);
  sock.end();

  const curYaw   = median(samples.map(s => s.yaw));
  const curPitch = median(samples.map(s => s.pitch));
  const offsetYaw   = calMainCenter.yaw.median   - curYaw;
  const offsetPitch = calMainCenter.pitch.median - curPitch;

  console.log(`captured live   : yaw=${curYaw.toFixed(3)}  pitch=${curPitch.toFixed(3)}`);
  console.log(`calibration mid : yaw=${calMainCenter.yaw.median.toFixed(3)}  pitch=${calMainCenter.pitch.median.toFixed(3)}`);
  console.log(`offset to apply : yaw=${offsetYaw.toFixed(3)}  pitch=${offsetPitch.toFixed(3)}`);

  fs.writeFileSync(OFFSETS_PATH, JSON.stringify({
    offsetYaw, offsetPitch,
    capturedAt: new Date().toISOString(),
    capturedPose: { yaw: curYaw, pitch: curPitch },
    referencePose: { yaw: calMainCenter.yaw.median, pitch: calMainCenter.pitch.median },
  }, null, 2));

  await speak('Recenter complete.');
  console.log(`✓ Wrote ${OFFSETS_PATH}. Sidecar will adopt within 1 second.`);
  process.exit(0);
})();
