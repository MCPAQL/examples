// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

// Reuse the full live smoke assertions; keep cloud logs compact and attributable.
const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./polling-live-smoke.js', import.meta.url))], { timeout: 90_000, maxBuffer: 10 * 1024 * 1024 });
const report = JSON.parse(stdout);
const { stdout: revision } = await promisify(execFile)('git', ['rev-parse', 'HEAD']);
console.log(JSON.stringify({
  commit: revision.trim(), checked_at: report.checked_at,
  datasets: report.catalog.datasets.map(d => ({ id: d.id, status: d.status, mode: d.source.mode })),
  historical_pa_poll_count: report.historical_poll_summary.poll_count,
  map_url: report.scenario.map.map_url,
  electoral_votes: Object.values(report.scenario.map.totals).reduce((a, b) => a + b, 0),
  round_trip_verified: true,
}, null, 2));
