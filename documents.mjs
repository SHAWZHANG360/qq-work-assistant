import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { normalizeImageUrl, resolveImageAddresses, nativeFetch } from './attachments.mjs';

// Inbound Tencent fields: filename, content_type, size, url. No remote URL is
// persisted. Unknown CDN hosts deliberately require the local upload fallback.
// https://github.com/tencent-connect/qqbot-agent-sdk/blob/main/src/qqbot_agent_sdk/dto.py
const TYPES = Object.freeze({ pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv' });
const GENERIC_MIMES = new Set(['', 'file', 'application/octet-stream', 'application/zip', 'application/x-zip-compressed']);
const MIME_EXT = new Map(Object.entries(TYPES).map(([ext, type]) => [type, ext]));
const HARD_LIMITS = Object.freeze({ maxDocuments: 3, maxBytesPerDocument: 10 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024,
  maxTextChars: 45_000, timeoutMs: 20_000, parseTimeoutMs: 20_000 });
const PARSER = fileURLToPath(new URL('./document-extract.py', import.meta.url));
const VERSION = 1;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mime = value => typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
class DocumentError extends Error { constructor(code) { super(code); this.name = 'DocumentError'; this.code = code; } }
const fail = code => { throw new DocumentError(code); };
const safeName = value => {
  const base = typeof value === 'string' ? value.split(/[\\/]/).at(-1) : '';
  return (base.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 180) || '未命名附件');
};
function info(attachment) {
  const original = typeof attachment?.filename === 'string' ? attachment.filename : '';
  const ext = path.extname(original).slice(1).toLowerCase();
  const contentType = mime(attachment?.content_type);
  // A MIME type cannot rescue an explicitly unsupported or renamed extension.
  const kind = ext ? (Object.hasOwn(TYPES, ext) ? ext : null) : MIME_EXT.get(contentType);
  if (!kind || (!GENERIC_MIMES.has(contentType) && contentType !== TYPES[kind] && !(kind === 'csv' && contentType === 'application/csv'))) return null;
  return { extension: kind, mimeType: TYPES[kind], name: safeName(original || `附件.${kind}`) };
}
export function isDocumentAttachment(attachment) { return !!info(attachment); }
export function describeDocument(attachment) {
  const type = info(attachment);
  return { kind: type ? 'document' : 'unsupported', name: safeName(attachment?.filename), mimeType: type?.mimeType || null,
    size: Number.isSafeInteger(attachment?.size) && attachment.size >= 0 ? attachment.size : null };
}
function messageHash(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 4096 || /[\x00-\x1f\x7f]/.test(id)) fail('id');
  return hash(id);
}
function checkSignature(bytes, ext) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) fail('size');
  if (ext === 'pdf' && bytes.subarray(0, 5).toString() !== '%PDF-') fail('signature');
  if (['docx', 'xlsx', 'pptx'].includes(ext) && !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) fail('signature');
  if (['txt', 'csv'].includes(ext) && (bytes.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) || /^(?:PK\x03\x04|%PDF-|MZ|\x7fELF)/.test(bytes.subarray(0, 5).toString('latin1')))) fail('signature');
}
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DocumentError('aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DocumentError('aborted')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
function warning(code) {
  const messages = {
    format: '格式暂不支持；请使用 PDF、DOCX、XLSX、PPTX、TXT 或 CSV，旧版及含宏 Office 文件需另存为受支持格式。',
    size: '文件为空或超过大小限制（单个 10 MiB、每条合计 20 MiB）。', count: '每条最多读取 3 个文档，其余文件未读取。',
    url: '文件下载来源未获允许，请改用本机上传。', dns: '文件下载地址未通过安全检查，请改用本机上传。',
    http: '文件下载失败，请重新发送或改用本机上传。', redirect: '文件下载发生跳转，未继续访问；请改用本机上传。',
    signature: '文件内容与扩展名不符，或并非可读取文档。', mime: '下载文件类型与声明不符，请改用本机上传。',
    timeout: '文件下载超时，请稍后重试或改用本机上传。', aborted: '文件处理已取消。',
    parse_timeout: '文件解析超时，未继续读取；请拆分文件或另存为纯文本。', parser: '本机 Python 解析器不可用，请检查文档解析依赖。',
    parse: '文件损坏或解析失败，请另存为受支持格式后重试。', encrypted: '文件已加密，暂不支持读取；请先自行解密后上传。',
    macro: '含宏文档不予读取，请另存为不含宏的受支持格式。', archive: 'Office 压缩结构无效或不安全，未读取。',
    archive_limit: 'Office 解压规模或压缩比例超过安全上限，未读取。', xml: 'Office XML 结构不符合安全限制，未读取。',
    encoding: '文本编码无法识别，请另存为 UTF-8 后重试。', memory: '文件解析超过内存上限，未继续读取。',
    isolation: '本机无法启用解析资源限制，文件未读取。', cache: '本机文档缓存未通过校验，请重新上传。',
    conflict: '该消息已保存了不同文件，请作为新消息重新上传。', text_limit: '本条已达到 45000 字符提取上限，后续文档未读取。'
  };
  return messages[code] || messages.parse;
}
function validateExtract(value, cap) {
  if (!value || value.ok !== true || typeof value.text !== 'string' || value.text.length > cap ||
      !Array.isArray(value.warnings) || value.warnings.length > 20 || value.warnings.some(x => typeof x !== 'string' || x.length > 500) ||
      typeof value.truncated !== 'boolean' || typeof value.incomplete !== 'boolean') fail('parse');
  return { text: value.text, warnings: value.warnings, truncated: value.truncated, incomplete: value.incomplete };
}
async function pythonExecutable(explicit) {
  const candidate = explicit || process.env.QQ_ASSISTANT_PYTHON || path.join(path.dirname(PARSER), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!path.isAbsolute(candidate) || /[\\/]WindowsApps[\\/]/i.test(candidate)) fail('parser');
  try { if (!(await fs.stat(candidate)).isFile()) fail('parser'); } catch { fail('parser'); }
  return candidate;
}
async function extract(bytes, ext, { signal, cap, timeoutMs, executable }) {
  const python = await pythonExecutable(executable);
  if (signal?.aborted) fail('aborted');
  return new Promise((resolve, reject) => {
    // Do not inherit bot credentials, Codex tokens, proxy variables, PYTHONPATH,
    // user startup hooks, or arbitrary PATH executables into the parser.
    const env = { PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' };
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    let child;
    try { child = spawn(python, ['-I', '-B', PARSER, ext, String(cap)], { shell: false, windowsHide: true, cwd: path.dirname(PARSER), env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { reject(new DocumentError('parser')); return; }
    let settled = false, output = [], size = 0, errorSize = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const abort = () => finish(new DocumentError('aborted'));
    const timer = setTimeout(() => finish(new DocumentError('parse_timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new DocumentError('parser')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 512 * 1024) finish(new DocumentError('parse')); else output.push(chunk); });
    child.stderr.on('data', chunk => { errorSize += chunk.length; if (errorSize > 64 * 1024) finish(new DocumentError('parse')); });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) { finish(new DocumentError('parse')); return; }
      try {
        const parsed = JSON.parse(Buffer.concat(output).toString('utf8'));
        if (!parsed.ok) fail(typeof parsed.code === 'string' ? parsed.code : 'parse');
        finish(null, validateExtract(parsed, cap));
      } catch (error) { finish(error instanceof DocumentError ? error : new DocumentError('parse')); }
    });
    child.stdin.end(bytes);
    if (signal?.aborted) abort();
  });
}

export function createDocumentStore({ dataDir, fetchImpl = nativeFetch, lookupImpl = lookup, dohFetchImpl,
  pythonExecutable: executable, ...options } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be absolute');
  const limits = {};
  for (const [key, value] of Object.entries(HARD_LIMITS)) limits[key] = options[key] === undefined ? value : Math.min(value, Math.max(1, Math.floor(options[key])));
  if (Object.values(limits).some(value => !Number.isSafeInteger(value))) throw new TypeError('Invalid document limit');
  const root = path.resolve(dataDir), documentsRoot = path.join(root, 'documents');
  const inFlight = new Map();
  async function directory(idHash) {
    await fs.mkdir(root, { recursive: true });
    const realRoot = await fs.realpath(root);
    for (const dir of [documentsRoot, path.join(documentsRoot, idHash)]) {
      try { await fs.mkdir(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(dir)) !== path.join(realRoot, path.relative(root, dir))) fail('cache');
    }
    return path.join(documentsRoot, idHash);
  }
  async function safeRead(file, max) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > max) fail('cache');
    const real = await fs.realpath(file);
    if (real !== path.join(await fs.realpath(path.dirname(file)), path.basename(file))) fail('cache');
    const bytes = await fs.readFile(file);
    if (bytes.length !== stat.size || bytes.length > max) fail('cache');
    return bytes;
  }
  async function cached(dir, index, type, expectedHash) {
    const file = path.join(dir, `${index}.${type.extension}`), metadataFile = `${file}.json`;
    let raw;
    try { raw = await safeRead(metadataFile, 600_000); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let metadata;
    try { metadata = JSON.parse(raw.toString('utf8')); } catch { fail('cache'); }
    if (metadata.version !== VERSION || metadata.name !== type.name || metadata.mimeType !== type.mimeType ||
        !/^[0-9a-f]{64}$/.test(metadata.sha256 || '') || typeof metadata.textHash !== 'string') fail('cache');
    const bytes = await safeRead(file, limits.maxBytesPerDocument);
    checkSignature(bytes, type.extension);
    if (metadata.size !== bytes.length || hash(bytes) !== metadata.sha256 || hash(metadata.text || '') !== metadata.textHash) fail('cache');
    if (expectedHash && metadata.sha256 !== expectedHash) fail('conflict');
    const parsed = validateExtract({ ok: true, ...metadata }, HARD_LIMITS.maxTextChars);
    return { name: metadata.name, mimeType: metadata.mimeType, size: metadata.size, sha256: metadata.sha256, ...parsed };
  }
  async function atomicWrite(file, bytes) {
    try { const previous = await fs.lstat(file); if (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1) fail('cache'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try { await fs.writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await fs.rename(temp, file); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
  async function download(attachment, type, signal, remaining) {
    let url;
    try { url = normalizeImageUrl(attachment.url); } catch { fail('url'); }
    if (attachment.size !== undefined && (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > Math.min(limits.maxBytesPerDocument, remaining))) fail('size');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false, reader;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, limits.timeoutMs);
    if (signal?.aborted) controller.abort();
    try {
      const addresses = await resolveImageAddresses(url.hostname, { lookupImpl, ...(dohFetchImpl ? { dohFetchImpl } : {}), signal: controller.signal });
      const response = await abortable(fetchImpl(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        headers: { Accept: `${type.mimeType},application/octet-stream`, 'Accept-Encoding': 'identity' }, addresses }), controller.signal);
      if (response.redirected || (response.status >= 300 && response.status < 400)) fail('redirect');
      if (!response.ok) fail('http');
      const headerType = mime(response.headers?.get('content-type'));
      if (!GENERIC_MIMES.has(headerType) && headerType !== type.mimeType && !(type.extension === 'csv' && headerType === 'application/csv')) fail('mime');
      const headerLength = response.headers?.get('content-length');
      if (headerLength !== null && headerLength !== undefined && (!/^\d+$/.test(headerLength) || Number(headerLength) > Math.min(limits.maxBytesPerDocument, remaining))) fail('size');
      if (!response.body?.getReader) fail('http');
      reader = response.body.getReader();
      let total = 0; const chunks = [];
      while (true) {
        const { done, value } = await abortable(reader.read(), controller.signal);
        if (done) break;
        total += value.byteLength;
        if (total > Math.min(limits.maxBytesPerDocument, remaining)) fail('size');
        chunks.push(Buffer.from(value));
      }
      if (headerLength !== null && headerLength !== undefined && Number(headerLength) !== total) fail('http');
      return Buffer.concat(chunks);
    } catch (error) {
      if (controller.signal.aborted) fail(signal?.aborted ? 'aborted' : timedOut ? 'timeout' : 'http');
      if (error instanceof DocumentError) throw error;
      if (['dns', 'url'].includes(error?.code)) fail(error.code);
      fail('http');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); reader?.cancel().catch(() => {}); }
  }
  async function prepareInternal(messageId, items, { signal } = {}, local = false) {
    const idHash = messageHash(messageId), dir = await directory(idHash);
    if (!Array.isArray(items)) throw new TypeError('attachments must be an array');
    const result = { documents: [], warnings: [], unreadAttachments: false };
    let totalBytes = 0, totalChars = 0;
    if (items.length > limits.maxDocuments) { result.warnings.push(warning('count')); result.unreadAttachments = true; }
    for (const [offset, item] of items.slice(0, limits.maxDocuments).entries()) {
      const index = offset + 1;
      const attachment = local ? { filename: item?.name, content_type: 'file' } : item;
      const name = safeName(attachment?.filename);
      try {
        if (signal?.aborted) fail('aborted');
        if (totalChars >= limits.maxTextChars) fail('text_limit');
        const type = info(attachment); if (!type) fail('format');
        let bytes;
        if (local) {
          if (!(item?.bytes instanceof Uint8Array)) fail('format');
          if (!item.bytes.length || item.bytes.length > Math.min(limits.maxBytesPerDocument, limits.maxTotalBytes - totalBytes)) fail('size');
          bytes = Buffer.from(item.bytes);
        }
        let parsed = await cached(dir, index, type, bytes && hash(bytes));
        if (!parsed) {
          if (!bytes) bytes = await download(attachment, type, signal, limits.maxTotalBytes - totalBytes);
          if (!bytes.length || bytes.length > Math.min(limits.maxBytesPerDocument, limits.maxTotalBytes - totalBytes)) fail('size');
          // Downloaded/read bytes consume the message budget even if parsing
          // later fails; a bad first file must not grant extra download quota.
          totalBytes += bytes.length;
          checkSignature(bytes, type.extension);
          const extracted = await extract(bytes, type.extension, { signal, cap: limits.maxTextChars - totalChars, timeoutMs: limits.parseTimeoutMs, executable });
          parsed = { name: type.name, mimeType: type.mimeType, size: bytes.length, sha256: hash(bytes), ...extracted };
          if (signal?.aborted) fail('aborted');
          const file = path.join(dir, `${index}.${type.extension}`);
          await atomicWrite(file, bytes);
          await atomicWrite(`${file}.json`, JSON.stringify({ version: VERSION, ...parsed, textHash: hash(parsed.text) }));
        } else {
          if (parsed.size > limits.maxTotalBytes - totalBytes) fail('size');
          totalBytes += parsed.size;
        }
        const remaining = limits.maxTextChars - totalChars;
        if (parsed.text.length > remaining) parsed = { ...parsed, text: parsed.text.slice(0, remaining), truncated: true, incomplete: true,
          warnings: [...new Set([...parsed.warnings, warning('text_limit')])] };
        const descriptor = { relativePath: `documents/${idHash}/${index}.${type.extension}`, name: parsed.name, mimeType: parsed.mimeType,
          size: parsed.size, sha256: parsed.sha256, text: parsed.text, sourceLabel: `附件：${parsed.name}`, truncated: parsed.truncated, warnings: parsed.warnings };
        result.documents.push(descriptor); totalChars += parsed.text.length;
        if (parsed.incomplete || parsed.truncated || !parsed.text.trim()) result.unreadAttachments = true;
        result.warnings.push(...parsed.warnings.map(value => `${parsed.name}：${value}`));
      } catch (error) { result.warnings.push(`${name}：${warning(error.code)}`); result.unreadAttachments = true; if (signal?.aborted) break; }
    }
    return result;
  }
  async function serialized(id, operation) {
    const key = messageHash(id), previous = inFlight.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation); inFlight.set(key, current);
    try { return await current; } finally { if (inFlight.get(key) === current) inFlight.delete(key); }
  }
  return {
    prepare: (id, attachments, opts) => serialized(id, () => prepareInternal(id, attachments, opts, false)),
    prepareLocal: (id, files, opts) => serialized(id, () => prepareInternal(id, files, opts, true)),
    async resolveDocuments(messageId, descriptors) {
      const idHash = messageHash(messageId), dir = await directory(idHash);
      if (!Array.isArray(descriptors) || descriptors.length > limits.maxDocuments) fail('cache');
      const seen = new Set(), documents = []; let totalBytes = 0, totalChars = 0;
      for (const descriptor of descriptors) {
        const match = new RegExp(`^documents/${idHash}/([1-3])\\.(pdf|docx|xlsx|pptx|txt|csv)$`).exec(descriptor?.relativePath);
        if (!match || seen.has(descriptor.relativePath)) fail('cache');
        seen.add(descriptor.relativePath);
        const type = { extension: match[2], mimeType: TYPES[match[2]], name: safeName(descriptor.name) };
        if (descriptor.name !== type.name || descriptor.mimeType !== type.mimeType) fail('cache');
        const parsed = await cached(dir, Number(match[1]), type, descriptor.sha256);
        if (!parsed || parsed.size !== descriptor.size) fail('cache');
        totalBytes += parsed.size;
        if (totalBytes > limits.maxTotalBytes || totalChars >= limits.maxTextChars) fail('cache');
        const text = parsed.text.slice(0, limits.maxTextChars - totalChars);
        totalChars += text.length;
        documents.push({ relativePath: descriptor.relativePath, name: parsed.name, mimeType: parsed.mimeType, size: parsed.size, sha256: parsed.sha256,
          text, sourceLabel: `附件：${parsed.name}`, truncated: parsed.truncated || text.length !== parsed.text.length,
          warnings: text.length !== parsed.text.length ? [...new Set([...parsed.warnings, warning('text_limit')])] : parsed.warnings });
      }
      return documents;
    }
  };
}
