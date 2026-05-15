#!/usr/bin/env node
// AirPods head-tracking → window focus sidecar.
// - Subscribes to airpods-mcp adapter HUD WebSocket (default ws://127.0.0.1:47834/events)
// - Classifies live pose into a monitor (MAIN / LEFT / off-screen) with seam hysteresis
// - On dwell-stable (pid, wnum) change, fires AX-raise via the window-at-point daemon

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const HUD_URL = process.env.AIRPODS_HUD_URL || 'ws://127.0.0.1:47834/events';
const DWELL_MS = parseInt(process.env.DWELL_MS || '500', 10);
const MARGIN_RAD = parseFloat(process.env.MARGIN_RAD || '0.05'); // ~2.9°
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '750', 10);
const CAL_PATH = process.env.AIRPODS_CAL_PATH || path.resolve(__dirname, '..', 'calibration.json');
const SPEAK_BIN = path.resolve(__dirname, 'speak-pan');
const CURSOR_BIN = path.resolve(__dirname, 'move-cursor');
const WAP_BIN = path.resolve(__dirname, 'window-at-point');
const BLOB_BIN = path.resolve(__dirname, 'dwell-blob');
const BLOB_FOLLOW = process.env.BLOB_FOLLOW === '1';
const BLOB_HZ = parseInt(process.env.BLOB_HZ || '15', 10);
const MOUSE_FOLLOW = process.env.MOUSE_FOLLOW === '1';
const CURSOR_HZ = parseInt(process.env.CURSOR_HZ || '15', 10);
const SMOOTH_ALPHA = parseFloat(process.env.SMOOTH_ALPHA || '0.25');
const APP_QUERY_HZ = parseInt(process.env.APP_QUERY_HZ || '8', 10);

const OFFSETS_PATH = process.env.AIRPODS_OFFSETS_PATH || '/tmp/airpods-offsets.json';
let offsetYaw = 0, offsetPitch = 0;
function loadOffsets() {
  try {
    const o = JSON.parse(fs.readFileSync(OFFSETS_PATH, 'utf8'));
    offsetYaw = Number(o.offsetYaw) || 0;
    offsetPitch = Number(o.offsetPitch) || 0;
    // Reset the smoothed pose: alpha is gated by motionFactor and approaches 0
    // when the head is still, so without this an external recenter only takes
    // effect after the user moves enough to "pump" the filter.
    smoothedYaw = null;
    smoothedPitch = null;
    console.log(`offsets loaded: yaw=${offsetYaw.toFixed(3)} pitch=${offsetPitch.toFixed(3)}`);
  } catch {
    offsetYaw = 0; offsetPitch = 0;
  }
}

let cal;
try {
  cal = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
} catch (e) {
  console.error(`ERROR: cannot read calibration at ${CAL_PATH}`);
  console.error('Run: node calibrate/calibrate.js  (from the airpods-mcp/ directory)');
  console.error(`(set AIRPODS_CAL_PATH to override the default location)`);
  process.exit(1);
}
const byId = Object.fromEntries(cal.points.map(p => [p.id, p.summary]));

function bbox(prefix) {
  const corners = [
    byId[`${prefix}_top_left`], byId[`${prefix}_top_right`],
    byId[`${prefix}_bot_left`], byId[`${prefix}_bot_right`],
  ];
  const yaws = corners.map(c => c.yaw.median);
  const pitches = corners.map(c => c.pitch.median);
  return {
    yawMin:   Math.min(...yaws)    - MARGIN_RAD,
    yawMax:   Math.max(...yaws)    + MARGIN_RAD,
    pitchMin: Math.min(...pitches) - MARGIN_RAD,
    pitchMax: Math.max(...pitches) + MARGIN_RAD,
  };
}

const regions = { main: bbox('main'), left: bbox('left') };

// Per-monitor corner anchors for u,v interpolation
function corners(prefix) {
  return {
    tl: byId[`${prefix}_top_left`],
    tr: byId[`${prefix}_top_right`],
    bl: byId[`${prefix}_bot_left`],
    br: byId[`${prefix}_bot_right`],
  };
}
const monitorCorners = { main: corners('main'), left: corners('left') };

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

