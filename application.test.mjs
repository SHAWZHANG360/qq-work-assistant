import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createApplication } from './application.mjs';
import { createStore } from './store.mjs';
import { createLocalServer } from './server.mjs';

const sampleResult = { summary: '提交课程大纲', relevance: 'direct', actions: [], questions: [], notes: [] };
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-assistant-integration-'));
  t.after(() => { const base = path.resolve(os.tmpdir()) + path.sep; assert.ok(path.resolve(dir).startsWith(base)); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
function make(t, overrides = {}) {
  const dataDir = overrides.dataDir ?? temp(t); const replies = []; const calls = [];
  let settings = { textModel: 'default', imageModel: 'default', reasoningEffort: 'low' };
  const modelSettings = { async initialize() {}, getSettings: () => ({ ...settings }),
    getSnapshot: () => ({ settings: { ...settings }, models: [], catalogSource: 'test', catalogWarning: '' }),
    async save(value) { settings = { ...value }; },
  };
  class Client {
    constructor(options) { this.options = options; }
    start() { this.options.onStatus({ state: 'connected', message: '已连接' }); }
    stop() {}
    async reply(value) { replies.push(value); }
  }
  const app = createApplication({ appId: '123456789', dataDir, preferences: {}, Client, modelSettings, analyze: async value => { calls.push(value); return structuredClone(sampleResult); }, formatAnalysis: value => value.summary, secrets: { load: async () => 'fake-secret-abcdefghijklmn', save: async () => {}, exists: () => false }, ...overrides });
  t.after(() => app.stop());
  const msg = (id, text, senderId = 'owner-openid', extras = {}) => ({ id, senderId, text, timestamp: new Date().toISOString(), ...extras });
  return { app, dataDir, replies, calls, msg };
}
async function settled(app) {
  for (let n = 0; n < 100; n++) { if (!app.state().analysisBusy && app.state().pending === 0) return; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('queue did not settle');
}

test('only the paired owner can store, analyze or receive replies; IDs deduplicate', async t => {
  const { app, dataDir, replies, calls, msg } = make(t);
  await app.restore();
  await app.receive(msg('unbound', '私人消息，不应保存'));
  assert.equal(calls.length, 0);
  const command = app.state().pairingCommand;
  await app.receive(msg('ROBOT1.0_pair+opaque/QQ=!', command));
  assert.equal(app.state().bound, true);
  await app.receive(msg('stranger', '测试用户 示例部门 不可读取', 'another-openid'));
  const messageId = `ROBOT1.0_${'opaque'.repeat(60)}+/=!`;
  await app.receive(msg(messageId, '请测试用户提交课程大纲'));
  await settled(app);
  await app.receive(msg(messageId, '重复消息'));
  assert.equal(calls.length, 1);
  assert.ok(replies.every(x => x.senderId === 'owner-openid'));
  assert.match(app.state().report, /提交课程大纲/);
  const raw = fs.readdirSync(path.join(dataDir, 'messages')).map(f => fs.readFileSync(path.join(dataDir, 'messages', f), 'utf8')).join('');
  assert.doesNotMatch(raw, /私人消息|不可读取|重复消息/);
  assert.ok(!JSON.stringify(app.state()).includes('fake-secret'));
  assert.ok(fs.readdirSync(path.join(dataDir, 'jobs')).every(file => /^[a-f0-9]{64}\.json$/.test(file)));
});

test('opaque forwarded cards are acknowledged without fabricated analysis', async t => {
  const { app, calls, replies, msg } = make(t); await app.restore();
  await app.receive(msg('pair', app.state().pairingCommand));
  await app.receive(msg('card', '', 'owner-openid', { messageType: 102, attachments: [] }));
  assert.equal(calls.length, 0);
  assert.match(replies.at(-1).content, /无法读取正文/);
});

const imageAttachment = { content_type: 'image/png', filename: 'notice.png', url: 'https://multimedia.nt.qq.com.cn/mock?temporary-signature=do-not-persist' };
const recognizedNotice = { images: [{ index: 1, text: '请测试用户于2026年10月18日15:30在305会议室参加课程研讨会。', legibility: 'clear', uncertainties: [] }] };
function fakeImages() {
  const downloads = [], recognitions = [];
  const attachmentStore = {
    async prepare(id, attachments) {
      downloads.push(attachments);
      return { images: [{ relativePath: `images/${createHash('sha256').update(id).digest('hex')}/1.png`, mimeType: 'image/png', size: 123 }], warnings: [], unreadAttachments: false };
    },
    async resolveImages(id, images) { return images.map(item => ({ ...item, path: path.join(os.tmpdir(), item.relativePath) })); },
  };
  const recognizeImages = async paths => { recognitions.push(paths); return structuredClone(recognizedNotice); };
  return { attachmentStore, recognizeImages, downloads, recognitions };
}

test('image-only owner messages are recognized and logged; unbound and foreign images never download', async t => {
  const images = fakeImages();
  const { app, dataDir, calls, replies, msg } = make(t, images); await app.restore();
  const picture = id => msg(id, '', 'owner-openid', { attachments: [imageAttachment] });
  await app.receive(picture('unbound-image'));
  await app.receive(msg('bind', app.state().pairingCommand));
  await app.receive(msg('foreign-image', '', 'another-openid', { attachments: [imageAttachment] }));
  await app.receive(msg('forwarded-preview', '', 'owner-openid', { messageType: 102, attachments: [imageAttachment] }));
  assert.equal(images.downloads.length, 0);
  await app.receive(picture('image-only')); await settled(app);
  await app.receive(picture('image-only')); await settled(app);
  assert.equal(images.downloads.length, 1); assert.equal(images.recognitions.length, 1);
  assert.equal(calls.length, 1); assert.match(calls[0].text, /测试用户.*2026年10月18日15:30/);
  assert.equal(calls[0].hasAttachments, false); assert.equal(calls[0].imageUncertain, false);
  assert.match(app.state().report, /图片识别文字/); assert.match(app.state().report, /305会议室/);
  assert.ok(replies.every(reply => reply.senderId === 'owner-openid'));
  const persisted = ['jobs', 'messages'].flatMap(dir => fs.readdirSync(path.join(dataDir, dir)).map(file => fs.readFileSync(path.join(dataDir, dir, file), 'utf8'))).join('');
  assert.doesNotMatch(persisted, /temporary-signature|multimedia\.nt|notice\.png/);
  assert.equal(app.state().recent[0].deliveredToQQ, true);
});

test('partly readable images force confirmation and preserve recognition doubts in the log', async t => {
  const images = fakeImages(); let analysisInput;
  const result = { ...structuredClone(sampleResult), actions: [{ title: '参加会议', owner: null, deadline: null, calendarStart: null, calendarEnd: null, location: null, evidence: '参加会议', needsConfirmation: false }] };
  const { app, dataDir, msg } = make(t, { ...images,
    recognizeImages: async () => ({ images: [{ index: 1, text: '参加会议，日期看不清。', legibility: 'partial', uncertainties: ['日期中的数字看不清。'] }] }),
    analyze: async value => { analysisInput = value; return result; },
  });
  await app.restore(); await app.receive(msg('bind', app.state().pairingCommand));
  await app.receive(msg('partial', '这是一张通知截图', 'owner-openid', { attachments: [imageAttachment] })); await settled(app);
  assert.equal(analysisInput.imageUncertain, true); assert.match(analysisInput.text, /这是一张通知截图/);
  const job = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs', fs.readdirSync(path.join(dataDir, 'jobs'))[0])));
  assert.equal(job.result.actions[0].needsConfirmation, true);
  assert.match(app.state().report, /日期中的数字看不清/);
});

test('unreadable images ask for a clearer copy without making up a task', async t => {
  const { app, calls, msg } = make(t, { ...fakeImages(), recognizeImages: async () => ({ images: [{ index: 1, text: '', legibility: 'unreadable', uncertainties: ['图片模糊，无法辨认。'] }] }) });
  await app.restore(); await app.receive(msg('bind', app.state().pairingCommand));
  await app.receive(msg('unreadable', '', 'owner-openid', { attachments: [imageAttachment] })); await settled(app);
  assert.equal(calls.length, 0); assert.equal(app.state().completed, 1);
  assert.match(app.state().report, /未能从图片中识别出可用文字/);
});

test('saved images survive an OCR failure and restart without downloading their signed links again', async t => {
  const images = fakeImages(); const dataDir = temp(t);
  const first = make(t, { ...images, dataDir, recognizeImages: async () => { throw new Error('private provider detail'); } });
  await first.app.restore(); await first.app.receive(first.msg('bind', first.app.state().pairingCommand));
  await first.app.receive(first.msg('retry-image', '', 'owner-openid', { attachments: [imageAttachment] })); await settled(first.app);
  assert.equal(first.app.state().failed, 1); assert.doesNotMatch(JSON.stringify(first.app.state()), /private provider/);
  first.app.stop();
  const second = make(t, { ...images, dataDir }); await second.app.restore(); second.app.retry(); await settled(second.app);
  assert.equal(second.app.state().completed, 1); assert.equal(images.downloads.length, 1);
});

test('missing or rejected image downloads fail explicitly instead of analyzing attachment placeholders', async t => {
  const images = fakeImages(); images.attachmentStore.prepare = async () => ({ images: [], warnings: ['图片下载失败。'], unreadAttachments: true });
  const { app, calls, msg } = make(t, images); await app.restore(); await app.receive(msg('bind', app.state().pairingCommand));
  await app.receive(msg('bad-image', '', 'owner-openid', { attachments: [imageAttachment] })); await settled(app);
  assert.equal(app.state().failed, 1); assert.equal(calls.length, 0); assert.equal(images.recognitions.length, 0);
  assert.match(app.state().lastError, /重新发送清晰/);
});

test('partial downloads retain original image numbers and do not crowd out date warnings', async t => {
  const images = fakeImages(); const basePrepare = images.attachmentStore.prepare;
  images.attachmentStore.prepare = async (...args) => {
    const result = await basePrepare(...args); result.images[0].relativePath = result.images[0].relativePath.replace('/1.png', '/2.png');
    return { ...result, warnings: ['第 1 张图片下载失败。'], unreadAttachments: true };
  };
  const essentialNotes = ['原消息时间未知，不能推断相对日期。', '存在未读取附件。'];
  const { app, msg, dataDir } = make(t, { ...images,
    recognizeImages: async () => ({ images: [{ index: 1, text: '明天开会', legibility: 'partial', uncertainties: Array.from({ length: 8 }, (_, i) => `疑点${i}`) }] }),
    analyze: async () => ({ ...structuredClone(sampleResult), notes: essentialNotes }),
  });
  await app.restore(); await app.receive(msg('bind', app.state().pairingCommand));
  await app.receive(msg('partial-download', '', 'owner-openid', { attachments: [imageAttachment, imageAttachment] })); await settled(app);
  assert.match(app.state().report, /图片 2：部分可读/); assert.match(app.state().report, /第 1 张图片下载失败/);
  const job = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs', fs.readdirSync(path.join(dataDir, 'jobs'))[0])));
  for (const note of essentialNotes) assert.ok(job.result.notes.includes(note));
});

test('a saved message without a job recovers on restart', async t => {
  const dir = temp(t); const store = createStore(dir); const now = new Date().toISOString();
  store.handleMessage({ id: 'bind', senderId: 'owner-openid', text: `绑定 ${store.ensurePairingCode()}`, timestamp: now });
  store.handleMessage({ id: 'ROBOT1.0_crash-gap+opaque/QQ=!', senderId: 'owner-openid', text: '提交课程大纲', timestamp: now });
  const { app, calls } = make(t, { dataDir: dir }); await app.restore(); await settled(app);
  assert.equal(calls.length, 1); assert.equal(app.state().completed, 1);
});

test('an image-only crash gap is recovered as an explicit resend request, never as invented text', async t => {
  const dataDir = temp(t); const store = createStore(dataDir); const timestamp = new Date().toISOString();
  store.handleMessage({ id: 'bind', senderId: 'owner-openid', text: `绑定 ${store.ensurePairingCode()}`, timestamp });
  store.handleMessage({ id: 'image-gap', senderId: 'owner-openid', text: '', timestamp, hasImages: true, attachments: [imageAttachment] });
  const images = fakeImages();
  const { app, calls } = make(t, { ...images, dataDir }); await app.restore(); await settled(app);
  assert.equal(app.state().failed, 1); assert.equal(calls.length, 0); assert.equal(images.downloads.length, 0);
  assert.match(app.state().lastError, /重新发送清晰/);
  const persisted = fs.readdirSync(path.join(dataDir, 'messages')).map(file => fs.readFileSync(path.join(dataDir, 'messages', file), 'utf8')).join('');
  assert.doesNotMatch(persisted, /temporary-signature|尚未读取|未保存附件/);
});

test('analysis failure preserves raw data and can be retried once explicitly', async t => {
  let attempts = 0;
  const { app, msg } = make(t, { analyze: async () => { if (++attempts === 1) throw Error('secret vendor payload'); return sampleResult; } });
  await app.restore(); await app.receive(msg('pair', app.state().pairingCommand));
  await app.receive(msg('notice', '任务原文')); await settled(app);
  assert.equal(app.state().failed, 1); assert.doesNotMatch(JSON.stringify(app.state()), /secret vendor payload/);
  app.retry(); await settled(app); assert.equal(attempts, 2); assert.equal(app.state().completed, 1);
});

test('queue write failure after raw storage is recovered by replay in the same process', async t => {
  const { app, calls, msg, dataDir } = make(t); await app.restore();
  await app.receive(msg('pair', app.state().pairingCommand));
  const notice = msg('retry-queue-write', '需要保存并分析的课程通知');
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    if (String(file).startsWith(path.join(dataDir, 'jobs'))) throw new Error('simulated full disk');
    return originalWrite.call(this, file, ...args);
  };
  try { await assert.rejects(app.receive(notice)); }
  finally { fs.writeFileSync = originalWrite; }
  await app.receive(notice); await settled(app);
  assert.equal(calls.length, 1); assert.equal(app.state().completed, 1);
});

test('localhost API rejects cross-origin, forged host, and missing request token', async t => {
  let configurations = 0;
  const port = 18882;
  const fakeApp = { state: () => ({ bound: false }), configure: async () => { configurations++; }, stop() {} };
  const server = createLocalServer({ application: fakeApp, port });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${port}`;
  const page = await (await fetch(base)).text();
  const token = /const token='([a-f0-9]+)'/.exec(page)[1];
  assert.equal((await fetch(`${base}/api/state`)).status, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { 'X-Local-Token': token, Origin: 'https://evil.invalid' } })).status, 403);
  const forgedStatus = await new Promise((resolve, reject) => {
    const req = http.get(base, { headers: { Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
  });
  assert.equal(forgedStatus, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { 'X-Local-Token': token } })).status, 200);
  assert.equal((await fetch(`${base}/api/configure`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': token, Origin: base }, body: '{}' })).status, 200);
  assert.equal(configurations, 1);
  assert.ok(!page.includes('http://0.0.0.0'));
});


test('selected models apply to the next notice and image stages keep one settings snapshot', async t => {
  const observed = []; let app;
  const measured = { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, totalTokens: 110, usageAvailable: true, durationMs: 15 };
  const setup = make(t, { ...fakeImages(), recognizeImages: async (_paths, options) => {
    observed.push({ model: options.model, effort: options.reasoningEffort }); options.onUsage(measured);
    await app.saveModelSettings({ textModel: 'gpt-new', imageModel: 'gpt-new', reasoningEffort: 'high' });
    return structuredClone(recognizedNotice);
  }, analyze: async (_value, options) => {
    observed.push({ model: options.model, effort: options.reasoningEffort }); options.onUsage(measured);
    return structuredClone(sampleResult);
  } });
  app = setup.app; await app.restore(); await app.receive(setup.msg('bind', app.state().pairingCommand));
  await app.saveModelSettings({ textModel: 'gpt-text', imageModel: 'gpt-image', reasoningEffort: 'low' });
  await app.receive(setup.msg('image-usage', '', 'owner-openid', { attachments: [imageAttachment] })); await settled(app);
  assert.deepEqual(observed, [{ model: 'gpt-image', effort: 'low' }, { model: 'gpt-text', effort: 'low' }]);
  assert.equal(app.state().usage.today.totalTokens, 220);
  assert.equal(app.state().usage.today.cachedInputTokens, 40);
  assert.equal(app.state().usage.recent.length, 2);
  assert.match(setup.replies.at(-1).content, /220 token/);
  await app.receive(setup.msg('next-usage', '下一条通知')); await settled(app);
  assert.deepEqual(observed.at(-1), { model: 'gpt-new', effort: 'high' });
  const before = app.state().usage.today.calls;
  await app.receive(setup.msg('today', '/today'));
  assert.equal(app.state().usage.today.calls, before);
});

test('tests, failures and retries each keep their own token entry without private error content', async t => {
  let count = 0;
  const { app, msg, dataDir } = make(t, { analyze: async (_value, options) => {
    count++;
    if (count === 2) throw new Error('private payload never shown');
    options.onUsage({ inputTokens: 42, cachedInputTokens: 12, outputTokens: 8, totalTokens: 50, usageAvailable: true });
    return structuredClone(sampleResult);
  } });
  await app.restore(); await app.testAnalysis();
  await app.receive(msg('bind', app.state().pairingCommand));
  await app.receive(msg('retry-usage', '一条任务')); await settled(app);
  assert.equal(app.state().usage.recent[0].status, 'failed');
  assert.equal(app.state().usage.recent[0].totalTokens, null);
  app.retry(); await settled(app);
  assert.deepEqual(app.state().usage.today, { calls: 3, inputTokens: 84, cachedInputTokens: 24, outputTokens: 16, totalTokens: 100, unknownCalls: 1, unknownCacheCalls: 0 });
  assert.equal(app.state().usage.recent[2].kind, 'test');
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir, 'model-usage.json'), 'utf8'), /private payload|一条任务|owner-openid/);
});

test('model settings API requires the same local token and preserves safe validation errors', async t => {
  let saved;
  const port = 18883;
  const server = createLocalServer({ port, application: { async saveModelSettings(value) {
    if (!value.textModel) throw Object.assign(new Error('请选择目录内模型。'), { code: 'MODEL_SETTINGS_INVALID' });
    saved = value;
  } } });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${port}`;
  const token = /const token='([a-f0-9]+)'/.exec(await (await fetch(base)).text())[1];
  const post = (body, authenticated) => fetch(`${base}/api/model-settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...(authenticated ? { 'X-Local-Token': token } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ textModel: 'default' }, false)).status, 403);
  const invalid = await post({}, true); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error, '请选择目录内模型。');
  assert.equal((await post({ textModel: 'default', imageModel: 'default', reasoningEffort: 'low' }, true)).status, 200);
  assert.equal(saved.reasoningEffort, 'low');
});

test('metering write failures preserve a successful analysis without causing another model call', async t => {
  let calls = 0; let failingUsageWrite = false;
  const { app, msg, dataDir } = make(t, { analyze: async (_value, options) => {
    calls++; options.onUsage({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 5 });
    failingUsageWrite = true;
    return structuredClone(sampleResult);
  } });
  await app.restore(); await app.receive(msg('bind', app.state().pairingCommand));
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    if (failingUsageWrite && String(file) === path.join(dataDir, 'model-usage.json.tmp')) { failingUsageWrite = false; throw new Error('simulated metering write error'); }
    return originalWrite.call(this, file, ...args);
  };
  try { await app.receive(msg('metering-failure', '通知正文')); await settled(app); }
  finally { fs.writeFileSync = originalWrite; }
  assert.equal(app.state().completed, 1); assert.equal(app.state().failed, 0);
  assert.match(app.state().usage.warning, /部分用量未能保存/);
  assert.match(app.state().report, /提交课程大纲/);
  app.retry(); await settled(app); assert.equal(calls, 1);
});
