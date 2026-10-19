import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createAttachmentStore, isImageAttachment, describeAttachment, normalizeImageUrl, isPublicAddress, inspectImage, resolveImageAddresses } from './attachments.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5xkAAAAASUVORK5CYII=', 'base64');
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const URL = 'https://multimedia.nt.qq.com.cn/download?signature=do-not-persist';
const attachment = (extra = {}) => ({ content_type: 'image/png', url: URL, filename: '../../untrusted.png', ...extra });
const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }];
const response = (bytes = PNG, extra = {}) => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' }, ...extra });
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createAttachmentStore({ dataDir, lookupImpl: publicLookup, fetchImpl: async () => response(), ...options }) };
}

test('only supported image MIME types qualify; persisted metadata never contains remote URL or filename', () => {
  assert.equal(isImageAttachment(attachment()), true);
  for (const content_type of ['image/svg+xml', 'image/gif', 'text/html', 'file', '', null]) assert.equal(isImageAttachment({ content_type }), false);
  assert.deepEqual(describeAttachment(attachment({ size: 100 })), { kind: 'image', mimeType: 'image/png', size: 100 });
});

test('URL whitelist handles official protocol-relative URLs and denies unsafe targets', () => {
  assert.equal(normalizeImageUrl('//gchat.qpic.cn/test.png').href, 'https://gchat.qpic.cn/test.png');
  for (const url of ['http://gchat.qpic.cn/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x',
    'https://2130706433/x', 'https://0x7f000001/x', 'https://gchat.qpic.cn.evil.test/x', 'https://evilqpic.cn/x',
    'https://gchat.qpic.cn@evil.test/x', 'https://a:b@gchat.qpic.cn/x', 'https://gchat.qpic.cn:8080/x',
    'https://gchat.qpic.cn/x#fragment', 'https://gchat.qpic.cn\\evil/x', 'data:image/png,xxx', 'file:///C:/test.png']) {
    assert.throws(() => normalizeImageUrl(url), { code: 'url' });
  }
});

test('private, reserved, mapped and loopback IP addresses are rejected', () => {
  for (const address of ['127.0.0.1', '10.3.1.5', '169.254.169.254', '172.17.1.1', '192.168.2.1',
    '100.64.0.5', '0.0.0.0', '198.18.1.3', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1',
    '2001:db8::1', '2002:7f00:1::1']) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '240e:1::1', '2001:4860:4860::8888']) assert.equal(isPublicAddress(address), true);
});

test('downloads valid image without authentication, uses hashed safe paths and reuses validated cache', async t => {
  let calls = 0;
  const { store, dataDir } = await fixture(t, { fetchImpl: async (url, options) => {
    calls++; assert.equal(url, URL); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    assert.equal(Object.keys(options.headers).some(key => /authorization|cookie/i.test(key)), false);
    return response();
  } });
  const result = await store.prepare('../opaque/id!+=', [attachment()]);
  assert.equal(result.images.length, 1); assert.deepEqual(result.warnings, []); assert.equal(result.unreadAttachments, false);
  const expected = createHash('sha256').update('../opaque/id!+=').digest('hex');
  assert.equal(result.images[0].relativePath, `images/${expected}/1.png`);
  assert.deepEqual(await fs.readFile(result.images[0].path), PNG);
  assert.equal(result.images[0].path.startsWith(dataDir), true);
  assert.equal(JSON.stringify(result).includes('signature'), false);
  assert.equal((await store.prepare('../opaque/id!+=', [attachment()])).images.length, 1);
  assert.equal(calls, 1);
  const descriptors = result.images.map(({ relativePath, mimeType, size }) => ({ relativePath, mimeType, size }));
  assert.deepEqual(await store.resolveImages('../opaque/id!+=', descriptors), result.images);
});

