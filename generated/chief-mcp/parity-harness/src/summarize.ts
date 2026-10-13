// Reduce a raw parity report to a committable summary: per-op class and status only.
// Raw `detail` strings can quote payloads from the account under test, so they stay local.

import { readFile, writeFile } from "node:fs/promises";

interface RawOp { name: string; endpoint: string; category: string; cls: string; officialOk?: boolean; mcpaqlOk?: boolean; note?: string; ms: number }
interface RawReport { suite: string; startedAt: string; finishedAt: string; label?: string; upstreamUrl: string; totals: Record<string, number>; ops: RawOp[] }

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: node dist/summarize.js <parity-report.json> <summary.json>");
  process.exit(2);
}

const report = JSON.parse(await readFile(input, "utf8")) as RawReport;
const summary = {
  suite: report.suite,
  label: report.label,
  upstreamUrl: report.upstreamUrl,
  startedAt: report.startedAt,
  finishedAt: report.finishedAt,
  totals: report.totals,
  ops: report.ops.map(({ name, endpoint, category, cls, officialOk, mcpaqlOk, note }) => ({ name, endpoint, category, cls, officialOk, mcpaqlOk, note })),
};
await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary.totals));