function poseToUV(monitor, yaw, pitch) {
  const c = monitorCorners[monitor];
  const center = byId[`${monitor}_center`];
  const left_yaw  = (c.tl.yaw.median  + c.bl.yaw.median)  / 2;
  const right_yaw = (c.tr.yaw.median  + c.br.yaw.median)  / 2;
  const top_pitch = (c.tl.pitch.median + c.tr.pitch.median) / 2;
  const bot_pitch = (c.bl.pitch.median + c.br.pitch.median) / 2;
  const center_yaw = center.yaw.median;
  const center_pitch = center.pitch.median;

  // 3-anchor piecewise linear (left → center → right), positive yaw = head LEFT
  let u;
  if (yaw >= center_yaw) {
    const d = left_yaw - center_yaw;
    u = d !== 0 ? clamp01(0.5 * (left_yaw - yaw) / d) : 0.5;
  } else {
    const d = center_yaw - right_yaw;
    u = d !== 0 ? clamp01(0.5 + 0.5 * (center_yaw - yaw) / d) : 0.5;
  }
  // 3-anchor piecewise linear (top → center → bottom), positive pitch = head UP
  let v;
  if (pitch >= center_pitch) {
    const d = top_pitch - center_pitch;
    v = d !== 0 ? clamp01(0.5 * (top_pitch - pitch) / d) : 0.5;
  } else {
    const d = center_pitch - bot_pitch;
    v = d !== 0 ? clamp01(0.5 + 0.5 * (center_pitch - pitch) / d) : 0.5;
  }
  return { u, v };
}

let cursorProc = null;
let smoothedYaw = null, smoothedPitch = null;
let lastCursorWriteAt = 0;
const CURSOR_INTERVAL_MS = Math.round(1000 / CURSOR_HZ);

// Now that smoothedYaw/Pitch are declared, perform the initial offset load
// and start watching the offsets file for external updates (e.g., recenter).
loadOffsets();
fs.watchFile(OFFSETS_PATH, { interval: 1000 }, () => loadOffsets());

function startCursorDaemon() {
  if (!MOUSE_FOLLOW) return;
  cursorProc = spawn(CURSOR_BIN, [], { stdio: ['pipe', 'ignore', 'inherit'] });
  cursorProc.on('exit', () => { cursorProc = null; });
  console.log(`mouse-follow ON (${CURSOR_HZ} Hz, smooth α=${SMOOTH_ALPHA})`);
}
startCursorDaemon();

function maybeMoveCursor(monitor, yaw, pitch) {
  if (!MOUSE_FOLLOW || !cursorProc || cursorProc.killed) return;
  const now = Date.now();
  if (now - lastCursorWriteAt < CURSOR_INTERVAL_MS) return;
  lastCursorWriteAt = now;
  const { u, v } = poseToUV(monitor, yaw, pitch);
  cursorProc.stdin.write(`${monitor} ${u.toFixed(4)} ${v.toFixed(4)}\n`);
}

let blobProc = null;
let lastBlobWriteAt = 0;
const BLOB_INTERVAL_MS = Math.round(1000 / BLOB_HZ);
const BLOB_FADE_AFTER_MS = parseInt(process.env.BLOB_FADE_AFTER_MS || '6000', 10);
const BLOB_STILL_THRESHOLD = parseFloat(process.env.BLOB_STILL_THRESHOLD || '0.05');     // rad/s — below = "still"
const BLOB_REAPPEAR_THRESHOLD = parseFloat(process.env.BLOB_REAPPEAR_THRESHOLD || '0.40'); // rad/s — above = "real motion"
const BLOB_FADE_DURATION_S = parseFloat(process.env.BLOB_FADE_DURATION_S || '0.5');
let blobLastMovedAt = Date.now();
let blobFaded = false;
function setBlobAlpha(a) {
  if (!blobProc || blobProc.killed || !blobProc.stdin.writable) return;
  blobProc.stdin.write(`alpha ${a}\n`);
}
function setBlobFade(target, durSec) {
  if (!blobProc || blobProc.killed || !blobProc.stdin.writable) return;
  blobProc.stdin.write(`fade ${target} ${durSec}\n`);
}
function startBlobDaemon() {
  if (!BLOB_FOLLOW) return;
  blobProc = spawn(BLOB_BIN, [], { stdio: ['pipe', 'ignore', 'inherit'] });
  blobProc.on('exit', () => { blobProc = null; });
  console.log(`blob-follow ON (${BLOB_HZ} Hz)`);
}
startBlobDaemon();

