import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateModelSettings } from './model-settings.mjs';

export const MODELS = Object.freeze([
  { id: 'deepseek-flash', label: 'DeepSeek Flash（省费用，支持图片）', description: '默认模型。按 DeepSeek API 账单计费。', supportsImages: true, reasoningEfforts: ['none', 'low', 'high'] },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro（文字）', description: '费用较高，仅用于文字分析。', supportsImages: false, reasoningEfforts: ['none', 'low', 'high'] },
]);
export function createDeepSeekSettings({ dataDir }) {
  const file = path.join(dataDir, 'deepseek-model-settings.json');
  let settings = { textModel: 'deepseek-flash', imageModel: 'deepseek-flash', reasoningEffort: 'none' };
  let initialization, queue = Promise.resolve();
  const getSettings = () => ({ ...settings });
  const getSnapshot = () => ({ settings: getSettings(), models: structuredClone(MODELS), catalogSource: 'deepseek-official', catalogWarning: '官方模型目录核对日期：2026-10-18；实际权限以 API 返回为准。费用以 DeepSeek 账单为准。', settingsWarning: null });
  const initialize = () => initialization ??= (async () => {
    try { const stat = await fs.stat(file); if (stat.size > 16384) throw new Error('模型设置过大。'); settings = validateModelSettings(JSON.parse(await fs.readFile(file, 'utf8')), MODELS); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return getSnapshot();
  })();
  function save(value) {
    const candidate = structuredClone(value);
    const operation = queue.then(async () => {
      await initialize();
      const validated = validateModelSettings(candidate, MODELS);
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(validated), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
      finally { await fs.unlink(temporary).catch(() => {}); }
      settings = validated; return getSnapshot();
    });
    queue = operation.catch(() => {}); return operation;
  }
  return { initialize, getSettings, getSnapshot, save };
}
