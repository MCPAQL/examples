// SPDX-License-Identifier: AGPL-3.0-only
// Private metadata on internally cached Responses. Upstream HTTP headers cannot
// forge this timestamp or make cached data appear newly downloaded.
const timing = new WeakMap();
export function markSourceTime(response, retrievedAt) { timing.set(response, retrievedAt); return response; }
export function sourceTime(response) { return timing.get(response); }
