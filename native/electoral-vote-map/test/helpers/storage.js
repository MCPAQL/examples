// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';

// Deterministic unit harness. The separate workerd tests exercise actual storage.
export function memoryStorage() {
  let values = new Map(), queue = Promise.resolve();
  const api = {
    async get(key) {
      return Array.isArray(key) ? new Map(key.filter(k => values.has(k)).map(k => [k, structuredClone(values.get(k))])) : structuredClone(values.get(key));
    },
    async put(key, value) {
      const entries = typeof key === 'string' ? [[key, value]] : Object.entries(key);
      assert.ok(entries.length <= 128);
      for (const [name, data] of entries) {
        assert.ok(Buffer.byteLength(JSON.stringify(data)) <= 128 * 1024, 'storage value exceeds the real KV bound');
        values.set(name, structuredClone(data));
      }
    },
    async delete(key) { for (const name of Array.isArray(key) ? key : [key]) values.delete(name); },
    transaction(fn) {
      const result = queue.then(async () => {
        const before = structuredClone(values);
        try { return await fn(api); } catch (error) { values = before; throw error; }
      });
      queue = result.catch(() => {});
      return result;
    },
  };
  return api;
}