test('untrusted network target is never fetched; DNS responses are checked before fetch', async t => {
  let calls = 0;
  const { store } = await fixture(t, { lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }], fetchImpl: async () => { calls++; return response(); } });
  const result = await store.prepare('private', [attachment(), attachment({ url: 'https://evil.test/image.png' })]);
  assert.equal(calls, 0); assert.equal(result.images.length, 0); assert.equal(result.unreadAttachments, true);
  assert.equal(result.warnings.length, 2); assert.equal(result.warnings.join().includes('signature'), false);
});

test('redirects and unexpected authentication errors fail safely without following or leaking URL', async t => {
  let calls = 0;
  const { store } = await fixture(t, { fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1' } }); } });
  const result = await store.prepare('redirect', [attachment()]);
  assert.equal(calls, 1); assert.equal(result.images.length, 0); assert.match(result.warnings[0], /跳转/);
  const { store: failed } = await fixture(t, { fetchImpl: async () => { throw new Error(URL); } });
  const errorResult = await failed.prepare('error', [attachment()]);
  assert.equal(errorResult.warnings.join().includes(URL), false);
});

test('rejects SVG, GIF, false magic, truncated PNG, and mismatched response MIME', async t => {
  for (const bytes of [Buffer.from('<svg onload="alert(1)"/>'), Buffer.from('GIF89a........'), PNG.subarray(0, 33), Buffer.from('not an image at all')]) {
    const { store } = await fixture(t, { fetchImpl: async () => response(bytes) });
    assert.equal((await store.prepare('fake', [attachment()])).images.length, 0);
  }
  const { store } = await fixture(t, { fetchImpl: async () => response(PNG, { headers: { 'content-type': 'image/jpeg' } }) });
  assert.equal((await store.prepare('mismatch', [attachment()])).images.length, 0);
});

test('accepts CDN format conversion from metadata and safely reuses the detected-format cache', async t => {
  let calls = 0;
  const { store } = await fixture(t, { fetchImpl: async () => { calls++; return response(); } });
  const converted = attachment({ content_type: 'image/jpeg' });
  const first = await store.prepare('converted', [converted]);
  assert.equal(first.images[0].mimeType, 'image/png'); assert.match(first.images[0].relativePath, /1\.png$/);
  assert.equal((await store.prepare('converted', [converted])).images.length, 1); assert.equal(calls, 1);
});

test('bounds claimed size, Content-Length and streaming byte size without reading unlimited content', async t => {
  let calls = 0;
  const { store } = await fixture(t, { maxBytesPerImage: 100, fetchImpl: async () => { calls++; return response(PNG, { headers: { 'content-length': '101' } }); } });
  assert.equal((await store.prepare('metadata-size', [attachment({ size: 101 })])).images.length, 0); assert.equal(calls, 0);
  assert.equal((await store.prepare('header-size', [attachment()])).images.length, 0); assert.equal(calls, 1);
  let cancelled = false;
  const { store: streamStore } = await fixture(t, { maxBytesPerImage: 100, fetchImpl: async () => response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(70)); controller.enqueue(new Uint8Array(70)); },
    cancel() { cancelled = true; },
  })) });
  assert.equal((await streamStore.prepare('stream-size', [attachment()])).images.length, 0);
  assert.equal(cancelled, true);
});

test('pixel and dimension bounds are taken from downloaded bytes, not trusted metadata', async t => {
  const bomb = Buffer.from(PNG); bomb.writeUInt32BE(100_000, 16);
  const { store } = await fixture(t, { fetchImpl: async () => response(bomb) });
  const result = await store.prepare('bomb', [attachment({ width: 1, height: 1 })]);
  assert.equal(result.images.length, 0); assert.match(result.warnings[0], /尺寸/);
});

