import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDeepSeek } from './deepseek.mjs';
import { createDeepSeekSettings } from './deepseek-settings.mjs';

const key = 'test-only-placeholder-key';
const input = { text: '明天提交材料', receivedAt: '2026-10-18T10:00:00+08:00' };
const analysis = { summary: '提交材料', relevance: 'uncertain', actions: [{ title: '提交材料', owner: null, deadline: '2026-10-19', calendarStart: null, calendarEnd: null, location: null, evidence: '提交材料', needsConfirmation: false }], questions: [], notes: [] };
const response = (result = analysis, finish = 'stop') => Response.json({ model: 'deepseek-flash', choices: [{ finish_reason: finish, message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 20, completion_tokens: 30 } });

test('official endpoint, isolated input, economy settings, usage and relative-date guard', async () => {
  let telemetry, calls = 0;
  const provider = createDeepSeek({ apiKey: key, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body); assert.equal(body.reasoning_effort, 'none'); assert.equal(body.messages.length, 2); assert.equal(body.tools, undefined); assert.equal(body.max_tokens, 6144);
    return response();
  } });
  const result = await provider.analyzeMessage(input, { onUsage: value => { telemetry = value; } });
  assert.equal(calls, 1); assert.equal(result.actions[0].deadline, null); assert.equal(result.actions[0].needsConfirmation, true);
  assert.equal(telemetry.totalTokens, 130); assert.equal(telemetry.cachedInputTokens, 20); assert.equal(telemetry.status, 'completed');
});
test('invalid evidence is rejected while billed usage remains recorded', async () => {
  let usage;
  const bad = structuredClone(analysis); bad.actions[0].evidence = '虚构的原文';
  const provider = createDeepSeek({ apiKey: key, fetchImpl: async () => response(bad) });
  await assert.rejects(provider.analyzeMessage(input, { onUsage: x => { usage = x; } }), { code: 'ANALYSIS_INVALID' });
  assert.equal(usage.status, 'failed'); assert.equal(usage.totalTokens, 130);
});
test('HTTP failure is sanitized and never retried or misreported as zero tokens', async () => {
  let calls = 0, usage;
  const provider = createDeepSeek({ apiKey: key, fetchImpl: async () => { calls++; return new Response(key, { status: 402 }); } });
  await assert.rejects(provider.analyzeMessage(input, { onUsage: x => { usage = x; } }), e => e.code === 'ANALYSIS_API' && !e.message.includes(key));
  assert.equal(calls, 1); assert.equal(usage.totalTokens, null); assert.equal(usage.usageAvailable, false);
});
test('truncated completion is rejected and metering errors do not trigger retries', async () => {
  const provider = createDeepSeek({ apiKey: key, fetchImpl: async () => response(analysis, 'length') });
  await assert.rejects(provider.analyzeMessage(input, { onUsage: () => { throw new Error('meter'); } }), { code: 'ANALYSIS_INCOMPLETE' });
});
test('cancellation and timeout abort requests', async () => {
  const provider = createDeepSeek({ apiKey: key, fetchImpl: async (_, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }); if (signal.aborted) reject(new Error('abort')); }) });
  await assert.rejects(provider.analyzeMessage(input, { timeoutMs: 5 }), { code: 'ANALYSIS_TIMEOUT' });
  await assert.rejects(provider.analyzeMessage(input, { signal: AbortSignal.abort() }), { code: 'ANALYSIS_CANCELLED' });
});
test('image request uses validated local bytes and rejects text-only models', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-deepseek-test-'));
  try {
    const file = path.join(dir, 'sample.png'); await fs.writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC9sAAAAASUVORK5CYII=', 'base64'));
    const ocr = { images: [{ index: 1, text: '提交材料', legibility: 'clear', uncertainties: [] }] };
    let calls = 0;
    const provider = createDeepSeek({ apiKey: key, fetchImpl: async (_, options) => { calls++; const body = JSON.parse(options.body); assert.ok(body.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,')); return response(ocr); } });
    assert.deepEqual(await provider.recognizeImages([file]), ocr);
    await assert.rejects(provider.recognizeImages([file], { model: 'deepseek-v4-pro' }), { code: 'ANALYSIS_CONFIG' });
    assert.equal(calls, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('model settings persist; image model cannot be Pro; corrupt config fails closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-deepseek-settings-'));
  try {
    const settings = createDeepSeekSettings({ dataDir: dir }); await settings.initialize();
    assert.equal(settings.getSettings().reasoningEffort, 'none');
    const choice = { textModel: 'deepseek-v4-pro', imageModel: 'deepseek-flash', reasoningEffort: 'low' };
    await settings.save(choice);
    const restored = createDeepSeekSettings({ dataDir: dir }); await restored.initialize(); assert.deepEqual(restored.getSettings(), choice);
    await assert.rejects(settings.save({ ...choice, imageModel: 'deepseek-v4-pro' }));
    await fs.writeFile(path.join(dir, 'deepseek-model-settings.json'), 'broken');
    await assert.rejects(createDeepSeekSettings({ dataDir: dir }).initialize());
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
