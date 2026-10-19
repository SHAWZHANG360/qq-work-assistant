import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createUsageStore, formatUsage } from './usage-store.mjs';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-usage-test-'));
  t.after(() => { assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, now: () => new Date('2026-10-14T15:59:59Z') };
}
test('token totals exclude duplicate cached input and survive restart', t => {
  const options = fixture(t); const store = createUsageStore(options);
  const id = store.start({ kind: 'message', stage: 'analysis', jobId: 'a'.repeat(64) });
  store.record(id, { inputTokens: 100, cachedInputTokens: 70, outputTokens: 20, totalTokens: 999, model: 'gpt-fake', modelSource: 'requested' });
  store.finish(id, 'completed', 2300);
  const restored = createUsageStore(options);
  assert.deepEqual(restored.snapshot().today, { calls: 1, inputTokens: 100, cachedInputTokens: 70, outputTokens: 20, totalTokens: 120, unknownCalls: 0, unknownCacheCalls: 0 });
  assert.equal(restored.snapshot().recent[0].actualModel, null);
  assert.match(formatUsage(restored.forJob('a'.repeat(64))), /120 token/);
});
test('missing, interrupted and failed usage stays unknown, not zero', t => {
  const options = fixture(t); const store = createUsageStore(options);
  const failed = store.start({ kind: 'test', stage: 'analysis' });
  store.record(failed, { inputTokens: -1, outputTokens: Infinity, cachedInputTokens: 2 });
  store.finish(failed, 'failed', 300);
  store.start({ kind: 'message', stage: 'recognition' });
  const result = createUsageStore(options).snapshot();
  assert.equal(result.today.unknownCalls, 2);
  assert.equal(result.recent[0].status, 'interrupted');
  assert.equal(result.recent[0].totalTokens, null);
  assert.equal(result.recent[1].inputTokens, null);
});
test('today uses Taipei midnight and old entries remain available', t => {
  const options = fixture(t); const store = createUsageStore(options);
  store.start({ kind: 'test', stage: 'analysis' });
  const nextDay = createUsageStore({ ...options, now: () => new Date('2026-10-14T16:00:00Z') });
  assert.equal(nextDay.snapshot().today.calls, 0);
  assert.equal(nextDay.snapshot().recent.length, 1);
});
test('impossible cache counts and missing cache are not invented; actual model must be confirmed', t => {
  const store = createUsageStore(fixture(t));
  const id = store.start({ kind: 'test', stage: 'analysis', model: 'gpt-selected' });
  store.record(id, { inputTokens: 10, cachedInputTokens: 20, outputTokens: 1, model: 'gpt-real', modelSource: 'confirmed', privateData: 'secret' });
  store.finish(id, 'completed', 4);
  assert.equal(store.snapshot().recent[0].cachedInputTokens, null);
  assert.equal(store.snapshot().recent[0].actualModel, 'gpt-real');
  assert.equal(store.snapshot().today.unknownCacheCalls, 1);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /secret/);
});
