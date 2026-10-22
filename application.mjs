import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createStore } from './store.mjs';
import { createAttachmentStore, isImageAttachment } from './attachments.mjs';
import { createDeepSeekSettings as createModelSettings } from './deepseek-settings.mjs';
import { createUsageStore, formatUsage } from './usage-store.mjs';
import { createDocumentStore, isDocumentAttachment } from './documents.mjs';
import { formatActionBrief } from './action-brief.mjs';
import { createReminders } from './reminders.mjs';

export function localDay(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
const digestId = id => createHash('sha256').update(id).digest('hex');
function literalBlock(text) {
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map(run => run.length + 1)));
  return `${fence}text\n${text}\n${fence}`;
}
function writeJson(file, value) {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

export function createApplication({ appId: configuredAppId, dataDir, preferences, Client, analyze, recognizeImages, formatAnalysis, secrets, attachmentStore = createAttachmentStore({ dataDir }), documentStore = createDocumentStore({ dataDir }), modelSettings = createModelSettings({ dataDir }) }) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const jobsDir = path.join(dataDir, 'jobs');
  const reportsDir = path.join(dataDir, 'reports');
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(reportsDir, { recursive: true, mode: 0o700 });
  const store = createStore(dataDir);
  const usage = createUsageStore({ dataDir });
  const reminders = createReminders({ dataDir });
  store.ensurePairingCode();
  const jobs = [];
  // Signed attachment links exist only in memory, never in raw logs or job files.
  const attachmentSources = new Map();
  for (const file of fs.readdirSync(jobsDir).filter(x => /^[a-f0-9]{64}\.json$/.test(x))) {
    const job = JSON.parse(fs.readFileSync(path.join(jobsDir, file), 'utf8'));
    if (!job || !job.message?.id || digestId(job.message.id) + '.json' !== file || !['pending', 'processing', 'complete', 'failed'].includes(job.state)) throw new Error('分析队列文件损坏，请先检查服务器数据。');
    if (job.state === 'processing') job.state = 'pending';
    jobs.push(job);
  }
  // Recover the narrow crash window between durable receipt and queue creation.
  const queuedIds = new Set(jobs.map(j => j.message.id));
  for (const file of fs.readdirSync(path.join(dataDir, 'messages')).filter(x => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x))) {
    for (const record of store.readDaily(file.slice(0, -6))) {
      if (record.senderId !== store.getOwner() || queuedIds.has(record.id) || record.text.startsWith('[附件：')) continue;
      const job = { message: { id: record.id, senderId: record.senderId, text: record.text, timestamp: record.timestamp }, receivedAt: record.receivedAt, day: localDay(new Date(record.receivedAt)), hasAttachments: record.hasAttachments, hasImages: record.hasImages === true, hasDocuments: record.hasDocuments === true, hasUnknownAttachments: record.hasUnknownAttachments === true, source: record.id.startsWith('local-upload:') ? 'local' : 'qq', state: 'pending' };
      writeJson(path.join(jobsDir, `${digestId(record.id)}.json`), job); jobs.push(job); queuedIds.add(record.id);
    }
  }
  const abortController = new AbortController();
  let client = null, generation = 0, busy = false, testBusy = false, uploadBusy = false, paused = false, stopping = false;
  let analysisReady = jobs.some(job => job.state === 'complete'), lastError = '', lastReceivedAt = null;
  let usageWarning = '';
  let reminderWarning = '';
  let network = { state: 'stopped', message: '等待填写 QQ AppSecret。' };
  const diagnosticFile = path.join(dataDir, 'receive-diagnostics.json');
  const diagnostics = { eventsSeen: 0, c2cSeen: 0, lastEvent: null, lastC2C: null, lastStoreResult: null };
  const metadataFile = path.join(dataDir, 'connection.json');
  if (typeof configuredAppId !== 'string' || !/^[0-9]{5,20}$/.test(configuredAppId)) throw new Error('AppID 配置无效。');
  let appId = configuredAppId;
  if (fs.existsSync(metadataFile) && JSON.parse(fs.readFileSync(metadataFile, 'utf8')).appId !== appId) throw new Error('数据目录属于其他 AppID，请使用新的数据目录。');
  if (!fs.existsSync(metadataFile)) writeJson(metadataFile, { appId });
  function persist(job) { writeJson(path.join(jobsDir, `${digestId(job.message.id)}.json`), job); }
  async function measuredCall(stage, input, settings, job = null) {
    const model = stage === 'recognition' ? settings.imageModel : settings.textModel;
    const startedAt = Date.now();
    const id = usage.start({ kind: job ? 'message' : 'test', source: job?.source ?? 'qq', stage, model,
      reasoningEffort: settings.reasoningEffort, jobId: job ? digestId(job.message.id) : null });
    let recordedUsage = null;
    let status = 'failed';
    try {
      const result = await (stage === 'recognition' ? recognizeImages : analyze)(input, {
        preferences, signal: abortController.signal, model, reasoningEffort: settings.reasoningEffort,
        onUsage: value => { recordedUsage = value; },
      });
      status = 'completed';
      return result;
    } catch (cause) {
      if (cause?.code === 'ANALYSIS_TIMEOUT') status = 'timeout';
      if (cause?.code === 'ANALYSIS_CANCELLED') status = 'cancelled';
      throw cause;
    } finally {
      // A metering write failure must not discard a valid result or encourage a
      // paid inference retry. Show the accounting gap independently instead.
      try { if (recordedUsage) usage.record(id, recordedUsage); }
      catch { usageWarning = '部分用量未能保存，请检查磁盘空间；分析结果仍保留，未返回统计的用量不按零计算。'; }
      try { usage.finish(id, status, Date.now() - startedAt); }
      catch { usageWarning = '部分用量状态未能保存，请检查磁盘空间；分析结果仍保留，请勿仅为补统计而重新分析。'; }
    }
  }
  function dailyReport(day) {
    const daily = jobs.filter(j => j.day === day).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    const lines = [`# 工作日志 · ${day}`, '', '根据本人主动发送的消息整理。待确认内容不能视为已确定日程或已完成任务。', ''];
    for (const job of daily) {
      const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(job.receivedAt));
      lines.push(`## ${time} · ${job.state === 'complete' ? '已分析' : job.state === 'failed' ? '分析失败，可重试' : '等待分析'}`, '');
      if (job.result) lines.push(formatAnalysis(job.result), '');
      else lines.push(job.error ?? '消息记录已保存；本条尚无分析结论。', '');
      lines.push(formatUsage(usage.forJob(digestId(job.message.id))), '');
      if (job.recognition) {
        lines.push('### 图片识别文字（请对照原图核对）', '');
        for (const item of job.recognition.images) {
          // Quote OCR as data in the report; never render it as a command or link.
          lines.push(`图片 ${item.sourceIndex ?? item.index}：${item.legibility === 'clear' ? '可读' : item.legibility === 'partial' ? '部分可读，待确认' : '无法辨认'}`);
          lines.push(literalBlock(item.text || '未识别到可用文字。'), '');
          if (item.uncertainties.length) lines.push(...item.uncertainties.map(x => `待核对：${x}`), '');
        }
      }
      if (job.imageWarnings?.length) lines.push(...job.imageWarnings.map(item => `图片处理提示：${item}`), '');
      if (job.documents?.length) {
        lines.push('### 附件读取记录', '');
        for (const doc of job.documents) {
          lines.push(`${doc.name}：${doc.truncated ? '部分读取，不能视为全文' : '已提取可读文字'}。`);
          lines.push(literalBlock(doc.text.slice(0, 1800)), '');
          if (doc.text.length > 1800) lines.push('日志只展示提取文字的前 1800 字；本条完整提取结果保存在服务器 jobs 记录中。', '');
          if (doc.warnings?.length) lines.push(...doc.warnings.map(x => `待核对：${x}`), '');
        }
      }
      if (job.documentWarnings?.length) lines.push(...job.documentWarnings.map(item => `附件处理提示：${item}`), '');
    }
    if (!daily.length) lines.push('今天暂无待整理的消息。');
    return lines.join('\n');
  }
  function brief(result, maxChars = 400, job = null) {
    return formatActionBrief(result, { maxChars, maxActions: 3, ownerName: preferences?.ownerProfile?.name, reminders: job ? reminders.forJob(digestId(job.message.id)) : [] });
  }
  function scheduleReminder(job) {
    try {
      reminders.schedule({jobId:digestId(job.message.id),owner:store.getOwner(),receivedAt:job.receivedAt,actions:job.result.actions});
      reminderWarning='';
    } catch { reminderWarning='提醒未保存，请在管理页检查；分析结果已保留。'; }
  }
  async function flushReminders() {
    if(stopping)return;
    await reminders.dispatch({owner:store.getOwner(),connected:network.state==='connected',send:async (owner,content)=>{
      if(stopping||store.getOwner()!==owner||!client)throw new Error('Reminder sender unavailable');
      await client.push({senderId:owner,content});
    }});
  }
  const reminderTimer=setInterval(()=>{void flushReminders().catch(()=>{reminderWarning='提醒记录写入失败，请检查服务器存储。'})},30000);
  reminderTimer.unref?.();
  // Only recover plans requested by this version, never backfill old notices.
  for(const job of jobs)if(job.state==='complete'&&job.reminderRequested&&job.result)scheduleReminder(job);
  function dailyBrief(day) {
    const daily = jobs.filter(j => j.day === day);
    const complete = daily.filter(j => j.state === 'complete' && j.result);
    if (!daily.length) return `【今日重点】${day}\n今天暂无记录。`;
    const actions = complete.flatMap(j => j.result.actions ?? []);
    const open = daily.filter(j => j.state !== 'complete').length;
    return `【今日重点】${day}\n` + brief({ summary: `已整理 ${complete.length} 条，提取 ${actions.length} 项候选待办${open ? `；另有 ${open} 条等待处理或失败，请查看服务器页面` : ''}。`, relevance: 'uncertain', actions,
      questions: complete.flatMap(j => j.result.questions ?? []), notes: [...new Set(complete.flatMap(j => j.result.notes ?? [])), '逐条汇总，尚未自动合并重复事项。'] }, 560);
  }
  function saveReport(day) {
    fs.writeFileSync(path.join(reportsDir, `${day}.md`), dailyReport(day), { mode: 0o600 });
  }
  function kick() { void drain().catch(() => { lastError = '服务器分析队列写入失败，请检查磁盘空间并重启助手；原文保留在消息记录中。'; }); }
  async function reply(message, content, msgSeq = 1) {
    if (message.id.startsWith('local-upload:')) return false;
    if (!client || store.getOwner() !== message.senderId || network.state !== 'connected') return false;
    // Passive replies expire; a recovered old job remains visible locally instead.
    if (Date.now() - new Date(message.timestamp).getTime() > 240000) return false;
    try { await client.reply({ senderId: message.senderId, messageId: message.id, content: content.slice(0, 3500), msgSeq }); return true; }
    catch { lastError = 'QQ 回复发送未成功，分析结果仍保存在服务器页面和工作日志。'; return false; }
  }
  async function drain() {
    if (busy || testBusy || paused || stopping) return;
    busy = true;
    try {
      while (!paused && !stopping) {
        const job = jobs.find(j => j.state === 'pending');
        if (!job) break;
        job.state = 'processing'; persist(job);
        // One settings snapshot covers both stages of an image notification.
        const settings = modelSettings.getSettings();
        try {
          let text = job.message.text;
          let unreadAttachments = job.hasAttachments && !job.hasImages && !job.hasDocuments;
          let imageUncertain = false;
          let documentUncertain = false;
          if (job.hasDocuments) {
            job.phase = 'documents';
            if (!job.documents) {
              const sources = attachmentSources.get(job.message.id);
              if (!sources) throw new Error('DOCUMENT_SOURCE_EXPIRED');
              const prepared = await documentStore.prepare(job.message.id, sources.filter(isDocumentAttachment), { signal: abortController.signal });
              job.documents = prepared.documents;
              job.documentWarnings = prepared.warnings;
              job.unreadDocuments = prepared.unreadAttachments;
              persist(job);
            } else {
              // Revalidate originals and cached extraction before using a restored job.
              job.documents = await documentStore.resolveDocuments(job.message.id, job.documents);
            }
            documentUncertain = Boolean(job.unreadDocuments) || job.documents.some(doc => doc.truncated || doc.warnings?.length);
            unreadAttachments ||= Boolean(job.unreadDocuments);
            text = [text.trim(), ...job.documents.filter(doc => doc.text.trim()).map(doc => `【附件：${doc.name}】\n${doc.text}`)].filter(Boolean).join('\n\n');
          }
          if (job.hasImages) {
            job.phase = 'images';
            if (!job.images?.length) {
              const sources = attachmentSources.get(job.message.id);
              if (!sources) throw new Error('IMAGE_SOURCE_EXPIRED');
              const prepared = await attachmentStore.prepare(job.message.id, sources.filter(isImageAttachment), { signal: abortController.signal });
              job.imageWarnings = prepared.warnings;
              job.unreadAttachments = prepared.unreadAttachments;
              job.images = prepared.images.map(({ relativePath, mimeType, size }) => ({ relativePath, mimeType, size }));
              persist(job);
              if (!job.images.length) throw new Error('IMAGE_DOWNLOAD_FAILED');
            }
            const localImages = await attachmentStore.resolveImages(job.message.id, job.images);
            job.phase = 'recognition';
            if (!job.recognition) {
              const recognition = await measuredCall('recognition', localImages.map(x => x.path), settings, job);
              job.recognition = { images: recognition.images.map(item => ({ ...item,
                sourceIndex: Number(path.posix.basename(job.images[item.index - 1].relativePath).split('.')[0]),
              })) };
              persist(job); saveReport(job.day);
            }
            const readable = job.recognition.images.filter(item => item.text.trim());
            imageUncertain = job.recognition.images.some(item => item.legibility !== 'clear' || item.uncertainties.length > 0) || Boolean(job.unreadAttachments);
            text = [text.trim(), ...readable.map(item => `【图片 ${item.sourceIndex ?? item.index} 识别文字】\n${item.text}`)].filter(Boolean).join('\n\n');
            unreadAttachments ||= Boolean(job.unreadAttachments);
          }
          unreadAttachments ||= Boolean(job.hasUnknownAttachments);
          if (text.length > 54_000) {
            text = text.slice(0, 54_000);
            documentUncertain = true; unreadAttachments = true;
            job.documentWarnings = [...(job.documentWarnings ?? []), '本条文字、图片和附件合计过长，只分析前 54000 字；请拆开发送以读取其余内容。'];
          }
          job.phase = 'analysis';
          const result = text.trim()
            ? await measuredCall('analysis', { text, receivedAt: job.receivedAt, hasAttachments: unreadAttachments, imageUncertain, documentUncertain }, settings, job)
            : { summary: job.hasDocuments ? '附件未提取到可读正文，尚未生成任务或日程。' : '未能从图片中识别出可用文字，尚未生成任务或日程。', relevance: 'uncertain', actions: [], questions: [job.hasDocuments ? '请查看附件处理提示；扫描件可逐页截图发送，旧格式请另存为新版格式。' : '请重新发送清晰原图，或补充可复制的通知文字。'], notes: [] };
          if (job.hasImages) {
            const imageNotes = ['已根据图片识别文字整理，请核对姓名、日期、数字和地点。', ...(job.imageWarnings ?? []), ...job.recognition.images.flatMap(item => item.uncertainties.map(x => `图片 ${item.sourceIndex ?? item.index} 待核对：${x}`))];
            result.notes = [...new Set([...result.notes, ...imageNotes])].slice(0, 8);
            if (imageUncertain) for (const action of result.actions) action.needsConfirmation = true;
          }
          if (job.hasDocuments || job.documentWarnings?.length) {
            const documentNotes = [...(job.documentWarnings ?? []), ...(job.documents ?? []).flatMap(doc => doc.warnings ?? [])];
            if (documentUncertain) {
              documentNotes.unshift('附件仅部分可读，请核对未读部分，当前结论不能代表全文。');
              for (const action of result.actions) action.needsConfirmation = true;
            }
            result.notes = [...new Set([...result.notes, ...documentNotes])].slice(0, 8);
          }
          job.result = result; job.state = 'complete'; job.completedAt = new Date().toISOString(); job.reminderRequested = true;
          if (job.error && lastError === job.error) lastError = '';
          delete job.error; delete job.phase; attachmentSources.delete(job.message.id);
          analysisReady = true; persist(job); saveReport(job.day);
          scheduleReminder(job);
          const delivered = await reply(job.message, `${brief(result,400,job)}${reminderWarning?'\n'+reminderWarning:''}\n\n${formatUsage(usage.forJob(digestId(job.message.id)))}`, 2);
          job.deliveredToQQ = delivered; persist(job);
        } catch (error) {
          job.state = 'failed'; job.error = error?.code === 'ANALYSIS_INPUT'
            ? '本条文字和图片识别结果过长或输入无效，请将通知分成较短的几条重新发送。'
            : job.phase === 'documents'
            ? '附件读取未完成：下载链接可能过期、文件损坏或服务器缓存不可用。请在服务器页面重新上传原文件；扫描件可改发清晰截图。'
            : job.phase === 'images'
            ? `${job.imageWarnings?.length ? job.imageWarnings.join(' ').slice(0, 800) + '\n' : ''}图片未能完整下载或服务器图片已丢失，请重新发送清晰的 PNG、JPEG 或 WebP 图片。`
            : job.phase === 'recognition'
              ? '图片已保存在服务器，但文字识别未完成。请检查 DeepSeek 密钥、余额或服务状态，再在服务器页面重试。'
              : '分析未完成，请检查 DeepSeek 密钥、余额或服务状态，然后在服务器页面重试。';
          lastError = job.error; persist(job); saveReport(job.day);
          await reply(job.message, job.error, 2);
        }
      }
    } finally { busy = false; }
  }
  async function receive(message) {
    if (stopping) return;
    if (message.messageType && !message.attachments?.length) message = { ...message, attachments: [{}] };
    // A card/quote preview is not the full underlying notice. Ask for its images directly.
    const hasImages = ![3, 101, 102, 103].includes(message.messageType) && Array.isArray(message.attachments) && message.attachments.some(isImageAttachment);
    const hasDocuments = ![101, 102, 103].includes(message.messageType) && Array.isArray(message.attachments) && message.attachments.some(isDocumentAttachment);
    const hasUnknownAttachments = Boolean(message.attachments?.some(a => !isImageAttachment(a) && !isDocumentAttachment(a))) || ([101, 102, 103].includes(message.messageType));
    const outcome = store.handleMessage({ ...message, hasImages, hasDocuments, hasUnknownAttachments });
    diagnostics.lastStoreResult = {
      receivedAt: new Date().toISOString(), saved: outcome.saved, paired: outcome.paired,
      ownerExists: Boolean(store.getOwner()),
      expectedPairingText: !store.getOwner() && typeof message.text === 'string' ? message.text.trim() === `绑定 ${store.ensurePairingCode()}` : null,
    };
    writeJson(diagnosticFile, diagnostics);
    if (outcome.paired) {
      await reply(message, '本人绑定成功。可发文字、截图或受支持的文件，我会先回复重点与时间。文件未传到机器人时可在服务器上传。发送 /today 查看今天重点。', 1);
      return;
    }
    if (store.getOwner() !== message.senderId) return;
    const trimmed = (message.text ?? '').trim();
    if (['/reminders','提醒'].includes(trimmed)) { await reply(message, reminders.list(store.getOwner()), 1); return; }
    if (['/cancel-reminders','取消提醒'].includes(trimmed)) { await reply(message, `已取消 ${reminders.cancel(store.getOwner())} 条待发送提醒。`, 1); return; }
    if (trimmed === '/today') { await reply(message, dailyBrief(localDay()), 1); return; }
    if (trimmed === '/help') {
      await reply(message, '发通知文字、图片或附件，我会直接列出要做的事，保留用量。有明确时刻就按原文提醒，时间已过则标注已过且不新建提醒，没有具体时刻默认收到后3小时提醒（不是原文截止时间）。发送“提醒”查看安排，发送“取消提醒”取消全部待发送提醒；/today 查看今天重点。提醒受 QQ 平台权限和额度限制，失败状态会保留。', 1); return;
    }
    let recoveredRecord;
    if (!outcome.saved) {
      if (outcome.reply) { await reply(message, outcome.reply, 1); return; }
      const existing = jobs.find(job => job.message.id === message.id);
      if (existing) {
        if ((hasImages || hasDocuments) && (existing.hasImages || existing.hasDocuments) && existing.state === 'failed' && ['images', 'documents'].includes(existing.phase)) {
          attachmentSources.set(message.id, message.attachments); existing.state = 'pending'; delete existing.error; persist(existing); kick();
        }
        return;
      }
      // The preceding delivery may have saved raw text before its queue write failed.
      if (Number.isFinite(Date.parse(message.timestamp))) recoveredRecord = store.readDaily(localDay(new Date(message.timestamp))).find(record => record.id === message.id && record.senderId === message.senderId && !record.text.startsWith('[附件：'));
      if (!recoveredRecord) return;
      message = { ...message, text: recoveredRecord.text };
    }
    lastReceivedAt = recoveredRecord?.receivedAt ?? new Date().toISOString();
    const hasAttachments = Boolean(message.attachments?.length) || Boolean(message.messageType);
    if (!trimmed && !hasImages && !hasDocuments) { await reply(message, '收到附件或合并转发卡片，但暂时无法读取正文。普通文件请在服务器“上传附件”中选择原文件；图片请单独发来，也可复制正文。', 1); return; }
    const job = { message: { id: message.id, senderId: message.senderId, text: message.text ?? '', timestamp: message.timestamp }, receivedAt: lastReceivedAt, day: localDay(new Date(lastReceivedAt)), hasAttachments, hasImages, hasDocuments, hasUnknownAttachments, source: 'qq', state: 'pending' };
    if (hasImages || hasDocuments) attachmentSources.set(message.id, message.attachments);
    persist(job); jobs.push(job); saveReport(job.day);
    await reply(message, hasDocuments ? '收到附件，正在读取正文并提炼重点；未读部分会明确提示。' : hasImages ? '收到图片，正在识别文字并整理；看不清的内容会标为待确认。' : hasAttachments ? '已保存可读文字，正在分析。附件或转发卡片未展开，请补充其正文。' : '已收到，正在分析。', 1);
    kick();
  }
  function connect(secret) {
    const ownGeneration = ++generation;
    if (client) client.stop();
    client = new Client({ appId, clientSecret: secret, onDiagnostic: event => {
      diagnostics.eventsSeen++; diagnostics.lastEvent = { ...event, receivedAt: new Date().toISOString() };
      if (event.eventType === 'C2C_MESSAGE_CREATE') { diagnostics.c2cSeen++; diagnostics.lastC2C = diagnostics.lastEvent; }
      writeJson(diagnosticFile, diagnostics);
    }, onMessage: message => receive(message).catch(() => { lastError = '本条消息处理异常，请查看服务器数据后重试。'; throw new Error('服务器消息尚未完成持久化。'); }), onStatus: status => {
      if (ownGeneration !== generation) return;
      network = { state: status.state, message: status.message };
    } });
    client.start();
  }
  async function uploadDocuments(input) {
    const reject = message => { throw Object.assign(new Error(message), { code: 'DOCUMENT_INPUT' }); };
    if (!store.getOwner()) reject('请先完成本人 QQ 绑定，再上传文件。');
    if (stopping) reject('助手正在停止，请重新启动后上传。');
    if (!input || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 3) reject('每次请选择 1 至 3 个文件。');
    const text = input.text ?? '';
    if (typeof text !== 'string' || text.length > 4000) reject('补充说明请控制在 4000 字以内。');
    if (input.requestId != null && (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId))) reject('上传标识无效，请刷新页面重新选择文件。');
    const id = `local-upload:${input.requestId ?? randomUUID()}`;
    let total = 0;
    const files = input.files.map(file => {
      if (!file || typeof file.name !== 'string' || !file.name || file.name.length > 240 || typeof file.base64 !== 'string' || file.base64.length > 14_000_000 || file.base64.length % 4 || /[^A-Za-z0-9+/=]/.test(file.base64)) reject('文件内容无效或过大，请重新选择原文件。');
      const bytes = Buffer.from(file.base64, 'base64');
      if (bytes.toString('base64') !== file.base64) reject('文件编码不完整，请重新选择文件。');
      total += bytes.length;
      if (!bytes.length || bytes.length > 10 * 1024 * 1024 || total > 20 * 1024 * 1024) reject('文件不能为空；单个不超过 10MiB，合计不超过 20MiB。');
      return { name: file.name, bytes };
    });
    const uploadFingerprint = digestId(JSON.stringify({ text, files: files.map(f => ({ name: f.name, hash: digestId(f.bytes) })) }));
    const existing = jobs.find(j => j.message.id === id);
    if (existing) {
      if (existing.uploadFingerprint && existing.uploadFingerprint !== uploadFingerprint) reject('这次上传内容已改变，请重新选择文件后再上传。');
      return { jobId: digestId(id), duplicate: true, warnings: existing.documentWarnings ?? [] };
    }
    if (uploadBusy || jobs.filter(j => ['pending', 'processing'].includes(j.state)).length >= 5) reject('正在处理附件或队列已满，请稍后再上传。');
    uploadBusy = true;
    try {
      const prepared = await documentStore.prepareLocal(id, files, { signal: abortController.signal });
      if (stopping || abortController.signal.aborted) reject('助手已停止，本次文件未加入分析队列。请重新启动后上传。');
      const now = new Date().toISOString();
      let message = { id, senderId: store.getOwner(), text, timestamp: now };
      const outcome = store.handleMessage({ ...message, hasDocuments: true, uploadFingerprint, attachments: [{}] });
      let receivedAt = now;
      if (!outcome.saved) {
        const recovered = fs.readdirSync(path.join(dataDir, 'messages')).filter(n => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).flatMap(n => store.readDaily(n.slice(0, -6))).find(r => r.id === id && r.senderId === message.senderId);
        if (!recovered || recovered.uploadFingerprint !== uploadFingerprint) reject('上传记录已存在但内容不一致，请重新选择文件后再上传。');
        message = { ...message, text: recovered.text, timestamp: recovered.timestamp }; receivedAt = recovered.receivedAt;
      }
      const job = { message, receivedAt, uploadFingerprint, day: localDay(new Date(receivedAt)), source: 'local', hasAttachments: true, hasDocuments: true, hasImages: false,
        documents: prepared.documents, documentWarnings: prepared.warnings, unreadDocuments: prepared.unreadAttachments, state: 'pending' };
      persist(job); jobs.push(job); lastReceivedAt = now; saveReport(job.day); kick();
      return { jobId: digestId(id), warnings: prepared.warnings };
    } finally { uploadBusy = false; }
  }
  return {
    async restore() {
      await modelSettings.initialize();
      try { const secret = await secrets.load(); if (secret) connect(secret); }
      catch { lastError = '服务器凭据读取或连接初始化失败，请检查配置后重启。'; }
      kick();
    },
    async configure() { throw new Error('请在服务器运行配置向导并重启服务。'); },
    state() {
      const owner = store.getOwner();
      const catalog = modelSettings.getSnapshot();
      return { appId, network, credentialsSaved: secrets.exists(), bound: Boolean(owner), pairingCommand: owner ? null : `绑定 ${store.ensurePairingCode()}`, analysisReady, analysisBusy: busy || testBusy, uploadBusy, analysisPaused: paused, lastError, lastReceivedAt, pending: jobs.filter(j => ['pending', 'processing'].includes(j.state)).length, completed: jobs.filter(j => j.state === 'complete').length, failed: jobs.filter(j => j.state === 'failed').length, report: dailyReport(localDay()), dailyBrief: dailyBrief(localDay()), dataDir,
        modelSettings: catalog.settings, modelCatalog: { models: catalog.models, source: catalog.catalogSource, warning: [catalog.catalogWarning, catalog.settingsWarning].filter(Boolean).join(' ') }, usage: { ...usage.snapshot(), warning: usageWarning },
        reminders: reminders.snapshot(), reminderWarning,
        recent: [...jobs].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 12).map(j => ({ id: digestId(j.message.id), receivedAt: j.receivedAt, source: j.source ?? 'qq', state: j.state, summary: j.result?.summary ?? j.error ?? '等待分析', brief: j.result ? brief(j.result,400,j) : j.error ?? '等待分析', detail: j.result ? formatAnalysis(j.result) : '', documents: (j.documents ?? []).map(d => ({ name: d.name, truncated: d.truncated, warnings: d.warnings })), warnings: j.documentWarnings ?? [], deliveredToQQ: j.deliveredToQQ ?? false, usage: usage.forJob(digestId(j.message.id)) })) };
    },
    uploadDocuments,
    async saveModelSettings(input) { await modelSettings.save(input); },
    async testAnalysis() {
      if (busy || testBusy) throw new Error('正在分析工作消息，请稍后再测试。');
      testBusy = true;
      try {
        const result = await measuredCall('analysis', { text: '测试通知（虚构内容）：请示例姓名于2026年10月20日17:00前提交示例部门课程大纲。', receivedAt: new Date().toISOString(), hasAttachments: false }, modelSettings.getSettings());
        analysisReady = true; lastError = ''; return formatAnalysis(result);
      } finally { testBusy = false; kick(); }
    },
    retry() { for (const job of jobs) if (job.state === 'failed') { job.state = 'pending'; delete job.error; persist(job); } kick(); },
    setPaused(value) { paused = Boolean(value); if (!paused) kick(); },
    stop() { stopping = true; clearInterval(reminderTimer); abortController.abort(); ++generation; if (client) client.stop(); },
    receive,
  };
}
