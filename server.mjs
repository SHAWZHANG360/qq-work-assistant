import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export function createLocalServer({ application, port = 18080, onStop = () => {} }) {
  const token = randomBytes(32).toString('hex');
  const nonce = randomBytes(20).toString('hex');
  const origin = `http://127.0.0.1:${port}`;
  const html = fs.readFileSync(fileURLToPath(new URL('./dashboard.html', import.meta.url)), 'utf8').replaceAll('__TOKEN__', token).replaceAll('__NONCE__', nonce);
  function equal(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token)); }
  const server = http.createServer(async (request, response) => {
    const send = (code, data) => { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`);
    if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== origin)) return send(403, { error: '仅允许本机页面访问。' });
    if (request.url === '/health' && request.method === 'GET') return send(200, { app: 'qq-work-assistant', running: true });
    if (request.url === '/' && request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return; }
    if (!equal(request.headers['x-local-token'])) return send(403, { error: '请重新打开本机设置页。' });
    if (request.url === '/api/state' && request.method === 'GET') {
      try { return send(200, application.state()); }
      catch { return send(503, { error: '本机程序正在初始化，请稍后刷新。' }); }
    }
    if (request.headers.origin !== origin) return send(403, { error: '修改操作必须来自管理页。' });
    if (request.method !== 'POST' || !String(request.headers['content-type']).startsWith('application/json')) return send(405, { error: '不支持的请求。' });
    let overflow = false;
    try {
      const limit = request.url === '/api/documents' ? 28 * 1024 * 1024 : 16384;
      if (request.headers['content-length'] && Number(request.headers['content-length']) > limit) return send(413, { error: '请求内容过长。' });
      const chunks = []; let size = 0;
      for await (const bytes of request) { size += bytes.length; if (size > limit) { overflow = true; break; } chunks.push(bytes); }
      if (overflow) return send(413, { error: '请求内容过长。' });
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(raw || '{}');
      switch (request.url) {
        case '/api/documents': send(200, { ok: true, ...await application.uploadDocuments(body) }); break;
        case '/api/configure': await application.configure(body); send(200, { ok: true }); break;
        case '/api/model-settings': await application.saveModelSettings(body); send(200, { ok: true }); break;
        case '/api/test': send(200, { result: await application.testAnalysis() }); break;
        case '/api/pause': application.setPaused(body.paused); send(200, { ok: true }); break;
        case '/api/retry': application.retry(); send(200, { ok: true }); break;
        case '/api/stop': application.stop(); send(200, { ok: true }); setTimeout(onStop, 200); break;
        default: send(404, { error: '页面不存在。' });
      }
    } catch (error) {
      const allowed = /^(请使用已创建|AppSecret 格式|本机密钥保护|Windows 无法|无法启动 Windows|正在分析工作)/;
      const settingsError = request.url === '/api/model-settings' && ['MODEL_SETTINGS_INVALID', 'MODEL_SETTINGS_SAVE_FAILED'].includes(error.code);
      const documentError = request.url === '/api/documents' && error.code === 'DOCUMENT_INPUT';
      send(400, { error: documentError || settingsError || allowed.test(error.message) ? error.message : request.url === '/api/documents' ? '附件读取未完成，请检查文件格式、文件大小与服务器 Python 环境后重试。' : '操作未完成，请检查 DeepSeek 密钥、余额或网络后重试。' });
    }
  });
  server.requestTimeout = 150000;
  server.headersTimeout = 10000;
  return server;
}