function maybeMoveBlob(monitor, yaw, pitch, rotMag) {
  if (!BLOB_FOLLOW || !blobProc || blobProc.killed) return;
  const now = Date.now();
  // Three zones:
  //   rotMag > REAPPEAR → significant motion: un-fade if faded, reset timer
  //   STILL < rotMag ≤ REAPPEAR → small motion: reset fade timer, don't un-fade
  //   rotMag ≤ STILL → fully still: if visible, fade out after FADE_AFTER_MS
  if (rotMag > BLOB_REAPPEAR_THRESHOLD) {
    blobLastMovedAt = now;
    if (blobFaded) { setBlobFade(1.0, BLOB_FADE_DURATION_S); blobFaded = false; }
  } else if (rotMag > BLOB_STILL_THRESHOLD) {
    blobLastMovedAt = now;
  } else {
    if (!blobFaded && (now - blobLastMovedAt) > BLOB_FADE_AFTER_MS) {
      setBlobFade(0.0, BLOB_FADE_DURATION_S); blobFaded = true;
    }
  }
  if (blobFaded) return;
  if (now - lastBlobWriteAt < BLOB_INTERVAL_MS) return;
  lastBlobWriteAt = now;
  const { u, v } = poseToUV(monitor, yaw, pitch);
  blobProc.stdin.write(`${monitor} ${u.toFixed(4)} ${v.toFixed(4)}\n`);
}

console.log('Loaded calibration regions:');
for (const [k, b] of Object.entries(regions)) {
  console.log(`  ${k}: yaw [${b.yawMin.toFixed(3)}..${b.yawMax.toFixed(3)}]  pitch [${b.pitchMin.toFixed(3)}..${b.pitchMax.toFixed(3)}]`);
}
console.log(`Dwell: ${DWELL_MS}ms  margin: ${MARGIN_RAD} rad  cooldown: ${COOLDOWN_MS}ms`);
console.log(`Connecting to ${HUD_URL}…`);

// Seam-based classifier with explicit hysteresis dead band.
// Computed from calibration: midpoint between MAIN's left edge yaw and LEFT's right edge yaw.
const _mainLeftYaw  = (byId.main_top_left.yaw.median  + byId.main_bot_left.yaw.median)  / 2;
const _leftRightYaw = (byId.left_top_right.yaw.median + byId.left_bot_right.yaw.median) / 2;
const SEAM_YAW = (_mainLeftYaw + _leftRightYaw) / 2;
const SEAM_HYST = parseFloat(process.env.SEAM_HYST || '0.05'); // rad — ~2.9°
console.log(`Seam yaw=${SEAM_YAW.toFixed(3)} (main_left=${_mainLeftYaw.toFixed(3)}, left_right=${_leftRightYaw.toFixed(3)}), hysteresis=±${SEAM_HYST}`);

let lastClassification = null;

function inRegion(name, yaw, pitch) {
  const b = regions[name];
  return yaw >= b.yawMin && yaw <= b.yawMax && pitch >= b.pitchMin && pitch <= b.pitchMax;
}

function classify(yaw, pitch) {
  // CMHMM convention: positive yaw = head turned LEFT. So LEFT monitor = high yaw side.
  let target;
  if (lastClassification === 'main') {
    target = (yaw > SEAM_YAW + SEAM_HYST) ? 'left' : 'main';
  } else if (lastClassification === 'left') {
    target = (yaw < SEAM_YAW - SEAM_HYST) ? 'main' : 'left';
  } else {
    target = (yaw > SEAM_YAW) ? 'left' : 'main';
  }
  if (inRegion(target, yaw, pitch)) {
    lastClassification = target;
    return target;
  }
  // Pose outside chosen region's pitch bbox — try the other (rare; typically same-pitch issues)
  const other = (target === 'main') ? 'left' : 'main';
  if (inRegion(other, yaw, pitch)) {
    lastClassification = other;
    return other;
  }
  lastClassification = null;
  return null;
}

let candidate = null;          // current monitor candidate ('main' / 'left' / null)

// Window-level dwell tracking: track on (pid, wnum) so different windows of same app are transitions
let appCandidatePid = null;
let appCandidateName = null;
let appCandidateWnum = null;
let appCandidateMonitor = null;
let appCandidateSince = 0;
let lastFiredPid = null;
let lastFiredWnum = null;
let lastFiredAt = 0;
let lastSpokenPid = null;
let lastQueryAt = 0;

