import fs from 'node:fs/promises';
import path from 'node:path';
import { makePrompt, validateImagePaths, INSTRUCTIONS, IMAGE_INSTRUCTIONS, finalizeAnalysis, validateImageRecognition } from './analyzer.mjs';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const fail = (code, message) => Object.assign(new Error(message), { code });
const count = x => Number.isSafeInteger(x) && x >= 0 ? x : null;
const schemas = await Promise.all(['analysis-schema.json', 'image-text-schema.json'].map(async name => JSON.parse(await fs.readFile(new URL(name, import.meta.url), 'utf8'))));

// No CLI, account cookies, tools, web search, or chat history enter this provider.
export function createDeepSeek({ apiKey, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > 512 || /\s/.test(apiKey)) throw fail('ANALYSIS_CONFIG', 'DeepSeek API 密钥尚未正确配置。');
  async function call(options, prepare, validate, image = false) {
    const started = performance.now();
    const model = options.model ?? 'deepseek-flash';
    const effort = options.reasoningEffort ?? 'none';
    let status = 'failed', usage = {}, actualModel = null;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    const timeoutMs = options.timeoutMs ?? 120000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError('Invalid timeout');
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal?.aborted) controller.abort();
      if (controller.signal.aborted) throw fail('ANALYSIS_CANCELLED', '分析已取消。');
      if (!['deepseek-flash', 'deepseek-v4-pro'].includes(model) || (image && model !== 'deepseek-flash') || !['none', 'low', 'high'].includes(effort)) throw fail('ANALYSIS_CONFIG', '模型或思考强度不适用。');
      const content = await prepare();
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, stream: false, reasoning_effort: effort,
          max_tokens: image ? 16384 : (effort === 'none' ? 6144 : 12288),
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: `${image ? IMAGE_INSTRUCTIONS : INSTRUCTIONS}\nReturn only JSON matching this JSON Schema: ${JSON.stringify(schemas[image ? 1 : 0])}` }, { role: 'user', content }] }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const hint = response.status === 401 ? '密钥无效' : response.status === 402 ? '余额不足' : response.status === 429 ? '请求限流' : '服务暂不可用';
        throw fail('ANALYSIS_API', `DeepSeek ${hint}（HTTP ${response.status}）；未自动重试。`);
      }
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1024 * 1024) { await reader.cancel(); throw fail('ANALYSIS_INVALID', 'API 回复超过读取上限。'); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw fail('ANALYSIS_INVALID', 'API 返回的内容无法解析。'); }
      usage = data.usage ?? {};
      actualModel = typeof data.model === 'string' && /^[\w.-]{1,100}$/.test(data.model) ? data.model : null;
      const choice = data.choices?.[0];
      if (choice?.finish_reason !== 'stop' || typeof choice?.message?.content !== 'string') throw fail('ANALYSIS_INCOMPLETE', '分析输出未完整结束；原消息已保留，请核对后手动重试。');
      let parsed;
      try { parsed = JSON.parse(choice.message.content); }
      catch { throw fail('ANALYSIS_INVALID', '模型返回的 JSON 不完整；原消息已保留。'); }
      const result = validate(parsed);
      status = 'completed';
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        status = timedOut ? 'timeout' : 'cancelled';
        throw fail(timedOut ? 'ANALYSIS_TIMEOUT' : 'ANALYSIS_CANCELLED', timedOut ? 'DeepSeek 分析超时；未自动重试。' : '分析已取消。');
      }
      if (error?.code?.startsWith('ANALYSIS_') || error?.code?.startsWith('IMAGE_')) throw error;
      throw fail('ANALYSIS_API', 'DeepSeek 请求失败；原消息已保留，未自动重试。');
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      const inputTokens = count(usage.prompt_tokens), outputTokens = count(usage.completion_tokens);
      const cached = count(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens);
      const usageAvailable = inputTokens !== null && outputTokens !== null;
      try { await options.onUsage?.({ inputTokens, outputTokens, cachedInputTokens: cached !== null && inputTokens !== null && cached <= inputTokens ? cached : null,
        totalTokens: usageAvailable ? inputTokens + outputTokens : null, usageAvailable,
        model: actualModel ?? model, requestedModel: model, modelSource: actualModel ? 'confirmed' : 'requested',
        reasoningEffort: effort, requestedReasoningEffort: effort, reasoningEffortSource: 'requested',
        durationMs: Math.round(performance.now() - started), status }); } catch { /* Never retry paid inference for a metering failure. */ }
    }
  }
  return {
    analyzeMessage: (input, options = {}) => call(options, () => makePrompt(input, options.preferences), value => finalizeAnalysis(value, input)),
    recognizeImages: (paths, options = {}) => call(options, async () => {
      const valid = await validateImagePaths(paths);
      const content = [{ type: 'text', text: JSON.stringify({ imageCount: valid.length, task: '逐张转录原文，只返回 JSON。' }) }];
      let total = 0;
      for (const file of valid) {
        const bytes = await fs.readFile(file); total += bytes.length;
        if (total > 20 * 1024 * 1024) throw fail('IMAGE_INPUT', '图片合计超过 20MiB。');
        const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()];
        content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${bytes.toString('base64')}`, detail: 'high' } });
      }
      return content;
    }, value => validateImageRecognition(value, paths.length), true),
  };
}
