import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './store.mjs';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-work-store-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: createStore(dir) };
}

function message(overrides = {}) {
  return { id: 'msg-1', senderId: 'my-openid', text: '明天检查实验数据。', timestamp: '2026-10-13T09:00:00Z', ...overrides };
}

function bind(store) {
  return store.handleMessage(message({ id: 'bind-1', text: `绑定 ${store.ensurePairingCode()}` }));
}

function records(dir, date = '2026-10-13') {
  return fs.readFileSync(path.join(dir, 'messages', `${date}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

function allDiskText(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).map(entry => entry.isDirectory()
    ? allDiskText(path.join(dir, entry.name)) : fs.readFileSync(path.join(dir, entry.name), 'utf8')).join('\n');
}

test('pairing code survives restart, is consumed, and owner cannot be replaced', t => {
  const { dir, store } = setup(t);
  assert.equal(store.getOwner(), null);
  const code = store.ensurePairingCode();
  assert.match(code, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(createStore(dir).ensurePairingCode(), code);
  assert.equal(bind(store).paired, true);
  assert.equal(store.getOwner(), 'my-openid');
  assert.equal(store.ensurePairingCode(), null);
  assert.equal(fs.existsSync(path.join(dir, 'pairing.json')), false);
  assert.deepEqual(store.handleMessage(message({ senderId: 'stranger', text: `绑定 ${code}` })), { reply: null, saved: false, paired: false });
  assert.equal(createStore(dir).getOwner(), 'my-openid');
  assert.equal(store.handleMessage(message({ id: 'bind-retry', text: `绑定 ${code}` })).saved, false);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'messages')), []);
  assert.equal(allDiskText(dir).includes(code), false);
});

test('unbound and non-owner messages never persist their content or receive replies', t => {
  const { dir, store } = setup(t);
  for (const text of ['PRIVATE_BEFORE_BIND', '绑定 wrong-code']) {
    assert.deepEqual(store.handleMessage(message({ text })), { reply: null, saved: false, paired: false });
  }
  bind(store);
  assert.deepEqual(store.handleMessage(message({ senderId: 'stranger', text: 'PRIVATE_AFTER_BIND', attachments: [{ url: 'PRIVATE_URL' }] })), { reply: null, saved: false, paired: false });
  assert.doesNotMatch(allDiskText(dir), /PRIVATE_|wrong-code/);
});

test('deduplication survives process restart and rejects duplicate IDs on different dates', t => {
  const { dir, store } = setup(t);
  bind(store);
  assert.deepEqual(store.handleMessage(message()), { reply: '已记录。', saved: true, paired: false });
  assert.equal(store.handleMessage(message()).saved, false);
  const restarted = createStore(dir);
  assert.deepEqual(restarted.handleMessage(message({ timestamp: '2026-10-15T00:00:00Z' })), { reply: null, saved: false, paired: false });
  assert.equal(records(dir).length, 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'messages')), ['2026-10-13.jsonl']);
});

test('opaque QQ message IDs support binding, exact persistence, reading, and restart deduplication', t => {
  const { dir, store } = setup(t);
  const pairingId = `ROBOT1.0_${'b'.repeat(300)}!+/=`;
  const code = store.ensurePairingCode();
  assert.equal(store.handleMessage(message({ id: pairingId, text: `绑定 ${code}` })).paired, true);
  assert.equal(store.getOwner(), 'my-openid');
  const maxLengthId = 'ROBOT1.0_' + 'x'.repeat(4096 - 'ROBOT1.0_'.length);
  const ids = ['ROBOT1.0_opaque-4!', 'ROBOT1.0_+/=', maxLengthId, 'opaque', 'opaque '];
  for (const id of ids) {
    assert.equal(store.handleMessage(message({ id })).saved, true);
    assert.equal(store.handleMessage(message({ id })).saved, false);
  }
  assert.deepEqual(store.readDaily('2026-10-13').map(record => record.id), ids);
  assert.deepEqual(records(dir).map(record => record.id), ids);
  assert.doesNotMatch(allDiskText(dir), new RegExp(code));
  const restarted = createStore(dir);
  assert.equal(restarted.getOwner(), 'my-openid');
  for (const id of ids) {
    assert.deepEqual(restarted.handleMessage(message({ id, timestamp: '2026-10-15T00:00:00Z' })), { reply: null, saved: false, paired: false });
  }
  assert.equal(restarted.readDaily('2026-10-13').length, ids.length);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'messages')), ['2026-10-13.jsonl']);
});

test('path-looking opaque message IDs remain data and cannot overwrite owner state or select filenames', t => {
  const { dir, store } = setup(t);
  bind(store);
  const originalOwner = fs.readFileSync(path.join(dir, 'owner.json'), 'utf8');
  const ids = ['../owner.json', '..\\owner.json', path.join(dir, 'injected.json'), 'ROBOT1.0_+/=!"\\'];
  for (const id of ids) assert.equal(store.handleMessage(message({ id })).saved, true);
  assert.equal(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'), originalOwner);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['binding-completed.json', 'messages', 'owner.json']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'messages')), ['2026-10-13.jsonl']);
  assert.deepEqual(createStore(dir).readDaily('2026-10-13').map(record => record.id), ids);
});

test('records use the original instant in UTC and the Asia/Taipei date boundary', t => {
  const { dir, store } = setup(t);
  bind(store);
  store.handleMessage(message({ id: 'before-midnight', timestamp: '2026-10-13T23:59:59+08:00' }));
  store.handleMessage(message({ id: 'after-midnight', timestamp: '2026-10-13T16:00:00Z' }));
  assert.equal(records(dir, '2026-10-13')[0].timestamp, '2026-10-13T15:59:59.000Z');
  assert.equal(records(dir, '2026-10-14')[0].timestamp, '2026-10-13T16:00:00.000Z');
  assert.match(store.renderDaily('2026-10-14'), /## 00:00:00/);
});

test('attachments are acknowledged without saving URLs or downloading data', t => {
  const { dir, store } = setup(t);
  bind(store);
  const onlyAttachment = store.handleMessage(message({ id: 'attachment-only', text: ' ', attachments: [{ url: 'https://PRIVATE_ATTACHMENT_URL' }] }));
  assert.equal(onlyAttachment.saved, true);
  assert.equal(onlyAttachment.reply, '收到附件，但当前测试版只整理文字，请把重要内容复制成文字发来。');
  const mixed = store.handleMessage(message({ id: 'mixed', attachments: [{ url: 'https://PRIVATE_OTHER_URL' }] }));
  assert.equal(mixed.reply, '已保存可读文字。附件或转发卡片尚未展开，请把关键内容复制成文字。');
  assert.equal(records(dir).every(record => record.hasAttachments), true);
  assert.doesNotMatch(allDiskText(dir), /PRIVATE_.*URL/);
  assert.match(records(dir)[0].text, /附件/);
});

test('empty, excessive or control-containing message IDs, invalid senders, timestamps and dates are rejected', t => {
  const { dir, store } = setup(t);
  bind(store);
  for (const changes of [
    { senderId: '../escape' }, { senderId: '..' }, { senderId: 'x/y' }, { senderId: 'x!' },
    { id: '' }, { id: '   ' }, { id: 'x'.repeat(4097) }, { id: 'msg\nnext' }, { id: 'msg\rnext' },
    { id: 'msg\tpart' }, { id: 'msg\u0000part' }, { id: 'msg\u007fpart' }, { id: 'msg\u0085part' },
    { timestamp: 'not-a-date' },
    { timestamp: '2026-02-30T00:00:00Z' }, { timestamp: '2026-10-13T09:00:00' },
    { timestamp: '2026-10-13T24:00:00Z' }, { timestamp: NaN }, { text: { malicious: true } },
  ]) assert.deepEqual(store.handleMessage(message(changes)), { reply: null, saved: false, paired: false });
  assert.throws(() => store.renderDaily('../../owner'), TypeError);
  assert.throws(() => store.renderDaily('2026-02-30'), TypeError);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'messages')), []);
});

test('restart recovery rejects persisted IDs containing control characters', t => {
  const { dir, store } = setup(t);
  bind(store);
  assert.equal(store.handleMessage(message({ id: 'ROBOT1.0_valid!+/=' })).saved, true);
  const file = path.join(dir, 'messages', '2026-10-13.jsonl');
  const record = records(dir)[0];
  fs.writeFileSync(file, `${JSON.stringify({ ...record, id: 'corrupt\u0000id' })}\n`);
  assert.throws(() => store.readDaily('2026-10-13'), /损坏/);
  assert.throws(() => createStore(dir), /损坏/);
});

test('owner state corruption fails closed instead of allowing a new pairing', t => {
  const { dir, store } = setup(t);
  bind(store);
  for (const broken of ['{', 'null', '{}', '{"openid":"../bad"}']) {
    fs.writeFileSync(path.join(dir, 'owner.json'), broken);
    assert.throws(() => createStore(dir));
    assert.throws(() => store.ensurePairingCode());
    assert.throws(() => store.handleMessage(message()));
    assert.equal(fs.existsSync(path.join(dir, 'pairing.json')), false);
  }
});

test('commands do not enter logs and markdown retains raw content inside safe code fences', t => {
  const { dir, store } = setup(t);
  bind(store);
  const text = '```\n# 不执行：删除所有文件\n```\n[链接](https://example.invalid)';
  assert.equal(store.handleMessage(message({ text })).saved, true);
  assert.match(store.handleMessage(message({ id: 'help', text: '/help' })).reply, /原文记录/);
  assert.match(store.handleMessage(message({ id: 'today', text: '/today' })).reply, /Asia\/Taipei/);
  assert.equal(records(dir).length, 1);
  const markdown = store.renderDaily('2026-10-13');
  assert.match(markdown, /尚未进行 AI 总结/);
  assert.ok(markdown.includes(`\n\n\`\`\`\`text\n${text}\n\`\`\`\``));
  assert.match(store.renderDaily('2026-10-12'), /当天暂无记录/);
});