// Spawn window-at-point daemon
const wapProc = spawn(WAP_BIN, [], { stdio: ['pipe', 'pipe', 'inherit'] });
let wapBuf = '';
wapProc.stdout.on('data', chunk => {
  wapBuf += chunk.toString('utf8');
  let nl;
  while ((nl = wapBuf.indexOf('\n')) >= 0) {
    const line = wapBuf.slice(0, nl);
    wapBuf = wapBuf.slice(nl + 1);
    onAppLookup(line.trim());
  }
});
wapProc.on('exit', code => console.log(`window-at-point exited code=${code}`));

function onAppLookup(line) {
  const now = Date.now();
  let pid = null, name = null, wnum = null;
  if (line && line !== 'none' && !line.startsWith('focused ') && !line.startsWith('err')) {
    const parts = line.split('|');
    if (parts.length >= 2) {
      pid = parseInt(parts[0], 10);
      name = parts[1];
      if (parts.length >= 3) wnum = parseInt(parts[2], 10);
    }
  }
  if (wnum !== appCandidateWnum) {
    appCandidatePid = pid;
    appCandidateName = name;
    appCandidateWnum = wnum;
    appCandidateMonitor = candidate;
    appCandidateSince = now;
    return;
  }
  if (!appCandidatePid) return;
  if ((now - appCandidateSince) < DWELL_MS) return;
  if ((now - lastFiredAt) < COOLDOWN_MS) return;
  const wasNewApp = (appCandidatePid !== lastFiredPid);
  const wasNewWindow = (appCandidateWnum !== lastFiredWnum);
  // Only fire on a real transition. Without this, a window held under gaze
  // re-fires AX-raise + a log line every COOLDOWN_MS. The off-screen reset
  // clears lastFiredPid/Wnum too, so a look-away-and-return to the SAME
  // window still counts as a transition and re-fires correctly.
  if (!wasNewApp && !wasNewWindow) return;
  lastFiredAt = now;
  lastFiredPid = appCandidatePid;
  lastFiredWnum = appCandidateWnum;
  // Send focus command via daemon (uses AX-raise to target the specific window)
  const { u, v } = poseToUV(appCandidateMonitor, smoothedYaw, smoothedPitch);
  if (wapProc && !wapProc.killed && wapProc.stdin.writable) {
    wapProc.stdin.write(`focus ${appCandidateMonitor} ${u.toFixed(4)} ${v.toFixed(4)}\n`);
  }
  process.stdout.write(`[${new Date().toISOString().split('T')[1].replace('Z','')}] focus → ${appCandidateName} (pid=${appCandidatePid} w=${appCandidateWnum}) on=${appCandidateMonitor}\n`);
  // Force blob to fade in when focusing a different app (regardless of motion)
  if (wasNewApp && blobFaded) {
    setBlobFade(1.0, BLOB_FADE_DURATION_S);
    blobFaded = false;
    blobLastMovedAt = Date.now();
  }
}

const STILL_REF_RAD_S = parseFloat(process.env.STILL_REF_RAD_S || '0.05'); // below this → fully still
const MOVE_REF_RAD_S  = parseFloat(process.env.MOVE_REF_RAD_S  || '0.40'); // above this → fully responsive
const DRIFT_ABSORB_GAIN = parseFloat(process.env.DRIFT_ABSORB_GAIN || '0.3'); // fraction of per-sample drift to absorb when fully still
const MAX_ABSORB_PER_SAMPLE = parseFloat(process.env.MAX_ABSORB_PER_SAMPLE || '0.00005'); // rad/sample cap; ~3x real drift, blocks micro-motion re-baseline
const DRIFT_WARN_RAD = parseFloat(process.env.DRIFT_WARN_RAD || '0.20'); // warn when offset magnitude exceeds ~11°
const POSE_TIMEOUT_MS = parseInt(process.env.POSE_TIMEOUT_MS || '4000', 10);
let prevRawYawIn = null, prevRawPitchIn = null;
let lastPoseAt = Date.now();
let lastDriftWarnAt = 0;
let poseStreamHealthy = true;

// Calibration mode (SIGUSR1 triggered)
const CAL_TOTAL_MS = 3500;
const CAL_CAPTURE_START_MS = 2500;
const CAL_CAPTURE_END_MS = 3500;
let calibrating = false;
let calibrationStartedAt = 0;
let calibrationSamples = [];

