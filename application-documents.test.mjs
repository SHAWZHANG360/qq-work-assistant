import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createApplication } from './application.mjs';
import { createStore } from './store.mjs';
import { createLocalServer } from './server.mjs';
import { formatAnalysis } from './analyzer.mjs';

const hash = id => createHash('sha256').update(id).digest('hex');
const docAttachment = { filename: 'synthetic-notice.txt', content_type: 'text/plain', url: 'https://multimedia.nt.qq.com.cn/test?temporary-signature=never-persist' };
const imageAttachment = { filename: 'synthetic-image.png', content_type: 'image/png', url: 'https://multimedia.nt.qq.com.cn/test-image?temporary-signature=never-persist' };
const unknownAttachment = { filename: 'voice.amr', content_type: 'audio/amr', url: 'https://multimedia.nt.qq.com.cn/test-audio?temporary-signature=never-persist' };
const emptyResult = { summary: '虚构附件测试通知', relevance: 'direct', actions: [], questions: [], notes: [] };
const uncertainDocumentNote = '文件文字提取不完整或存在不确定项，请核对原文件及页码；未读取部分不能视为没有要求。';
function action(title, deadline = null, needsConfirmation = false) {
  return { title, owner: '测试本人', deadline, calendarStart: null, calendarEnd: null, location: null, evidence: `${title}的完整原文依据`, needsConfirmation };
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-doc-integration-'));
  t.after(() => {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function fakeDocuments(overrides = {}) {
  const prepared = [], localPrepared = [], resolved = [];
  function result(id, name = 'synthetic-notice.txt') {
    return { documents: [{ relativePath: `documents/${hash(id)}/1.txt`, name, mimeType: 'text/plain', size: 27, sha256: 'a'.repeat(64), text: '[第1页]\n虚构文件正文：请参加课程研讨。', truncated: false, warnings: [] }], warnings: [], unreadAttachments: false };
  }
  const documentStore = {
    async prepare(id, attachments, options) { prepared.push({ id, attachments, options }); return result(id); },
    async prepareLocal(id, files, options) { localPrepared.push({ id, files, options }); return result(id, files[0].name); },
    async resolveDocuments(id, documents) { resolved.push({ id, documents }); return structuredClone(documents); },
    ...overrides,
  };
  return { documentStore, prepared, localPrepared, resolved, result };
}
function make(t, overrides = {}) {
  const dataDir = overrides.dataDir ?? temp(t);
  const calls = [], replies = [];
  class Client {
    constructor(options) { this.options = options; }
    start() { this.options.onStatus({ state: 'connected', message: 'test connected' }); }
    stop() {}
    async reply(value) { replies.push(value); }
  }
  const settings = { textModel: 'default', imageModel: 'default', reasoningEffort: 'low' };
  const app = createApplication({ appId: '123456789', dataDir, preferences: { ownerProfile: { name: '测试本人' } }, Client,
    modelSettings: { async initialize() {}, getSettings: () => ({ ...settings }), getSnapshot: () => ({ settings, models: [], catalogSource: 'test' }) },
    analyze: async input => { calls.push(input); return structuredClone(emptyResult); },
    recognizeImages: async () => ({ images: [{ index: 1, text: '虚构图片文字：会议在测试室。', legibility: 'clear', uncertainties: [] }] }),
    formatAnalysis,
    secrets: { async load() { return 'synthetic-secret-only'; }, async save() {}, exists() { return false; } },
    ...overrides,
  });
  t.after(() => app.stop());
  const msg = (id, text = '', senderId = 'owner-openid', extra = {}) => ({ id, text, senderId, timestamp: new Date().toISOString(), ...extra });
  return { app, dataDir, calls, replies, msg };
}
async function bind(state) {
  await state.app.restore();
  await state.app.receive(state.msg('binding-fixture', state.app.state().pairingCommand));
}
async function settled(app) {
  for (let n = 0; n < 200; n++) {
    const state = app.state();
    if (!state.analysisBusy && state.pending === 0) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('mock queue did not settle');
}
function job(dataDir, id) { return JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs', hash(id) + '.json'), 'utf8')); }
function upload(requestId = '12345678-1234-1234-1234-123456789012') {
  return { requestId, text: '虚构附件补充说明', files: [{ name: 'synthetic-local.txt', base64: Buffer.from('虚构本机文件').toString('base64') }] };
}

test('only the bound owner may trigger document downloads or analysis', async t => {
  const docs = fakeDocuments(); const s = make(t, docs);
  await s.app.restore();
  await s.app.receive(s.msg('unbound-document', '', 'owner-openid', { attachments: [docAttachment] }));
  await assert.rejects(s.app.uploadDocuments(upload()), /先完成本人 QQ 绑定/);
  assert.equal(docs.prepared.length, 0); assert.equal(docs.localPrepared.length, 0);
  await s.app.receive(s.msg('binding-fixture', s.app.state().pairingCommand));
  await s.app.receive(s.msg('foreign-document', '', 'foreign-openid', { attachments: [docAttachment] }));
  assert.equal(docs.prepared.length, 0);
  await s.app.receive(s.msg('own-document', '', 'owner-openid', { attachments: [docAttachment] }));
  await settled(s.app);
  assert.equal(docs.prepared.length, 1); assert.equal(s.calls.length, 1);
  assert.match(s.calls[0].text, /【附件：synthetic-notice.txt】\n\[第1页\]/);
  assert.equal(s.calls[0].hasAttachments, false); assert.equal(s.calls[0].documentUncertain, false);
  assert.ok(s.replies.every(reply => reply.senderId === 'owner-openid'));
  const persisted = ['jobs', 'messages'].flatMap(dir => fs.readdirSync(path.join(s.dataDir, dir)).map(file => fs.readFileSync(path.join(s.dataDir, dir, file), 'utf8'))).join('');
  assert.doesNotMatch(persisted, /temporary-signature|multimedia\.nt|foreign-document|unbound-document/);
});

test('mixed text, document and image are all analyzed while unknown attachments stay unread', async t => {
  const docs = fakeDocuments(); const imageDownloads = [];
  const attachmentStore = {
    async prepare(id, attachments) { imageDownloads.push(attachments); return { images: [{ relativePath: `images/${hash(id)}/1.png`, mimeType: 'image/png', size: 12 }], warnings: [], unreadAttachments: false }; },
    async resolveImages(id, images) { return images.map(image => ({ ...image, path: path.join(os.tmpdir(), image.relativePath) })); },
  };
  const s = make(t, { ...docs, attachmentStore }); await bind(s);
  await s.app.receive(s.msg('mixed-documents', '虚构原消息正文', 'owner-openid', { attachments: [docAttachment, imageAttachment, unknownAttachment] }));
  await settled(s.app);
  assert.equal(s.calls.length, 1); assert.equal(docs.prepared[0].attachments.length, 1); assert.equal(imageDownloads[0].length, 1);
  assert.match(s.calls[0].text, /虚构原消息正文/); assert.match(s.calls[0].text, /虚构文件正文/); assert.match(s.calls[0].text, /虚构图片文字/);
  assert.equal(s.calls[0].hasAttachments, true);
  assert.equal(job(s.dataDir, 'mixed-documents').hasUnknownAttachments, true);
  const raw = fs.readdirSync(path.join(s.dataDir, 'messages')).map(file => fs.readFileSync(path.join(s.dataDir, 'messages', file), 'utf8')).join('');
  assert.match(raw, /"hasUnknownAttachments":true/);
});

test('partially extracted documents mark actions for confirmation and explain the read boundary', async t => {
  const docs = fakeDocuments(); const prepare = docs.documentStore.prepare;
  docs.documentStore.prepare = async (...args) => {
    const value = await prepare(...args); value.documents[0].truncated = true;
    value.documents[0].warnings = ['第2页为扫描图片，未提取文字。']; value.unreadAttachments = true; return value;
  };
  let input;
  const s = make(t, { ...docs, analyze: async value => { input = value; return { ...structuredClone(emptyResult), actions: [action('提交测试材料')], notes: [uncertainDocumentNote] }; } });
  await bind(s); await s.app.receive(s.msg('partial-document', '', 'owner-openid', { attachments: [docAttachment] })); await settled(s.app);
  assert.equal(input.documentUncertain, true); assert.equal(input.hasAttachments, true);
  const saved = job(s.dataDir, 'partial-document'); assert.equal(saved.result.actions[0].needsConfirmation, true);
  assert.match(s.app.state().report, /部分读取，不能视为全文/); assert.match(s.app.state().report, /第2页为扫描图片/);
  assert.match(s.app.state().recent[0].brief, /附件未读全/);
});

test('an unreadable file yields no model call or fabricated task, with local upload guidance', async t => {
  const docs = fakeDocuments({ async prepare() { return { documents: [], warnings: ['文件损坏，正文尚未读取。'], unreadAttachments: true }; } });
  const s = make(t, docs); await bind(s);
  await s.app.receive(s.msg('unreadable-file', '', 'owner-openid', { attachments: [docAttachment] })); await settled(s.app);
  assert.equal(s.calls.length, 0); assert.equal(s.app.state().completed, 1);
  assert.match(s.app.state().recent[0].brief, /未提取到可读正文/);
  assert.match(s.app.state().report, /文件损坏，正文尚未读取/);
  assert.deepEqual(job(s.dataDir, 'unreadable-file').result.actions, []);
});

test('combined text truncation is explicit and retained outside model notes', async t => {
  const docs = fakeDocuments(); const prepare = docs.documentStore.prepare;
  docs.documentStore.prepare = async (...args) => { const value = await prepare(...args); value.documents[0].text = '文'.repeat(45000); return value; };
  const s = make(t, docs); await bind(s);
  await s.app.receive(s.msg('combined-over-limit', '原'.repeat(10000), 'owner-openid', { attachments: [docAttachment] })); await settled(s.app);
  assert.equal(s.calls[0].text.length, 54000);
  assert.equal(s.calls[0].documentUncertain, true); assert.equal(s.calls[0].hasAttachments, true);
  assert.match(s.app.state().report, /只分析前 54000 字/);
  assert.match(s.app.state().recent[0].warnings.join(' '), /请拆开发送/);
});

test('local upload is deduplicated, bound to the owner, and never passively sent to QQ', async t => {
  const docs = fakeDocuments(); const s = make(t, docs); await bind(s); const beforeReplies = s.replies.length;
  const first = await s.app.uploadDocuments(upload()); await settled(s.app);
  const replay = await s.app.uploadDocuments(upload()); await settled(s.app);
  assert.equal(first.jobId, replay.jobId); assert.equal(replay.duplicate, true);
  assert.equal(docs.localPrepared.length, 1); assert.equal(s.calls.length, 1);
  assert.equal(s.replies.length, beforeReplies); assert.equal(s.app.state().recent[0].source, 'local');
  assert.equal(s.app.state().recent[0].deliveredToQQ, false);
  assert.equal(job(s.dataDir, 'local-upload:' + upload().requestId).message.senderId, 'owner-openid');
});

test('a saved upload ID deduplicates even when the queue is full and rejects changed contents', async t => {
  const docs = fakeDocuments(); const s = make(t, docs); await bind(s); s.app.setPaused(true);
  const first = await s.app.uploadDocuments(upload());
  for (let index = 2; index <= 5; index++) await s.app.uploadDocuments(upload(`12345678-1234-1234-1234-${String(index).padStart(12, '0')}`));
  assert.equal(s.app.state().pending, 5);
  const replay = await s.app.uploadDocuments(upload()); assert.equal(replay.duplicate, true); assert.equal(replay.jobId, first.jobId);
  await assert.rejects(s.app.uploadDocuments({ ...upload(), text: '已修改的补充说明' }), /内容已改变|内容不一致/);
  assert.equal(docs.localPrepared.length, 5); assert.equal(s.calls.length, 0);
});

test('a local upload can replay its ID after durable receipt but failed queue persistence', async t => {
  const docs = fakeDocuments(); const s = make(t, docs); await bind(s);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    if (String(file).startsWith(path.join(s.dataDir, 'jobs'))) throw Error('synthetic disk failure');
    return originalWrite.call(this, file, ...args);
  };
  try { await assert.rejects(s.app.uploadDocuments(upload())); }
  finally { fs.writeFileSync = originalWrite; }
  await s.app.uploadDocuments(upload()); await settled(s.app);
  assert.equal(s.calls.length, 1); assert.equal(s.app.state().completed, 1);
  assert.equal(fs.readdirSync(path.join(s.dataDir, 'jobs')).filter(name => name.endsWith('.json')).length, 1);
});

test('restored processing documents revalidate cached originals and do not download again', async t => {
  const dataDir = temp(t); const docs = fakeDocuments();
  const first = make(t, { ...docs, dataDir, analyze: async () => { throw Error('synthetic model failure'); } });
  await bind(first); await first.app.receive(first.msg('restore-document', '', 'owner-openid', { attachments: [docAttachment] })); await settled(first.app);
  assert.equal(first.app.state().failed, 1); assert.equal(docs.prepared.length, 1); first.app.stop();
  // A crash can leave this durable state. Restoring it must use the saved descriptors.
  const file = path.join(dataDir, 'jobs', hash('restore-document') + '.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')); stored.state = 'processing'; fs.writeFileSync(file, JSON.stringify(stored));
  const second = make(t, { ...docs, dataDir }); await second.app.restore(); await settled(second.app);
  assert.equal(second.calls.length, 1); assert.equal(docs.prepared.length, 1); assert.equal(docs.resolved.length, 1);
  assert.equal(second.app.state().completed, 1); assert.match(second.calls[0].text, /虚构文件正文/);
});

test('a document-only receipt gap asks for the original instead of inventing unseen contents', async t => {
  const dataDir = temp(t), store = createStore(dataDir), timestamp = new Date().toISOString();
  store.handleMessage({ id: 'bind', senderId: 'owner-openid', text: `绑定 ${store.ensurePairingCode()}`, timestamp });
  store.handleMessage({ id: 'document-gap', senderId: 'owner-openid', text: '', timestamp, hasDocuments: true, hasUnknownAttachments: true, attachments: [docAttachment, unknownAttachment] });
  const docs = fakeDocuments(); const s = make(t, { ...docs, dataDir }); await s.app.restore(); await settled(s.app);
  assert.equal(s.calls.length, 0); assert.equal(docs.prepared.length, 0); assert.equal(s.app.state().failed, 1);
  assert.match(s.app.state().lastError, /重新上传原文件/);
  assert.equal(job(dataDir, 'document-gap').hasUnknownAttachments, true);
});

test('brief QQ replies put actions first, retain unread warnings, and omit confirmation boilerplate', async t => {
  const result = { ...structuredClone(emptyResult), actions: [action('较晚任务', '2026-10-23'), action('最早任务', '2026-10-17', true), action('第三任务', '2026-10-19'), action('第二任务', '2026-10-18')],
    questions: Array.from({ length: 6 }, (_, i) => `虚构待确认问题${i + 1}`), notes: [uncertainDocumentNote] };
  const s = make(t, { ...fakeDocuments(), analyze: async () => structuredClone(result) }); await bind(s);
  for (const id of ['daily-one', 'daily-two']) { await s.app.receive(s.msg(id, '虚构通知')); await settled(s.app); }
  const reply = s.replies.filter(item => item.msgSeq === 2).at(-1).content.split('\n\n')[0];
  assert.ok(Array.from(reply).length <= 400); assert.ok(reply.indexOf('最早任务') < reply.indexOf('第二任务'));
  assert.ok(reply.indexOf('第二任务') < reply.indexOf('第三任务')); assert.doesNotMatch(reply, /较晚任务/);
  assert.match(reply, /^【要做】/); assert.doesNotMatch(reply, /另有|〔待确认〕|完整详情|负责人待确认|时间待确认/);
  assert.match(reply, /截止：2026-10-17/);
  assert.match(s.app.state().report, /较晚任务的完整原文依据/);
  assert.doesNotMatch(s.app.state().dailyBrief, /待确认问题|完整详情/); assert.match(s.app.state().dailyBrief, /附件未读全/);
});

test('stop during local extraction must not create a new pending model job', async t => {
  let resolveExtraction; let entered;
  const started = new Promise(resolve => { entered = resolve; }); const docs = fakeDocuments();
  docs.documentStore.prepareLocal = async (id, files, options) => { entered(options.signal); return new Promise(resolve => { resolveExtraction = () => resolve(docs.result(id, files[0].name)); }); };
  const s = make(t, docs); await bind(s);
  const pending = s.app.uploadDocuments(upload()); const signal = await started; s.app.stop(); assert.equal(signal.aborted, true);
  resolveExtraction();
  await assert.rejects(pending, /停止|取消/);
  assert.equal(s.calls.length, 0); assert.equal(s.app.state().pending, 0);
});

async function freePort() {
  const probe = net.createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
function post(port, headers, body = '{}') {
  return new Promise((resolve, reject) => {
    // Deliberately oversized Content-Length is rejected before the full body.
    // Do not pool that incomplete request's connection into the next assertion.
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/documents', method: 'POST', agent: false, headers: { ...headers, Connection: 'close' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => { resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }); req.destroy(); });
    }); req.on('error', reject); req.setTimeout(1500, () => req.destroy(Error('mock HTTP timeout'))); req.end(body);
  });
}
test('the upload API rejects forged origins, absent tokens and oversized bodies before extraction', async t => {
  let uploads = 0; const port = await freePort();
  const application = { async uploadDocuments() { uploads++; return { jobId: 'synthetic' }; } };
  const server = createLocalServer({ application, port }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${port}`;
  const page = await (await fetch(base)).text(); const token = page.match(/const token='([a-f0-9]{64})'/)?.[1]; assert.ok(token);
  const headers = { 'Content-Type': 'application/json', 'X-Local-Token': token, Origin: base };
  assert.equal((await post(port, { ...headers, 'X-Local-Token': '' })).status, 403);
  assert.equal((await post(port, { ...headers, Origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await post(port, { ...headers, Host: 'untrusted.invalid' })).status, 403);
  assert.equal((await post(port, { ...headers, 'Content-Length': String(28 * 1024 * 1024 + 1) })).status, 413);
  assert.equal(uploads, 0);
  assert.equal((await post(port, headers)).status, 200); assert.equal(uploads, 1);
});