test('count and aggregate limits allow partial success and mark leftovers unread', async t => {
  const { store } = await fixture(t);
  const countResult = await store.prepare('many', Array.from({ length: 5 }, () => attachment()));
  assert.equal(countResult.images.length, 4); assert.equal(countResult.unreadAttachments, true); assert.match(countResult.warnings.join(), /最多识别 4/);
  const { store: aggregate } = await fixture(t, { maxTotalBytes: PNG.length + 1 });
  const totalResult = await aggregate.prepare('total', [attachment(), attachment()]);
  assert.equal(totalResult.images.length, 1); assert.equal(totalResult.unreadAttachments, true);
});

test('timeout includes an unresponsive fetch or response body; caller abort remains bounded', async t => {
  const { store } = await fixture(t, { timeoutMs: 20, fetchImpl: async () => new Promise(() => {}) });
  const result = await store.prepare('timeout', [attachment()]);
  assert.equal(result.images.length, 0); assert.match(result.warnings[0], /超时/);
  const { store: slowBody } = await fixture(t, { timeoutMs: 20, fetchImpl: async () => response(new ReadableStream({ pull() {} })) });
  assert.match((await slowBody.prepare('body-timeout', [attachment()])).warnings[0], /超时/);
  const controller = new AbortController(); controller.abort();
  assert.match((await store.prepare('aborted', [attachment()], { signal: controller.signal })).warnings[0], /中止/);
});

test('unsupported attachments do not download and one failed image does not discard successes', async t => {
  let calls = 0;
  const { store } = await fixture(t, { fetchImpl: async () => (++calls === 1 ? response() : new Response(null, { status: 403 })) });
  const result = await store.prepare('mixed', [attachment({ content_type: 'file' }), attachment(), attachment()]);
  assert.equal(calls, 2); assert.equal(result.images.length, 1); assert.equal(result.unreadAttachments, true); assert.equal(result.warnings.length, 2);
});

test('resolveImages rejects cross-message descriptors, traversal, cache tampering, and hardlinks', async t => {
  const { store } = await fixture(t);
  const { images } = await store.prepare('owned', [attachment()]);
  await assert.rejects(() => store.resolveImages('other', images));
  await assert.rejects(() => store.resolveImages('owned', [{ ...images[0], relativePath: '../escape.png' }]));
  await assert.rejects(() => store.resolveImages('owned', [{ ...images[0], size: 1 }]));
  await fs.writeFile(images[0].path, Buffer.from('modified'));
  await assert.rejects(() => store.resolveImages('owned', images));
  const fresh = await store.prepare('linked', [attachment()]);
  await fs.link(fresh.images[0].path, `${fresh.images[0].path}.hardlink`);
  await assert.rejects(() => store.resolveImages('linked', fresh.images));
});

test('WebP magic and dimensions are recognized and animated WebP is refused', () => {
  const info = inspectImage(WEBP); assert.equal(info.mimeType, 'image/webp'); assert.equal(info.width, 1); assert.equal(info.height, 1);
  const animated = Buffer.alloc(30); animated.write('RIFF'); animated.writeUInt32LE(22, 4); animated.write('WEBPVP8X', 8); animated.writeUInt32LE(10, 16); animated[20] = 2;
  assert.throws(() => inspectImage(animated));
});

test('JPEG start-of-frame dimensions are bounded before any decoder receives the file', () => {
  // Minimal marker stream tests the header guard; the OCR decoder performs full JPEG decoding.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0, 0xff, 0xd9]);
  assert.equal(inspectImage(jpeg).width, 1);
  const huge = Buffer.from(jpeg); huge.writeUInt16BE(65535, 9);
  assert.throws(() => inspectImage(huge), { code: 'dimensions' });
});

const syntheticLookup = async () => [{ address: '198.18.0.185', family: 4 }];
const dohPayload = (host = 'multimedia.nt.qq.com.cn', address = '1.1.1.1') => ({
  Status: 0, TC: false, Question: [{ name: `${host}.`, type: 1 }], Answer: [{ name: `${host}.`, type: 1, data: address }],
});
const dohResponse = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });

test('fake-IP DNS uses fixed Tencent TLS resolver and pins only returned public addresses', async t => {
  let dohCalls = 0, mediaCalls = 0;
  const { store } = await fixture(t, { lookupImpl: syntheticLookup,
    dohFetchImpl: async (url, options) => {
      dohCalls++; assert.equal(url, 'https://doh.pub/dns-query?name=multimedia.nt.qq.com.cn&type=A');
      assert.equal(options.redirect, 'manual'); assert.equal(Object.keys(options.headers).some(k => /authorization|cookie/i.test(k)), false);
      return dohResponse(dohPayload());
    },
    fetchImpl: async (_url, options) => { mediaCalls++; assert.deepEqual(options.addresses, [{ address: '1.1.1.1', family: 4 }]); return response(); },
  });
  assert.equal((await store.prepare('fake-ip-proxy', [attachment()])).images.length, 1);
  assert.equal(dohCalls, 1); assert.equal(mediaCalls, 1); assert.equal(isPublicAddress('198.18.0.185'), false);
});

test('public DNS skips DoH; actual private DNS addresses cannot trigger the fallback', async () => {
  let calls = 0;
  const dohFetchImpl = async () => { calls++; return dohResponse(dohPayload()); };
  assert.deepEqual(await resolveImageAddresses('multimedia.nt.qq.com.cn', { lookupImpl: publicLookup, dohFetchImpl }), [{ address: '1.1.1.1', family: 4 }]);
  for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1']) {
    await assert.rejects(() => resolveImageAddresses('multimedia.nt.qq.com.cn', { lookupImpl: async () => [{ address, family: 4 }], dohFetchImpl }), { code: 'dns' });
  }
  assert.equal(calls, 0);
});

test('DoH rejects private answers, mismatched question, redirects, malformed response and oversized bodies', async () => {
  const cases = [
    () => dohResponse(dohPayload(undefined, '127.0.0.1')),
    () => dohResponse(dohPayload(undefined, '198.18.0.185')),
    () => dohResponse(dohPayload('evil.test')),
    () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }),
    () => new Response('broken', { headers: { 'content-type': 'application/json' } }),
    () => new Response('x'.repeat(65_537), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '100000' } }),
  ];
  for (const makeResponse of cases) {
    await assert.rejects(() => resolveImageAddresses('multimedia.nt.qq.com.cn', { lookupImpl: syntheticLookup, dohFetchImpl: async () => makeResponse() }), { code: 'dns' });
  }
});

test('DoH validates CNAME chain and ignores unrelated injected answer names', async () => {
  const payload = dohPayload();
  payload.Answer = [{ name: 'multimedia.nt.qq.com.cn.', type: 5, data: 'media.cdn.qq.com.' }, { name: 'media.cdn.qq.com.', type: 1, data: '1.1.1.1' }, { name: 'irrelevant.test.', type: 1, data: '127.0.0.1' }];
  assert.deepEqual(await resolveImageAddresses('multimedia.nt.qq.com.cn', { lookupImpl: syntheticLookup, dohFetchImpl: async () => dohResponse(payload) }), [{ address: '1.1.1.1', family: 4 }]);
  payload.Answer = [{ name: 'irrelevant.test.', type: 1, data: '1.1.1.1' }];
  await assert.rejects(() => resolveImageAddresses('multimedia.nt.qq.com.cn', { lookupImpl: syntheticLookup, dohFetchImpl: async () => dohResponse(payload) }), { code: 'dns' });
});

test('DoH obeys parent download timeout and external cancellation', async t => {
  const { store } = await fixture(t, { timeoutMs: 20, lookupImpl: syntheticLookup, dohFetchImpl: async () => new Promise(() => {}) });
  assert.match((await store.prepare('doh-timeout', [attachment()])).warnings[0], /超时/);
  const controller = new AbortController();
  const promise = resolveImageAddresses('multimedia.nt.qq.com.cn', { lookupImpl: syntheticLookup, dohFetchImpl: async () => new Promise(() => {}), signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, { code: 'aborted' });
});