function startCalibration() {
  if (calibrating) return;
  calibrating = true;
  calibrationStartedAt = Date.now();
  calibrationSamples = [];
  console.log(`[${new Date().toISOString()}] SIGUSR1 → calibration started`);
  spawn(SPEAK_BIN, ['C', 'Look at the dot.'], { stdio: 'ignore', detached: true }).unref();
  setTimeout(() => spawn('afplay', ['/System/Library/Sounds/Tink.aiff'], { stdio: 'ignore', detached: true }).unref(), 1000);
  setTimeout(() => spawn('afplay', ['/System/Library/Sounds/Tink.aiff'], { stdio: 'ignore', detached: true }).unref(), 2000);
  setTimeout(finishCalibration, CAL_TOTAL_MS);
}

function finishCalibration() {
  calibrating = false;
  if (calibrationSamples.length === 0) {
    spawn(SPEAK_BIN, ['C', 'No samples. Try again.'], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  const median = arr => { const s = [...arr].sort((a,b)=>a-b); return s.length%2 ? s[Math.floor(s.length/2)] : (s[s.length/2-1]+s[s.length/2])/2; };
  const yawMed = median(calibrationSamples.map(s => s.yaw));
  const pitchMed = median(calibrationSamples.map(s => s.pitch));
  const ref = byId['main_center'];
  offsetYaw = ref.yaw.median - yawMed;
  offsetPitch = ref.pitch.median - pitchMed;
  smoothedYaw = null;
  smoothedPitch = null;
  fs.writeFileSync(OFFSETS_PATH, JSON.stringify({
    offsetYaw, offsetPitch,
    capturedAt: new Date().toISOString(),
    capturedPose: { yaw: yawMed, pitch: pitchMed },
    referencePose: { yaw: ref.yaw.median, pitch: ref.pitch.median },
    samples: calibrationSamples.length,
  }, null, 2));
  console.log(`[${new Date().toISOString()}] calibration done: yaw=${offsetYaw.toFixed(3)} pitch=${offsetPitch.toFixed(3)} (n=${calibrationSamples.length})`);
  spawn('afplay', ['/System/Library/Sounds/Glass.aiff'], { stdio: 'ignore', detached: true }).unref();
  spawn(SPEAK_BIN, ['C', 'Centered.'], { stdio: 'ignore', detached: true }).unref();
}

process.on('SIGUSR1', () => startCalibration());

function speakAlert(text) {
  spawn('say', ['-r', '210', text], { stdio: 'ignore', detached: true }).unref();
}

setInterval(() => {
  const now = Date.now();
  if (now - lastPoseAt > POSE_TIMEOUT_MS && poseStreamHealthy) {
    poseStreamHealthy = false;
    console.log(`[${new Date().toISOString()}] WARN: pose stream stalled (>${POSE_TIMEOUT_MS}ms since last sample)`);
    speakAlert('AirPods motion stream stopped. Check audio session.');
  } else if (now - lastPoseAt < 1000 && !poseStreamHealthy) {
    poseStreamHealthy = true;
    console.log(`[${new Date().toISOString()}] pose stream resumed`);
    speakAlert('Motion stream resumed.');
  }
  // Drift warning: log only, no audio (per user request — visible drift is self-evident)
  const totalDrift = Math.hypot(offsetYaw, offsetPitch);
  if (totalDrift > DRIFT_WARN_RAD && now - lastDriftWarnAt > 30000) {
    lastDriftWarnAt = now;
    console.log(`[${new Date().toISOString()}] log-only: offset yaw=${offsetYaw.toFixed(3)} pitch=${offsetPitch.toFixed(3)}`);
  }
}, 1000);

function onPose(rawYawIn, rawPitchIn, rotRate) {
  lastPoseAt = Date.now();
  // Calibration mode: lock blob to MAIN center, capture pose in capture window, skip everything else
  if (calibrating) {
    const elapsed = Date.now() - calibrationStartedAt;
    if (elapsed >= CAL_CAPTURE_START_MS && elapsed < CAL_CAPTURE_END_MS) {
      calibrationSamples.push({ yaw: rawYawIn, pitch: rawPitchIn });
    }
    if (BLOB_FOLLOW && blobProc && !blobProc.killed && blobProc.stdin.writable) {
      blobProc.stdin.write(`main 0.5 0.5\n`);
    }
    return;
  }
  const rotMag = rotRate ? Math.hypot(rotRate[0] || 0, rotRate[1] || 0, rotRate[2] || 0) : 0;
  // motionFactor: 0 = fully still, 1 = fully moving — smooth ramp between refs
  const motionFactor = Math.max(0, Math.min(1,
    (rotMag - STILL_REF_RAD_S) / (MOVE_REF_RAD_S - STILL_REF_RAD_S)));

  // I-term: leaky integrator on offset, absorbs apparent pose change as drift when still
  // Capped per-sample to prevent over-absorption of breathing/micro-motion as drift
  if (prevRawYawIn !== null && motionFactor < 0.5) {
    const driftYaw   = rawYawIn   - prevRawYawIn;
    const driftPitch = rawPitchIn - prevRawPitchIn;
    const absorbFrac = (1 - motionFactor) * DRIFT_ABSORB_GAIN;
    const cap = MAX_ABSORB_PER_SAMPLE;
    const yawAbs   = Math.max(-cap, Math.min(cap, driftYaw   * absorbFrac));
    const pitchAbs = Math.max(-cap, Math.min(cap, driftPitch * absorbFrac));
    offsetYaw   -= yawAbs;
    offsetPitch -= pitchAbs;
  }
  prevRawYawIn = rawYawIn;
  prevRawPitchIn = rawPitchIn;

  const rawYaw   = rawYawIn   + offsetYaw;
  const rawPitch = rawPitchIn + offsetPitch;

  // P-term: motion-proportional smoothing (1-Euro flavor — lo-pass when still, hi-pass when moving)
  const alpha = motionFactor * SMOOTH_ALPHA;
  if (smoothedYaw === null) {
    smoothedYaw = rawYaw; smoothedPitch = rawPitch;
  } else {
    smoothedYaw   = alpha * rawYaw   + (1 - alpha) * smoothedYaw;
    smoothedPitch = alpha * rawPitch + (1 - alpha) * smoothedPitch;
  }
  const yaw = smoothedYaw, pitch = smoothedPitch;
  const target = classify(yaw, pitch);
  if (target) { maybeMoveCursor(target, yaw, pitch); maybeMoveBlob(target, yaw, pitch, rotMag); }
  const now = Date.now();
  candidate = target;

  // Throttle window-at-point queries; only when gaze is in a calibrated region
  if (!target) {
    // Gaze off-screen: clear the FULL candidate. Clearing only the pid leaves
    // appCandidateWnum stale, so onAppLookup's `wnum !== appCandidateWnum`
    // guard skips re-init when the user looks back at the same window before
    // dwell completed — focus could then never fire on that window again.
    appCandidatePid = null;
    appCandidateName = null;
    appCandidateWnum = null;
    appCandidateMonitor = null;
    appCandidateSince = 0;
    // Also clear the last-fired pair so a return glance to the SAME window
    // counts as a transition (wasNewApp/wasNewWindow true) and re-fires focus.
    lastFiredPid = null;
    lastFiredWnum = null;
    return;
  }
  const queryIntervalMs = Math.round(1000 / APP_QUERY_HZ);
  if (now - lastQueryAt < queryIntervalMs) return;
  lastQueryAt = now;
  const { u, v } = poseToUV(target, yaw, pitch);
  if (wapProc && !wapProc.killed && wapProc.stdin.writable) {
    wapProc.stdin.write(`${target} ${u.toFixed(4)} ${v.toFixed(4)}\n`);
  }
}

// Connect to the adapter's HUD WebSocket. Reconnects on close.
let ws = null;
function connectHud() {
  ws = new WebSocket(HUD_URL);
  ws.on('open',    () => console.log(`connected to adapter HUD ${HUD_URL}`));
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    if (msg.type === 'pose') onPose(msg.yaw, msg.pitch, msg.rotRate);
  });
  ws.on('error', (e) => console.error('hud ws error:', e.message));
  ws.on('close', () => {
    console.log('hud ws closed; reconnecting in 1s');
    setTimeout(connectHud, 1000);
  });
}
connectHud();

const goodbye = () => {
  console.log('\nbye');
  try { ws?.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT',  goodbye);
process.on('SIGTERM', goodbye);
