import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import { Readable } from 'node:stream';

// Tencent attachment fields and // URL normalization:
// https://github.com/tencent-connect/bot-docs/blob/main/docs/develop/api-v2/server-inter/message/send-receive/event.md
// https://github.com/tencent-connect/qqbot-agent-sdk/blob/main/src/qqbot_agent_sdk/dto.py
// Restrict downloads to QQ image CDNs; never send bot authorization to a CDN.
const EXACT_CDN_HOSTS = new Set(['multimedia.nt.qq.com', 'multimedia.nt.qq.com.cn', 'qqbot.ugcimg.cn']);
const MIME_EXT = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
const LIMITS = Object.freeze({ maxBytesPerImage: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024,
  maxImages: 4, maxPixels: 24_000_000, maxDimension: 16_000, timeoutMs: 20_000 });

class AttachmentError extends Error {
  constructor(code) { super(code); this.name = 'AttachmentError'; this.code = code; }
}
const fail = code => { throw new AttachmentError(code); };
const mime = value => typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
export function isImageAttachment(attachment) {
  return !!attachment && typeof attachment === 'object' && MIME_EXT.has(mime(attachment.content_type));
}
/** Persistable descriptor: intentionally excludes original filename and signed URL. */
export function describeAttachment(attachment) {
  return { kind: isImageAttachment(attachment) ? 'image' : 'unsupported',
    mimeType: MIME_EXT.has(mime(attachment?.content_type)) ? mime(attachment.content_type) : null,
    size: Number.isSafeInteger(attachment?.size) && attachment.size >= 0 ? attachment.size : null };
}

export function normalizeImageUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 16_384 || /[\x00-\x20\x7f\\]/.test(raw)) fail('url');
  let parsed;
  try { parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw); } catch { fail('url'); }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash ||
      (parsed.port && parsed.port !== '443') || isIP(hostname.replace(/^\[|\]$/g, '')) ||
      !(EXACT_CDN_HOSTS.has(hostname) || (hostname.endsWith('.qpic.cn') && hostname !== '.qpic.cn'))) fail('url');
  return parsed;
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    // Global unicast only; reject transition/documentation ranges too.
    return /^[23][0-9a-f]{3}:/.test(lower) && !/^2001:(?:0:|db8:|10:|20:)/.test(lower) && !lower.startsWith('2002:');
  }
  return false;
}

function validateDimensions(width, height, limits) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) fail('dimensions');
  return { width, height };
}

function pngInfo(buffer, limits) {
  if (buffer.length < 45 || buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') fail('image');
  const dims = validateDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20), limits);
  const depth = buffer[24], color = buffer[25];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[color]?.includes(depth) || buffer[26] !== 0 || buffer[27] !== 0 || buffer[28] > 1) fail('image');
  let offset = 8, data = false, end = false;
  while (offset + 12 <= buffer.length) {
    const size = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    if (size > buffer.length - offset - 12 || !/^[A-Za-z]{4}$/.test(type)) fail('image');
    if (type === 'acTL' || (type === 'IHDR' && offset !== 8)) fail('image');
    if (type === 'IDAT' && size > 0) data = true;
    offset += size + 12;
    if (type === 'IEND') { if (size !== 0 || offset !== buffer.length) fail('image'); end = true; break; }
  }
  if (!data || !end) fail('image');
  return { mimeType: 'image/png', extension: 'png', ...dims };
}

function jpegInfo(buffer, limits) {
  if (buffer.length < 16 || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) fail('image');
  let offset = 2, dims = null, sawScan = false;
  while (offset < buffer.length - 2) {
    if (buffer[offset++] !== 0xff) fail('image');
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (!marker || marker === 0xd8 || marker === 0xd9) fail('image');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) fail('image');
    const size = buffer.readUInt16BE(offset);
    if (size < 2 || offset + size > buffer.length) fail('image');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size < 8 || buffer[offset + 2] !== 8 || dims) fail('image');
      dims = validateDimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3), limits);
      if (![1, 3, 4].includes(buffer[offset + 7]) || size !== 8 + 3 * buffer[offset + 7]) fail('image');
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) fail('image');
    if (marker === 0xda) { sawScan = true; break; }
    offset += size;
  }
  if (!dims || !sawScan) fail('image');
  return { mimeType: 'image/jpeg', extension: 'jpg', ...dims };
}

