// SPDX-License-Identifier: AGPL-3.0-only
// Validate every introspection variant against the real spec, not a hand-written mirror.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createAdapter, OPERATIONS, TYPES } from '../src/adapter.js';
const schemaRoot = process.argv[2];
if (!schemaRoot) throw new Error('Usage: node scripts/check-schemas.js /path/to/MCPAQL/spec/schemas');
const ajv = new Ajv({ allErrors: true, strict: false }); addFormats(ajv);
const validators = await Promise.all(['operation-input', 'operation-result', 'introspection-response'].map(async name => ajv.compile(JSON.parse(await readFile(resolve(schemaRoot, `${name}.schema.json`), 'utf8')))));
const dispatch = createAdapter({ loadSite: () => { throw new Error('Discovery must be available offline'); } });
let checked = 0;
for (const params of [{ query: 'operations' }, { query: 'types' }, ...OPERATIONS.map(op => ({ query: 'operations', name: op.name })), ...TYPES.map(type => ({ query: 'types', name: type.name }))]) {
  const request = { operation: 'introspect', params }, result = await dispatch('mcp_aql_read', request);
  assert.equal(result.success, true, JSON.stringify(result));
  for (const [validator, value] of [[validators[0], request], [validators[1], result], [validators[2], result]]) assert.equal(validator(value), true, ajv.errorsText(validator.errors));
  checked++;
}
console.log(JSON.stringify({ passed: true, introspection_variants_checked: checked, schema_root: resolve(schemaRoot) }, null, 2));
