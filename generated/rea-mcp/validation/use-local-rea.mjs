// Points the adapter at a locally installed rea binary instead of `npx -y rea-agents@6.5.0`,
// so both parity arms run the same REA. For the VM checkout only: do not commit the result.
//
//   node validation/use-local-rea.mjs /path/to/node_modules/.bin/rea
//
// Rewrites target.stdio in adapter/src/schema.json and, if built, adapter/dist/schema.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const reaCommand = process.argv[2];
if (!reaCommand || !existsSync(reaCommand)) {
  console.error("Usage: node validation/use-local-rea.mjs /path/to/rea (the binary must exist)");
  process.exit(2);
}
const adapterDir = join(dirname(fileURLToPath(import.meta.url)), "..", "adapter");
for (const file of [join(adapterDir, "src", "schema.json"), join(adapterDir, "dist", "schema.json")]) {
  if (!existsSync(file)) continue;
  const schema = JSON.parse(readFileSync(file, "utf8"));
  schema.target.stdio = { ...schema.target.stdio, command: resolve(reaCommand), args: ["mcp"] };
  writeFileSync(file, JSON.stringify(schema, null, 2) + "\n");
  console.log(`${file}: target.stdio -> ${resolve(reaCommand)} mcp`);
}