function webpInfo(buffer, limits) {
  if (buffer.length < 20 || buffer.readUInt32LE(4) + 8 !== buffer.length) fail('image');
  let offset = 12, dims = null, canvas = null, payload = false;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (size > buffer.length - start) fail('image');
    if (type === 'ANIM' || type === 'ANMF') fail('image');
    if (type === 'VP8X') {
      if (size !== 10 || canvas || (buffer[start] & 2)) fail('image');
      canvas = validateDimensions(buffer.readUIntLE(start + 4, 3) + 1, buffer.readUIntLE(start + 7, 3) + 1, limits);
    } else if (type === 'VP8 ') {
      if (size < 10 || payload || (buffer[start] & 1) || !buffer.subarray(start + 3, start + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) fail('image');
      dims = validateDimensions(buffer.readUInt16LE(start + 6) & 0x3fff, buffer.readUInt16LE(start + 8) & 0x3fff, limits);
      payload = true;
    } else if (type === 'VP8L') {
      if (size < 5 || payload || buffer[start] !== 0x2f || (buffer[start + 4] & 0xe0)) fail('image');
      const bits = buffer.readUInt32LE(start + 1);
      dims = validateDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1, limits);
      payload = true;
    }
    offset = start + size + (size & 1);
  }
  if (!payload || offset !== buffer.length || (canvas && (canvas.width !== dims.width || canvas.height !== dims.height))) fail('image');
  return { mimeType: 'image/webp', extension: 'webp', ...dims };
}

export function inspectImage(buffer, limits = LIMITS) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > limits.maxBytesPerImage) fail('size');
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return pngInfo(buffer, limits);
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return jpegInfo(buffer, limits);
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return webpInfo(buffer, limits);
  fail('image');
}

export function nativeFetch(url, { signal, headers, addresses }) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, { method: 'GET', signal, headers, agent: false,
      ...(addresses ? { lookup(_hostname, options, callback) {
        // Pin the already-checked addresses so a second DNS answer cannot reach a private host.
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      } } : {}),
    }, response => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode,
        headers: responseHeaders, body: Readable.toWeb(response), redirected: false });
    });
    request.on('error', reject);
    request.end();
  });
}

function isProxySyntheticAddress(address) {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 198 && (second === 18 || second === 19);
}

function trustedDohFetch(url, options) {
  const parsed = new URL(url);
  // A fixed trusted TLS endpoint, not a caller-controlled media URL. Normal system
  // transport permits the user's proxy to reach DNSPod, with certificate checks intact.
  if (parsed.origin !== 'https://doh.pub' || parsed.pathname !== '/dns-query') fail('dns');
  return nativeFetch(url, options);
}

function parseDohAddresses(payload, hostname) {
  const canonical = name => typeof name === 'string' ? name.toLowerCase().replace(/\.$/, '') : '';
  if (!payload || payload.Status !== 0 || payload.TC === true || !Array.isArray(payload.Question) ||
      payload.Question.length !== 1 || canonical(payload.Question[0].name) !== hostname || payload.Question[0].type !== 1 ||
      !Array.isArray(payload.Answer) || payload.Answer.length > 64) fail('dns');
  const reachable = new Set([hostname]);
  for (let round = 0; round < 16; round++) {
    let added = false;
    for (const answer of payload.Answer) {
      const target = canonical(answer.data);
      if (answer.type === 5 && reachable.has(canonical(answer.name)) &&
          /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(target) && !reachable.has(target)) {
        reachable.add(target); added = true;
      }
    }
    if (!added) break;
  }
  const answers = payload.Answer.filter(answer => answer.type === 1 && reachable.has(canonical(answer.name)));
  if (!answers.length || answers.some(answer => isIP(answer.data) !== 4 || !isPublicAddress(answer.data))) fail('dns');
  return [...new Set(answers.map(answer => answer.data))].map(address => ({ address, family: 4 }));
}

