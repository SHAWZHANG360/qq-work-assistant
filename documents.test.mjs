import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createDocumentStore, isDocumentAttachment, describeDocument } from './documents.mjs';

const DOCUMENT_URL = 'https://multimedia.nt.qq.com.cn/download?signature=must-never-persist';
const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }];
const att = (filename = '通知.txt', extra = {}) => ({ filename, content_type: 'file', url: DOCUMENT_URL, ...extra });
const file = (name = '通知.txt', text = '林老师请在周五参加课程会议。') => ({ name, bytes: Buffer.from(text) });
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-document-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, store: createDocumentStore({ dataDir, lookupImpl: publicLookup, ...options }) };
}
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let i = 0; i < 8; i++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; }
  return (value ^ 0xffffffff) >>> 0;
}
function zip(entries, { compressed = false, encrypted = false } = {}) {
  const local = [], central = []; let offset = 0;
  for (const [filename, data] of entries) {
    const name = Buffer.from(filename), bytes = Buffer.from(data), body = compressed ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(encrypted ? 1 : 0, 6); header.writeUInt16LE(compressed ? 8 : 0, 8);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(body.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(encrypted ? 1 : 0, 8); directory.writeUInt16LE(compressed ? 8 : 0, 10);
    directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(body.length, 20); directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += header.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const rels = children => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${children}</Relationships>`;
function types(kind, main) { return `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${{ docx: 'wordprocessingml.document', xlsx: 'spreadsheetml.sheet', pptx: 'presentationml.presentation' }[kind]}.main+xml"/></Types>`; }
function officeEntries(kind) {
  if (kind === 'docx') return [
    ['[Content_Types].xml', types(kind, 'word/document.xml')],
    ['word/document.xml', `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>某部门通知：请林老师提交课程计划。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>截止时间：周五</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`]
  ];
  if (kind === 'xlsx') return [
    ['[Content_Types].xml', types(kind, 'xl/workbook.xml')],
    ['xl/workbook.xml', `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="工作安排" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', rels('<Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/>')],
    ['xl/sharedStrings.xml', `<sst xmlns="${S}"><si><t>林老师</t></si></sst>`],
    ['xl/worksheets/sheet1.xml', `<worksheet xmlns="${S}"><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>准备会议</t></is></c><c r="C1"><f>1+2</f><v>3</v></c><c r="D1"><f>HYPERLINK("https://example.invalid")</f></c></row></sheetData></worksheet>`]
  ];
  return [
    ['[Content_Types].xml', types(kind, 'ppt/presentation.xml')],
    ['ppt/presentation.xml', `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`],
    ['ppt/_rels/presentation.xml.rels', rels('<Relationship Id="rId1" Target="slides/slide1.xml"/>')],
    ['ppt/slides/slide1.xml', `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><a:p><a:r><a:t>课程会议安排</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`]
  ];
}
function pdf({ blank = false, encrypted = false } = {}) {
  const stream = blank ? '' : 'BT /F1 12 Tf 72 720 Td (Meeting on Friday at 15:30) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  if (encrypted) objects.push('<< /Filter /Standard /V 1 /R 2 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>');
  let output = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encrypted ? ' /Encrypt 6 0 R /ID [<1234><1234>]' : ''} >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(output);
}

test('supported QQ file fields are classified without persisting URL; explicit unsupported extensions stay rejected', () => {
  for (const ext of ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'csv']) assert.equal(isDocumentAttachment(att(`通知.${ext}`)), true);
  for (const filename of ['a.doc', 'a.xls', 'a.ppt', 'a.docm', 'a.zip', 'a.exe']) assert.equal(isDocumentAttachment(att(filename, { content_type: 'application/pdf' })), false);
  assert.equal(isDocumentAttachment(att('a.pdf', { content_type: 'image/png' })), false);
  assert.deepEqual(describeDocument(att('../../通知.txt', { size: 12 })), { kind: 'document', name: '通知.txt', mimeType: 'text/plain', size: 12 });
  assert.equal(JSON.stringify(describeDocument(att())).includes('signature'), false);
});

test('TXT and CSV extract real text, preserve coordinates, cache and recover opaque IDs safely', async t => {
  const { store, dataDir } = await fixture(t);
  const id = '../id!+=/'.repeat(50);
  const result = await store.prepareLocal(id, [file('../../通知.txt'), file('安排.csv', '姓名,事项\n林老师,"会议,课程"')]);
  assert.equal(result.documents.length, 2); assert.equal(result.unreadAttachments, false);
  assert.match(result.documents[0].text, /林老师/); assert.match(result.documents[1].text, /CSV 第 2 行.*\n林老师 \| 会议,课程/);
  for (const document of result.documents) assert.match(document.relativePath, /^documents\/[a-f0-9]{64}\/[1-3]\.(txt|csv)$/);
  const restarted = createDocumentStore({ dataDir, pythonExecutable: path.join(dataDir, 'missing-python.exe') });
  assert.deepEqual(await restarted.resolveDocuments(id, result.documents), result.documents);
  assert.equal((await restarted.prepareLocal(id, [file('../../通知.txt')])).documents.length, 1, 'valid cache does not relaunch parser');
  const conflicting = await restarted.prepareLocal(id, [file('../../通知.txt', 'changed')]);
  assert.equal(conflicting.documents.length, 0); assert.match(conflicting.warnings.join(), /不同文件/);
});

test('real DOCX table, XLSX stored values and PPTX slide extraction preserve source labels without evaluating formulas', async t => {
  const { store } = await fixture(t);
  const result = await store.prepareLocal('office', ['docx', 'xlsx', 'pptx'].map(ext => ({ name: `通知.${ext}`, bytes: zip(officeEntries(ext)) })));
  assert.equal(result.documents.length, 3, JSON.stringify(result.warnings));
  assert.match(result.documents[0].text, /提交课程计划.*\n截止时间：周五/);
  assert.match(result.documents[1].text, /工作表：工作安排/); assert.match(result.documents[1].text, /A1=林老师.*C1=3.*D1=\[公式无已保存结果\]/);
  assert.equal(result.documents[1].text.includes('example.invalid'), false);
  assert.match(result.documents[2].text, /第 1 张幻灯片.*\n课程会议安排/);
  assert.equal(result.unreadAttachments, true, 'missing formula result is reported incomplete');
});

test('PDF extracts text with page label; scanned/blank PDF is explicitly unread; encrypted input is rejected', async t => {
  const { store } = await fixture(t);
  const result = await store.prepareLocal('pdf', [{ name: '通知.pdf', bytes: pdf() }, { name: '扫描.pdf', bytes: pdf({ blank: true }) }, { name: '加密.pdf', bytes: pdf({ encrypted: true }) }]);
  assert.equal(result.documents.length, 2, JSON.stringify(result.warnings));
  assert.match(result.documents[0].text, /PDF 第 1 页.*\nMeeting on Friday at 15:30/);
  assert.equal(result.documents[1].text, ''); assert.equal(result.unreadAttachments, true);
  assert.match(result.warnings.join(), /扫描页/); assert.match(result.warnings.join(), /加密/);
});

test('single bad document does not prevent later valid document; signatures and legacy Office are refused', async t => {
  const { store } = await fixture(t);
  const result = await store.prepareLocal('mixed', [file('伪造.pdf', 'not a PDF'), file('旧版.doc', 'old'), file()]);
  assert.equal(result.documents.length, 1); assert.equal(result.documents[0].name, '通知.txt');
  assert.match(result.warnings.join(), /内容与扩展名不符/); assert.match(result.warnings.join(), /格式暂不支持/);
});

test('Office bombs, duplicate entries, traversal, encryption, macros and XML entities are rejected', async t => {
  const { store } = await fixture(t);
  const base = officeEntries('docx');
  const cases = [
    zip([...base, ['word/huge.xml', 'a'.repeat(2_000_000)]], { compressed: true }),
    zip([...base, base[1]]), zip([...base, ['../outside.txt', 'bad']]), zip(base, { encrypted: true }),
    zip([...base, ['word/vbaProject.bin', 'macro']]),
    zip([base[0], ['word/document.xml', '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///C:/Windows/win.ini">]><x>&x;</x>']])
  ];
  for (const [i, bytes] of cases.entries()) {
    const result = await store.prepareLocal(`reject-${i}`, [{ name: '不安全.docx', bytes }]);
    assert.equal(result.documents.length, 0, `case ${i}`); assert.equal(result.unreadAttachments, true); assert.equal(result.warnings.length, 1);
  }
});

test('external links are reported and never requested; images inside Office are explicitly unread', async t => {
  let fetches = 0;
  const { store } = await fixture(t, { fetchImpl: async () => { fetches++; throw new Error('never'); } });
  const entries = [...officeEntries('docx'), ['word/_rels/document.xml.rels', rels('<Relationship Id="x" Target="http://169.254.169.254/latest/meta-data" TargetMode="External"/>')], ['word/media/image1.png', 'not parsed']];
  const result = await store.prepareLocal('external', [{ name: '链接.docx', bytes: zip(entries) }]);
  assert.equal(result.documents.length, 1); assert.equal(fetches, 0);
  assert.match(result.warnings.join(), /未访问链接/); assert.match(result.warnings.join(), /图片和嵌入附件未识别/); assert.equal(result.unreadAttachments, true);
});

test('remote download pins public DNS, omits credentials and never stores signed URL', async t => {
  let calls = 0;
  const { store, dataDir } = await fixture(t, { fetchImpl: async (url, options) => {
    calls++; assert.equal(url, DOCUMENT_URL); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(options.addresses, [{ address: '1.1.1.1', family: 4 }]);
    assert.equal(Object.keys(options.headers).some(key => /authorization|cookie/i.test(key)), false);
    return new Response(Buffer.from('通知内容'), { headers: { 'content-type': 'application/octet-stream' } });
  } });
  const result = await store.prepare('remote', [att()]); assert.equal(result.documents.length, 1, JSON.stringify(result.warnings));
  const cached = await store.prepare('remote', [att()]); assert.equal(cached.documents.length, 1); assert.equal(calls, 1);
  const metadata = await fs.readFile(path.join(dataDir, result.documents[0].relativePath + '.json'), 'utf8');
  assert.equal(metadata.includes('signature'), false); assert.equal(JSON.stringify(result).includes(DOCUMENT_URL), false);
});

test('unknown host/private DNS/redirect/oversized response are rejected before unsafe processing', async t => {
  let calls = 0;
  const privateFixture = await fixture(t, { lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }], fetchImpl: async () => { calls++; return new Response('bad'); } });
  const result = await privateFixture.store.prepare('blocked', [att('a.txt'), att('b.txt', { url: 'https://evil.test/a' })]);
  assert.equal(calls, 0); assert.equal(result.documents.length, 0);
  const redirectFixture = await fixture(t, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://localhost/' } }) });
  assert.match((await redirectFixture.store.prepare('redirect', [att()])).warnings.join(), /跳转/);
  const sizeFixture = await fixture(t, { maxBytesPerDocument: 10, fetchImpl: async () => new Response('more than ten bytes') });
  assert.match((await sizeFixture.store.prepare('size', [att()])).warnings.join(), /大小限制/);
});

test('count/byte/aggregate character limits are enforced and output truncation is visible', async t => {
  const limited = await fixture(t, { maxTextChars: 30, maxTotalBytes: 100 });
  const result = await limited.store.prepareLocal('limit', [file('a.txt', 'A'.repeat(60)), file('b.txt'), file('c.txt'), file('d.txt')]);
  assert.equal(result.documents.length, 1); assert.equal(result.documents[0].text.length, 30); assert.equal(result.documents[0].truncated, true);
  assert.equal(result.unreadAttachments, true); assert.match(result.warnings.join(), /最多读取 3/);
  const bytes = await fixture(t, { maxTotalBytes: 20, maxBytesPerDocument: 15 });
  const bytesResult = await bytes.store.prepareLocal('bytes', [file('a.txt', 'A'.repeat(12)), file('b.txt', 'B'.repeat(12))]);
  assert.equal(bytesResult.documents.length, 1); assert.match(bytesResult.warnings.join(), /大小限制/);
  const failedBytes = await bytes.store.prepareLocal('failed-bytes', [file('invalid.pdf', 'A'.repeat(12)), file('valid.txt', 'B'.repeat(12))]);
  assert.equal(failedBytes.documents.length, 0, 'failed signatures still consume the aggregate byte budget');
  assert.match(failedBytes.warnings.join(), /大小限制/);
});

test('timeouts and cancellation terminate isolated parser/download and return actionable warnings', async t => {
  const parser = await fixture(t, { parseTimeoutMs: 1 });
  assert.match((await parser.store.prepareLocal('timeout', [file()])).warnings.join(), /解析超时/);
  const download = await fixture(t, { timeoutMs: 20, fetchImpl: async () => new Promise(() => {}) });
  assert.match((await download.store.prepare('timeout', [att()])).warnings.join(), /下载超时/);
  const abort = new AbortController(); abort.abort();
  assert.match((await parser.store.prepareLocal('cancel', [file()], { signal: abort.signal })).warnings.join(), /已取消/);
});

test('cache recovery refuses wrong message/path, modified original/text and hardlinks', async t => {
  const { store, dataDir } = await fixture(t);
  const result = await store.prepareLocal('original', [file()]); const descriptor = result.documents[0];
  await assert.rejects(store.resolveDocuments('another', [descriptor]));
  await assert.rejects(store.resolveDocuments('original', [{ ...descriptor, relativePath: '../secrets.json' }]));
  await assert.rejects(store.resolveDocuments('original', [descriptor, descriptor]));
  const target = path.join(dataDir, descriptor.relativePath);
  await fs.writeFile(target, 'tampered'); await assert.rejects(store.resolveDocuments('original', [descriptor]));
  const next = await store.prepareLocal('metadata', [file()]); const metaPath = path.join(dataDir, next.documents[0].relativePath + '.json');
  const metadata = JSON.parse(await fs.readFile(metaPath)); metadata.text = 'forged'; await fs.writeFile(metaPath, JSON.stringify(metadata));
  await assert.rejects(store.resolveDocuments('metadata', next.documents));
  const third = await store.prepareLocal('hardlink', [file()]); const original = path.join(dataDir, third.documents[0].relativePath);
  await fs.link(original, path.join(dataDir, 'extra-link.txt')); await assert.rejects(store.resolveDocuments('hardlink', third.documents));
});

test('UTF16 and Chinese legacy encoding text are decoded; binary disguised as text is rejected', async t => {
  const { store } = await fixture(t);
  const result = await store.prepareLocal('encoding', [{ name: 'unicode.txt', bytes: Buffer.concat([Buffer.from([255, 254]), Buffer.from('会议通知', 'utf16le')]) },
    { name: 'gb.txt', bytes: Buffer.from([0xcd, 0xa8, 0xd6, 0xaa, 0xbb, 0xe1, 0xd2, 0xe9]) }, { name: 'binary.txt', bytes: Buffer.from([0, 1, 2, 3]) }]);
  assert.equal(result.documents.length, 2); assert.match(result.documents[0].text, /会议通知/); assert.match(result.documents[1].text, /通知/);
  assert.match(result.warnings.join(), /GB18030/); assert.equal(result.unreadAttachments, true);
});
