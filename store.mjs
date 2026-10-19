import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const TIME_ZONE = 'Asia/Taipei';
const SENDER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;
const MAX_MESSAGE_ID_LENGTH = 4096;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT_LENGTH = 100_000;
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const ignored = () => ({ reply: null, saved: false, paired: false });

function isValidSenderId(value) {
  return typeof value === 'string' && SENDER_ID_PATTERN.test(value) && value !== '.' && value !== '..';
}

function isValidMessageId(value) {
  // QQ message IDs are opaque values, not filenames or user identities. Preserve
  // punctuation and whitespace exactly; paths are derived only from validated dates.
  return typeof value === 'string' && value.length <= MAX_MESSAGE_ID_LENGTH &&
    value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function dayOf(value) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(value).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validDay(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function utcTimestamp(value) {
  if (typeof value === 'string') {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match || !validDay(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  } else if (!(value instanceof Date) && !(typeof value === 'number' && Number.isFinite(value))) {
    return null;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getUTCFullYear() < 1000 || parsed.getUTCFullYear() > 9998) return null;
  return parsed.toISOString();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`无法读取本机状态文件 ${path.basename(file)}；为避免错误绑定，已停止处理。`, { cause: error });
  }
}

// Publish a complete file without replacing another process's existing state.
function createJsonAtomically(file, value) {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(temp, file);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function asCodeBlock(text) {
  const runs = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}

/** Synchronous local store. The caller must supply only C2C events and run one instance. */
export function createStore(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new TypeError('dataDir 必须是非空目录路径。');
  const root = path.resolve(dataDir);
  const ownerFile = path.join(root, 'owner.json');
  const boundMarker = path.join(root, 'binding-completed.json');
  const pairingFile = path.join(root, 'pairing.json');
  const messagesDir = path.join(root, 'messages');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(messagesDir, { recursive: true, mode: 0o700 });

  function getOwner() {
    const owner = readJson(ownerFile);
    if (owner === null) {
      // A literal JSON null is corruption, not a missing owner file.
      if (fs.existsSync(ownerFile)) throw new Error('owner.json 已损坏；请人工检查，不能重新绑定。');
      if (fs.existsSync(boundMarker)) throw new Error('已绑定的身份文件丢失，请从私有备份恢复，禁止自动重新绑定。');
      return null;
    }
    if (!owner || typeof owner !== 'object' || !isValidSenderId(owner.openid)) {
      throw new Error('owner.json 已损坏；请人工检查，不能重新绑定。');
    }
    if (!fs.existsSync(boundMarker)) createJsonAtomically(boundMarker, { completed: true });
    return owner.openid;
  }

  function ensurePairingCode() {
    if (getOwner()) return null;
    let pairing = readJson(pairingFile);
    if (pairing === null && !fs.existsSync(pairingFile)) {
      createJsonAtomically(pairingFile, { code: randomBytes(12).toString('base64url'), createdAt: new Date().toISOString() });
      pairing = readJson(pairingFile);
    }
    if (!pairing || typeof pairing.code !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(pairing.code)) {
      throw new Error('pairing.json 已损坏；请人工检查配对文件。');
    }
    const age = Date.now() - Date.parse(pairing.createdAt);
    if (!Number.isFinite(age)) throw new Error('配对时间无效，请检查配对文件。');
    if (age > 15 * 60 * 1000 || age < -60_000) {
      pairing = { code: randomBytes(12).toString('base64url'), createdAt: new Date().toISOString() };
      const temporary = `${pairingFile}.${randomBytes(8).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(pairing), { flag:'wx', mode:0o600 });
      fs.renameSync(temporary, pairingFile);
    }
    return pairing.code;
  }

  function readDaily(date) {
    if (!validDay(date)) throw new TypeError('日期必须是有效的 YYYY-MM-DD。');
    const file = path.join(messagesDir, `${date}.jsonl`);
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return content.split('\n').filter(line => line.trim()).map(line => {
      const record = JSON.parse(line);
      if (!record || !isValidMessageId(record.id) || !isValidSenderId(record.senderId) || typeof record.text !== 'string' ||
          !utcTimestamp(record.timestamp) || !utcTimestamp(record.receivedAt) || typeof record.hasAttachments !== 'boolean' ||
          (record.hasImages !== undefined && typeof record.hasImages !== 'boolean') ||
          (record.hasDocuments !== undefined && typeof record.hasDocuments !== 'boolean') ||
          (record.hasUnknownAttachments !== undefined && typeof record.hasUnknownAttachments !== 'boolean') ||
          (record.uploadFingerprint !== undefined && (typeof record.uploadFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.uploadFingerprint))) ||
          dayOf(new Date(record.timestamp)) !== date) {
        throw new Error(`消息文件 ${date}.jsonl 已损坏；请人工检查。`);
      }
      return record;
    });
  }

  // The messages themselves are the durable deduplication index. No separate index
  // can be committed out of step with the original message.
  const seenIds = new Set();
  getOwner(); // Fail closed immediately if a persisted owner is corrupt.
  for (const entry of fs.readdirSync(messagesDir, { withFileTypes: true })) {
    if (entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) {
      for (const record of readDaily(entry.name.slice(0, -6))) seenIds.add(record.id);
    }
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return ignored();
    const { id, senderId, timestamp, attachments } = message;
    if (!isValidMessageId(id) || !isValidSenderId(senderId)) return ignored();
    const owner = getOwner();
    if (owner && owner !== senderId) return ignored();
    const text = message.text ?? '';
    if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) return ignored();
    const utc = utcTimestamp(timestamp);
    if (!utc) return ignored();
    const trimmed = text.trim();

    if (!owner) {
      const code = ensurePairingCode();
      if (trimmed !== `绑定 ${code}`) return ignored();
      const created = createJsonAtomically(ownerFile, { openid: senderId, pairedAt: new Date().toISOString() });
      if (!created) return ignored();
      createJsonAtomically(boundMarker, { completed: true });
      try { fs.unlinkSync(pairingFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      return { reply: '绑定成功。现在可以把重要工作内容复制成文字发给我。', saved: false, paired: true };
    }

    // Pairing messages never enter logs, including a retried pairing webhook.
    if (/^绑定(?:\s|$)/.test(trimmed)) return { reply: '已绑定当前账号。', saved: false, paired: false };
    if (trimmed === '/help') return {
      reply: '把重要工作内容复制成文字发来即可记录。/today 查看今天的记录数量。当前测试版不会展开附件或转发卡片，日志为原文记录。',
      saved: false, paired: false,
    };
    if (trimmed === '/today') {
      const today = dayOf(new Date());
      return { reply: `今天（${today}，Asia/Taipei）已记录 ${readDaily(today).length} 条消息。`, saved: false, paired: false };
    }
    if (seenIds.has(id)) return ignored();
    const hasAttachments = Array.isArray(attachments) ? attachments.length > 0 : Boolean(attachments);
    if (!trimmed && !hasAttachments) return ignored();
    const record = {
      id, senderId, text: trimmed || message.hasImages === true || message.hasDocuments === true ? text : '[附件：未展开的附件或转发卡片，请补充文字。]',
      timestamp: utc, receivedAt: new Date().toISOString(), hasAttachments,
      ...(message.hasImages === true ? { hasImages: true } : {}),
      ...(message.hasDocuments === true ? { hasDocuments: true } : {}),
      ...(message.hasUnknownAttachments === true ? { hasUnknownAttachments: true } : {}),
      ...(typeof message.uploadFingerprint === 'string' && /^[a-f0-9]{64}$/.test(message.uploadFingerprint) ? { uploadFingerprint: message.uploadFingerprint } : {}),
    };
    const file = path.join(messagesDir, `${dayOf(new Date(utc))}.jsonl`);
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    seenIds.add(id);
    const reply = !trimmed
      ? '收到附件，但当前测试版只整理文字，请把重要内容复制成文字发来。'
      : hasAttachments
        ? '已保存可读文字。附件或转发卡片尚未展开，请把关键内容复制成文字。'
        : '已记录。';
    return { reply, saved: true, paired: false };
  }

  function renderDaily(date) {
    const records = readDaily(date).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.receivedAt.localeCompare(b.receivedAt));
    const sections = records.map(record => `## ${timeFormatter.format(new Date(record.timestamp))}\n\n${asCodeBlock(record.text)}${record.hasAttachments ? '\n\n附件或转发卡片未展开，未保存附件内容。' : ''}`);
    return `# 工作消息原文 · ${date}\n\n时区：${TIME_ZONE}（UTC+8）\n\n共 ${records.length} 条记录。本页为原文时间线，尚未进行 AI 总结。\n\n${sections.length ? sections.join('\n\n') : '当天暂无记录。'}\n`;
  }

  return { getOwner, ensurePairingCode, handleMessage, renderDaily, readDaily };
}