/** Resolve only allowlisted QQ image hosts. Fake-IP addresses are never used for media connections. */
export async function resolveImageAddresses(hostname, { lookupImpl = lookup, dohFetchImpl = trustedDohFetch, signal } = {}) {
  const normalized = normalizeImageUrl(`https://${hostname}/`).hostname;
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal?.aborted) fail('aborted');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);
  let reader;
  try {
    const addresses = await abortable(lookupImpl(normalized, { all: true, verbatim: true }), controller.signal);
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64 ||
        addresses.some(item => !item || isIP(item.address) !== item.family)) fail('dns');
    if (addresses.every(item => isPublicAddress(item.address))) return addresses;
    // Only the well-known benchmark range used by fake-IP proxies triggers DoH.
    // Any RFC1918, loopback, link-local or other reserved answer stays an error.
    if (!addresses.some(item => isProxySyntheticAddress(item.address)) ||
        addresses.some(item => !isPublicAddress(item.address) && !isProxySyntheticAddress(item.address))) fail('dns');
    // Official service: https://cloud.tencent.com/document/product/302/110784
    const url = `https://doh.pub/dns-query?name=${encodeURIComponent(normalized)}&type=A`;
    const response = await abortable(dohFetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit',
      signal: controller.signal, headers: { Accept: 'application/dns-json', 'Accept-Encoding': 'identity' } }), controller.signal);
    if (response.redirected || response.status !== 200 || !['application/json', 'application/dns-json'].includes(mime(response.headers?.get('content-type')))) fail('dns');
    const length = response.headers?.get('content-length');
    if (length != null && (!/^\d+$/.test(length) || Number(length) > 65_536)) fail('dns');
    if (!response.body?.getReader) fail('dns');
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { value, done } = await abortable(reader.read(), controller.signal);
      if (done) break;
      size += value.length;
      if (size > 65_536) fail('dns');
      chunks.push(Buffer.from(value));
    }
    if (length != null && size !== Number(length)) fail('dns');
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('dns'); }
    return parseDohAddresses(payload, normalized);
  } catch (error) {
    if (controller.signal.aborted) fail(timedOut ? 'timeout' : 'aborted');
    if (error instanceof AttachmentError) throw error;
    fail('dns');
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    controller.abort();
    try { await reader?.cancel(); } catch {}
  }
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new AttachmentError('aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new AttachmentError('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function warning(index, code) {
  const reasons = { url: '图片链接不是受支持的 QQ 图片地址', dns: '图片地址未通过网络安全检查',
    size: '图片文件过大', dimensions: '图片尺寸过大，请裁剪后重发', image: '图片格式损坏或暂不支持',
    redirect: '图片链接发生跳转，已停止下载', timeout: '图片下载超时，可稍后重试',
    aborted: '图片下载已中止', cache: '本机图片缓存不可用', http: 'QQ 图片暂时无法下载，可重新发送',
    total: '本条消息图片总大小超过限制' };
  return `第 ${index} 张图片：${reasons[code] || '图片处理失败，可重新发送'}。`;
}

export function createAttachmentStore({ dataDir, fetchImpl = nativeFetch, lookupImpl = lookup, dohFetchImpl = trustedDohFetch, ...options } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || typeof fetchImpl !== 'function' || typeof lookupImpl !== 'function') throw new TypeError('图片存储配置无效。');
  const limits = { ...LIMITS };
  for (const key of Object.keys(limits)) {
    if (options[key] !== undefined) {
      if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > LIMITS[key]) throw new TypeError('图片限制配置无效。');
      limits[key] = options[key];
    }
  }
  const root = path.resolve(dataDir), imageRoot = path.join(root, 'images');
  function digest(messageId) {
    if (typeof messageId !== 'string' || !messageId || messageId.length > 4096) throw new TypeError('消息标识无效。');
    return createHash('sha256').update(messageId).digest('hex');
  }
  async function checkedDirectory(messageId, create = true) {
    const hash = digest(messageId), directory = path.join(imageRoot, hash);
    if (create) await fs.mkdir(root, { recursive: true });
    const realRoot = await fs.realpath(root);
    for (const dir of [imageRoot, directory]) {
      if (create) await fs.mkdir(dir).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(realRoot, await fs.realpath(dir)) !== path.relative(root, dir)) fail('cache');
    }
    return { hash, directory };
  }
  async function readCached(directory, hash, index, extension) {
    const file = path.join(directory, `${index}.${extension}`);
    let stat;
    try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > limits.maxBytesPerImage) fail('cache');
    const real = await fs.realpath(file);
    if (path.dirname(real) !== await fs.realpath(directory)) fail('cache');
    const bytes = await fs.readFile(file), info = inspectImage(bytes, limits);
    if (info.extension !== extension) fail('cache');
    return { path: file, relativePath: `images/${hash}/${index}.${extension}`, mimeType: info.mimeType, size: bytes.length };
  }
  async function download(attachment, budget, signal) {
    const url = normalizeImageUrl(attachment.url);
    if (Number.isFinite(attachment.size) && attachment.size > Math.min(limits.maxBytesPerImage, budget)) fail('size');
    if (Number.isFinite(attachment.width) && Number.isFinite(attachment.height) && attachment.width > 0 && attachment.height > 0) {
      validateDimensions(attachment.width, attachment.height, limits);
    }
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (signal?.aborted) fail('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.timeoutMs);
    let reader;
    try {
      const addresses = await resolveImageAddresses(url.hostname, { lookupImpl, dohFetchImpl, signal: controller.signal });
      const response = await abortable(fetchImpl(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit',
        signal: controller.signal, headers: { Accept: 'image/png,image/jpeg,image/webp', 'Accept-Encoding': 'identity' }, addresses }), controller.signal);
      if (response.redirected || (response.status >= 300 && response.status < 400)) fail('redirect');
      if (!response.ok) fail('http');
      const length = response.headers?.get('content-length');
      if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > Math.min(limits.maxBytesPerImage, budget))) fail('size');
      const contentType = mime(response.headers?.get('content-type'));
      if (contentType && contentType !== 'application/octet-stream' && !MIME_EXT.has(contentType)) fail('image');
      if (!response.body?.getReader) fail('image');
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const { value, done } = await abortable(reader.read(), controller.signal);
        if (done) break;
        const chunk = Buffer.from(value); size += chunk.length;
        if (size > limits.maxBytesPerImage) fail('size');
        if (size > budget) fail('total');
        chunks.push(chunk);
      }
      if (length && size !== Number(length)) fail('image');
      const bytes = Buffer.concat(chunks), info = inspectImage(bytes, limits);
      if (contentType && MIME_EXT.has(contentType) && contentType !== info.mimeType) fail('image');
      // Attachment metadata can describe the original format before a CDN conversion.
      // Validate the response MIME against actual bytes, then persist the detected format.
      return { bytes, info };
    } catch (error) {
      if (controller.signal.aborted) fail(timedOut ? 'timeout' : 'aborted');
      if (error instanceof AttachmentError) throw error;
      fail('http');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      try { await reader?.cancel(); } catch {}
      controller.abort();
    }
  }
  async function prepare(messageId, attachments, { signal } = {}) {
    digest(messageId);
    const images = [], warnings = [], list = Array.isArray(attachments) ? attachments : [];
    let unreadAttachments = false, imageCount = 0, total = 0;
    for (const attachment of list.slice(0, 100)) {
      if (!isImageAttachment(attachment)) { unreadAttachments = true; continue; }
      imageCount++;
      if (imageCount > limits.maxImages) { unreadAttachments = true; continue; }
      try {
        if (signal?.aborted) fail('aborted');
        // Validate fresh URLs even on cache hits. Reopening persisted descriptors uses resolveImages instead.
        normalizeImageUrl(attachment.url);
        const { hash, directory } = await checkedDirectory(messageId);
        let image = null;
        for (const extension of MIME_EXT.values()) {
          image = await readCached(directory, hash, imageCount, extension);
          if (image) break;
        }
        if (!image) {
          const { bytes, info } = await download(attachment, limits.maxTotalBytes - total, signal);
          const file = path.join(directory, `${imageCount}.${info.extension}`);
          const temporary = path.join(directory, `${imageCount}.${randomBytes(8).toString('hex')}.tmp`);
          try {
            await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
            await fs.rename(temporary, file);
          } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
          image = await readCached(directory, hash, imageCount, info.extension);
        }
        if (total + image.size > limits.maxTotalBytes) fail('total');
        total += image.size; images.push(image);
      } catch (error) {
        unreadAttachments = true; warnings.push(warning(imageCount, error instanceof AttachmentError ? error.code : 'cache'));
      }
    }
    if (imageCount > limits.maxImages) warnings.push(`每条消息最多识别 ${limits.maxImages} 张图片，请把剩余图片分开发送。`);
    if (list.some(item => !isImageAttachment(item)) || list.length > 100) {
      unreadAttachments = true; warnings.push('部分附件暂不支持；目前支持 PNG、JPEG 和静态 WebP 图片。');
    }
    return { images, warnings, unreadAttachments };
  }
  async function resolveImages(messageId, descriptors) {
    const expectedHash = digest(messageId);
    if (!Array.isArray(descriptors) || descriptors.length > limits.maxImages) fail('cache');
    if (!descriptors.length) return [];
    const { hash, directory } = await checkedDirectory(messageId, false);
    const images = [], seen = new Set(); let total = 0;
    for (const descriptor of descriptors) {
      const match = typeof descriptor?.relativePath === 'string' && descriptor.relativePath.match(/^images\/([a-f0-9]{64})\/([1-4])\.(png|jpg|webp)$/);
      if (!match || match[1] !== expectedHash || seen.has(match[2])) fail('cache');
      seen.add(match[2]);
      const image = await readCached(directory, hash, Number(match[2]), match[3]);
      if (!image || image.mimeType !== descriptor.mimeType || image.size !== descriptor.size) fail('cache');
      total += image.size;
      if (total > limits.maxTotalBytes) fail('total');
      images.push(image);
    }
    return images;
  }
  return { prepare, resolveImages };
}
