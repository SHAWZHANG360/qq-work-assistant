import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const count = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
const dayOf = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const labels = { analysis: '文字整理', recognition: '图片识字' };

export function summarizeUsage(entries) {
  const totals = { calls: entries.length, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, unknownCalls: 0, unknownCacheCalls: 0 };
  for (const entry of entries) {
    if (!entry.usageAvailable) { totals.unknownCalls++; continue; }
    totals.inputTokens += entry.inputTokens;
    totals.outputTokens += entry.outputTokens;
    totals.totalTokens += entry.totalTokens;
    if (entry.cachedInputTokens === null) totals.unknownCacheCalls++;
    else totals.cachedInputTokens += entry.cachedInputTokens;
  }
  return totals;
}

// This ledger contains counters and opaque local job hashes, never message bodies,
// image URLs, provider errors, account details, or credentials.
export function createUsageStore({ dataDir, now = () => new Date() }) {
  const file = path.join(dataDir, 'model-usage.json');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let entries = [];
  const persist = next => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, entries: next }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    entries = next;
  };
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.some(entry =>
      !entry || typeof entry.id !== 'string' || !Number.isFinite(Date.parse(entry.createdAt)) ||
      !['message', 'test'].includes(entry.kind) || !Object.hasOwn(labels, entry.stage) ||
      (entry.usageAvailable && (count(entry.inputTokens) === null || count(entry.outputTokens) === null || entry.totalTokens !== entry.inputTokens + entry.outputTokens)))) {
      throw new Error('模型用量记录损坏，请检查本机数据。');
    }
    entries = saved.entries;
    if (entries.some(entry => entry.status === 'running')) {
      persist(entries.map(entry => entry.status === 'running' ? { ...entry, status: 'interrupted' } : entry));
    }
  }
  function update(id, patch) {
    if (!entries.some(entry => entry.id === id)) throw new Error('未知用量记录。');
    persist(entries.map(entry => entry.id === id ? { ...entry, ...patch } : entry));
  }
  return {
    start({ kind, stage, model = 'default', reasoningEffort = 'low', jobId = null, source = 'qq' }) {
      if (!['message', 'test'].includes(kind) || !Object.hasOwn(labels, stage) ||
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model) ||
          !['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(reasoningEffort) ||
          (jobId !== null && !/^[a-f0-9]{64}$/.test(jobId))) throw new TypeError('无效用量元数据。');
      const id = randomUUID();
      persist([...entries, { id, createdAt: now().toISOString(), kind, stage, jobId,
        label: `${kind === 'test' ? '虚构通知测试' : source === 'local' ? '本机附件' : 'QQ 通知'} · ${labels[stage]}`,
        model, reasoningEffort, status: 'running', durationMs: null, actualModel: null,
        modelSource: model === 'default' ? 'unknown' : 'requested',
        inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null, usageAvailable: false }]);
      return id;
    },
    record(id, usage) {
      if (!usage || typeof usage !== 'object') return;
      const inputTokens = count(usage.inputTokens), outputTokens = count(usage.outputTokens);
      const cached = count(usage.cachedInputTokens);
      const cachedInputTokens = inputTokens !== null && cached !== null && cached <= inputTokens ? cached : null;
      const usageAvailable = inputTokens !== null && outputTokens !== null;
      update(id, { inputTokens, cachedInputTokens, outputTokens,
        totalTokens: usageAvailable ? inputTokens + outputTokens : null, usageAvailable,
        durationMs: count(usage.durationMs),
        ...(usage.modelSource === 'confirmed' && typeof usage.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(usage.model)
          ? { actualModel: usage.model, modelSource: 'confirmed' } : {}),
      });
    },
    finish(id, status, durationMs) {
      if (!['completed', 'failed', 'cancelled', 'timeout'].includes(status)) throw new TypeError('无效用量状态。');
      update(id, { status, durationMs: count(durationMs) });
    },
    snapshot() {
      return { today: summarizeUsage(entries.filter(entry => dayOf(entry.createdAt) === dayOf(now()))),
        recent: entries.slice(-30).reverse().map(({ jobId, ...entry }) => ({ ...entry })) };
    },
    forJob(jobId) { return summarizeUsage(entries.filter(entry => entry.jobId === jobId)); },
  };
}

export function formatUsage(totals) {
  if (!totals.calls) return '本条用量：未记录（历史消息）。';
  const known = totals.calls - totals.unknownCalls;
  if (!known) return `本条用量：${totals.calls} 次调用，未返回 token 统计。`;
  return `本条用量：${totals.unknownCalls ? '已知 ' : ''}${totals.totalTokens.toLocaleString('en-US')} token（输入 ${totals.inputTokens.toLocaleString('en-US')} + 输出 ${totals.outputTokens.toLocaleString('en-US')}；${totals.calls} 次调用${totals.unknownCalls ? `，其中 ${totals.unknownCalls} 次用量未知` : ''}）。`;
}
