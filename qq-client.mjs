// Official protocol: https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html
// C2C: https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
const API_BASE = 'https://api.bot.qq.com';
const HTTP_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const CALLBACK_TIMEOUT_MS = 30_000;
const C2C_INTENT = 1 << 25;
const FATAL_CLOSE_CODES = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915]);

export class QQClientError extends Error {
  constructor(message, { code, status, retryable = false } = {}) {
    super(message);
    this.name = 'QQClientError';
    if (code !== undefined) this.code = code;
    if (status !== undefined) this.status = status;
    this.retryable = retryable;
  }
}

function safeCode(value) {
  return (typeof value === 'number' && Number.isSafeInteger(value)) ||
    (typeof value === 'string' && /^-?\d{1,12}$/.test(value)) ? Number(value) : undefined;
}

function nonempty(value, limit) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit;
}

function timer(fn, delay) {
  const handle = setTimeout(fn, delay);
  handle.unref?.();
  return handle;
}

/** Transport only. The caller must authorize senderId before saving or replying. */
export class QQClient {
  #appId;
  #clientSecret;
  #fetch;
  #WebSocket;
  #onMessage;
  #onStatus;
  #onDiagnostic;
  #running = false;
  #generation = 0;
  #socket = null;
  #sessionId = null;
  #sequence = null;
  #token = null;
  #tokenExpiresAt = 0;
  #refreshBeforeMs = 45_000;
  #tokenPromise = null;
  #refreshTimer = null;
  #refreshFailed = false;
  #retryTimer = null;
  #retryCount = 0;
  #requests = new Set();
  #dispatchQueue = Promise.resolve();

  constructor({ appId, clientSecret, onMessage = () => {}, onStatus = () => {}, onDiagnostic = () => {},
    fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
    if (!nonempty(appId, 256) || !nonempty(clientSecret, 2048)) {
      throw new QQClientError('请在本机填写有效的 AppID 和 AppSecret。');
    }
    if (typeof fetchImpl !== 'function' || typeof WebSocketImpl !== 'function' ||
        typeof onMessage !== 'function' || typeof onStatus !== 'function') {
      throw new QQClientError('QQ 客户端运行环境或回调无效。');
    }
    this.#appId = appId.trim();
    this.#clientSecret = clientSecret.trim();
    this.#fetch = fetchImpl;
    this.#WebSocket = WebSocketImpl;
    this.#onMessage = onMessage;
    this.#onStatus = onStatus;
    this.#onDiagnostic = typeof onDiagnostic === 'function' ? onDiagnostic : () => {};
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    this.#generation += 1;
    this.#sessionId = null;
    this.#sequence = null;
    this.#retryCount = 0;
    this.#refreshFailed = false;
    this.#dispatchQueue = Promise.resolve();
    this.#status('connecting', '正在连接 QQ 官方机器人接口。');
    void this.#connect(this.#generation);
  }

  stop() {
    if (!this.#running) return;
    this.#running = false;
    this.#generation += 1;
    this.#cancelResources();
    this.#status('stopped', 'QQ 连接已停止。');
  }

  async reply({ senderId, messageId, content, msgSeq = 1 } = {}) {
    if (!this.#running) throw new QQClientError('QQ 客户端尚未启动。');
    if (!nonempty(senderId, 256) || !nonempty(messageId, 4096) || !nonempty(content, 8000) ||
        !Number.isSafeInteger(msgSeq) || msgSeq < 1 || msgSeq > 4) {
      throw new QQClientError('回复消息参数无效或内容过长。');
    }
    return this.#authorizedRequest(`/v2/users/${encodeURIComponent(senderId)}/messages`, {
      method: 'POST', body: { content, msg_type: 0, msg_id: messageId, msg_seq: msgSeq },
    }, this.#generation);
  }

  #active(generation) { return this.#running && generation === this.#generation; }

  #status(state, message, code) {
    // Do not pass server error text, secrets, message bodies, or raw payloads to logs/UI.
    try { this.#onStatus({ state, message, ...(code === undefined ? {} : { code }) }); } catch {}
  }

  #cancelResources() {
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#refreshTimer);
    this.#retryTimer = null;
    this.#refreshTimer = null;
    for (const controller of this.#requests) controller.abort();
    this.#requests.clear();
    this.#closeSocket(this.#socket);
    this.#socket = null;
  }

  #closeSocket(connection) {
    if (!connection) return;
    connection.ended = true;
    clearTimeout(connection.handshakeTimer);
    clearTimeout(connection.heartbeatTimer);
    try { connection.ws.close(1000); } catch {}
  }

  async #request(path, { method = 'GET', body, token } = {}, generation) {
    if (!this.#active(generation)) throw new QQClientError('QQ 连接已停止。');
    const controller = new AbortController();
    this.#requests.add(controller);
    const timeout = timer(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await this.#fetch(`${API_BASE}${path}`, {
        method, redirect: 'error', signal: controller.signal,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...(token ? { Authorization: `QQBot ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!this.#active(generation)) throw new QQClientError('QQ 连接已停止。');
      const raw = await response.text();
      if (raw.length > 1_000_000) throw new QQClientError('QQ 接口响应过大。');
      let data;
      try { data = JSON.parse(raw); } catch {
        throw new QQClientError('QQ 接口返回了无法识别的响应。', {
          status: response.status, retryable: response.status >= 500 || response.status === 429,
        });
      }
      const code = [data?.code, data?.err_code, data?.errcode]
        .map(safeCode).find(value => value !== undefined && value !== 0);
      if (!response.ok || code !== undefined) {
        throw new QQClientError('QQ 接口请求未成功，请检查连接状态、凭据及后台权限。', {
          status: response.status, code,
          retryable: response.status >= 500 || response.status === 429 || code === 100001,
        });
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new QQClientError('QQ 接口返回了无法识别的响应。');
      }
      return data;
    } catch (error) {
      if (error instanceof QQClientError) throw error;
      throw new QQClientError('QQ 网络请求中断或超时。', { retryable: true });
    } finally {
      clearTimeout(timeout);
      this.#requests.delete(controller);
    }
  }

  async #getToken(generation, force = false) {
    if (!this.#active(generation)) throw new QQClientError('QQ 连接已停止。');
    if (!force && this.#token && Date.now() < this.#tokenExpiresAt - this.#refreshBeforeMs) {
      return this.#token;
    }
    if (this.#tokenPromise?.generation === generation) return this.#tokenPromise.promise;
    const entry = { generation };
    entry.promise = (async () => {
      const data = await this.#request('/app/getAppAccessToken', {
        method: 'POST', body: { appId: this.#appId, clientSecret: this.#clientSecret },
      }, generation);
      const lifetime = Number(data.expires_in);
      if (!nonempty(data.access_token, 16_384) || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 86_400) {
        throw new QQClientError('QQ 访问凭据响应无效，请检查机器人设置。');
      }
      if (!this.#active(generation)) throw new QQClientError('QQ 连接已停止。');
      this.#token = data.access_token;
      this.#tokenExpiresAt = Date.now() + lifetime * 1000;
      this.#refreshBeforeMs = Math.min(45_000, lifetime * 100);
      this.#scheduleRefresh(generation);
      if (this.#refreshFailed) {
        this.#refreshFailed = false;
        if (this.#socket?.ready && !this.#socket.ended) {
          this.#status('connected', 'QQ 访问凭据已恢复，机器人连接正常。');
        }
      }
      return this.#token;
    })();
    this.#tokenPromise = entry;
    try { return await entry.promise; } finally {
      if (this.#tokenPromise === entry) this.#tokenPromise = null;
    }
  }

  #scheduleRefresh(generation, retryDelay) {
    clearTimeout(this.#refreshTimer);
    if (!this.#active(generation)) return;
    const delay = retryDelay ?? Math.max(100, this.#tokenExpiresAt - Date.now() - this.#refreshBeforeMs);
    this.#refreshTimer = timer(async () => {
      try { await this.#getToken(generation, true); } catch (error) {
        if (!this.#active(generation)) return;
        if (!error.retryable) this.#halt(error);
        else {
          this.#refreshFailed = true;
          this.#status('error', 'QQ 访问凭据刷新失败，稍后自动重试。', error.code ?? error.status);
          this.#scheduleRefresh(generation, 5000);
        }
      }
    }, delay);
  }

  async #authorizedRequest(path, options, generation) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.#getToken(generation, attempt > 0);
      try { return await this.#request(path, { ...options, token }, generation); } catch (error) {
        if (attempt === 0 && error.status === 401 && this.#active(generation)) {
          this.#tokenExpiresAt = 0;
          continue;
        }
        throw error;
      }
    }
  }

  async #connect(generation) {
    if (!this.#active(generation)) return;
    try {
      // Let a previously accepted local write finish before selecting a resume sequence.
      await this.#dispatchQueue;
      if (!this.#active(generation)) return;
      const gateway = await this.#authorizedRequest('/gateway', {}, generation);
      let address;
      try { address = new URL(gateway.url); } catch { throw new QQClientError('QQ 网关地址无效。'); }
      if (address.protocol !== 'wss:' || address.username || address.password ||
          !(address.hostname === 'qq.com' || address.hostname.endsWith('.qq.com'))) {
        throw new QQClientError('QQ 网关地址不是受支持的官方加密连接。');
      }
      const token = await this.#getToken(generation);
      if (!this.#active(generation)) return;
      const connection = {
        ws: new this.#WebSocket(address.href), generation, token,
        ended: false, hello: false, ready: false, awaitingAck: false,
        attemptedResume: Boolean(this.#sessionId && this.#sequence !== null),
      };
      this.#socket = connection;
      connection.handshakeTimer = timer(() => this.#fail(connection, 'QQ 连接握手超时，正在重试。'), HANDSHAKE_TIMEOUT_MS);
      connection.ws.addEventListener('message', event => this.#receive(connection, event.data));
      connection.ws.addEventListener('error', () => this.#fail(connection, 'QQ 网络连接中断，正在重试。'));
      connection.ws.addEventListener('close', event => {
        if (connection.ended || !this.#active(generation)) return;
        const code = safeCode(event.code);
        if (FATAL_CLOSE_CODES.has(code)) {
          this.#halt(new QQClientError('QQ 拒绝连接，请检查机器人权限、上线状态和接入设置。', { code }));
          return;
        }
        if (code === 4006 || code === 4007 || (code >= 4900 && code <= 4913)) {
          this.#sessionId = null;
          this.#sequence = null;
        }
        this.#fail(connection, 'QQ 连接已断开，正在重试。', code);
      });
    } catch (error) {
      if (!this.#active(generation)) return;
      const safeError = error instanceof QQClientError ? error : new QQClientError('QQ 连接建立失败。', { retryable: true });
      if (!safeError.retryable) this.#halt(safeError);
      else this.#scheduleReconnect(generation, safeError.message, safeError.code ?? safeError.status);
    }
  }

  #send(connection, payload) {
    if (connection.ended || !this.#active(connection.generation)) return false;
    try {
      if (connection.ws.readyState !== 1) throw new Error();
      connection.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      this.#fail(connection, 'QQ 消息通道中断，正在重试。');
      return false;
    }
  }

  #receive(connection, raw) {
    if (connection.ended || !this.#active(connection.generation)) return;
    if (typeof raw !== 'string' || raw.length > 1_000_000) {
      this.#fail(connection, 'QQ 网关返回了无法识别的数据。');
      return;
    }
    let payload;
    try { payload = JSON.parse(raw); } catch {
      this.#fail(connection, 'QQ 网关返回了无法识别的数据。');
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    if (payload.op === 10) {
      const interval = payload.d?.heartbeat_interval;
      if (connection.hello || !Number.isFinite(interval) || interval < 10 || interval > 300_000) {
        this.#fail(connection, 'QQ 网关心跳设置无效。');
        return;
      }
      connection.hello = true;
      connection.heartbeatInterval = interval;
      const login = connection.attemptedResume
        ? { op: 6, d: { token: `QQBot ${connection.token}`, session_id: this.#sessionId, seq: this.#sequence } }
        : { op: 2, d: { token: `QQBot ${connection.token}`, intents: C2C_INTENT, shard: [0, 1] } };
      if (this.#send(connection, login)) this.#heartbeatLater(connection);
    } else if (payload.op === 11) {
      connection.awaitingAck = false;
    } else if (payload.op === 1 && connection.hello) {
      if (this.#send(connection, { op: 1, d: this.#sequence })) connection.awaitingAck = true;
    } else if (payload.op === 7) {
      this.#fail(connection, 'QQ 网关要求重新连接。');
    } else if (payload.op === 9) {
      if (payload.d !== true) { this.#sessionId = null; this.#sequence = null; }
      this.#fail(connection, 'QQ 会话失效，正在重新连接。');
    } else if (payload.op === 0 && connection.hello) {
      this.#dispatchQueue = this.#dispatchQueue.then(() => this.#dispatch(connection, payload));
    }
  }

  #heartbeatLater(connection) {
    connection.heartbeatTimer = timer(() => {
      if (connection.ended || !this.#active(connection.generation)) return;
      if (connection.awaitingAck) {
        this.#fail(connection, 'QQ 心跳未获确认，正在重新连接。');
        return;
      }
      if (this.#send(connection, { op: 1, d: this.#sequence })) {
        connection.awaitingAck = true;
        this.#heartbeatLater(connection);
      }
    }, connection.heartbeatInterval);
  }

  async #dispatch(connection, payload) {
    if (connection.ended || !this.#active(connection.generation)) return;
    try {
      const data = payload.d;
      this.#onDiagnostic({
        eventType: typeof payload.t === 'string' && /^[A-Z0-9_]{1,64}$/.test(payload.t) ? payload.t : 'OTHER',
        sequenceValid: Number.isSafeInteger(payload.s),
        ...(payload.t === 'C2C_MESSAGE_CREATE' ? {
          idLength: typeof data?.id === 'string' ? data.id.length : null,
          idPatternValid: typeof data?.id === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(data.id),
          authorKeys: data?.author && typeof data.author === 'object' ? Object.keys(data.author).filter(k => /^[a-z_]{1,40}$/.test(k)) : [],
          senderPatternValid: typeof data?.author?.user_openid === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(data.author.user_openid),
          timestampType: typeof data?.timestamp,
          timestampParseable: Number.isFinite(Date.parse(data?.timestamp)),
          contentLength: typeof data?.content === 'string' ? data.content.length : null,
          attachmentCount: Array.isArray(data?.attachments) ? data.attachments.length : 0,
          attachmentTypes: Array.isArray(data?.attachments) ? data.attachments.slice(0, 4).map(item => typeof item?.content_type === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(item.content_type) ? item.content_type : 'unknown') : [],
        } : {}),
      });
    } catch {}
    if (!Number.isSafeInteger(payload.s) || payload.s < 0) return;
    const data = payload.d;
    if (payload.t === 'READY' || payload.t === 'RESUMED') {
      if (payload.t === 'READY') {
        if (!nonempty(data?.session_id, 1024)) { this.#fail(connection, 'QQ 会话响应无效。'); return; }
        this.#sessionId = data.session_id;
      } else if (!connection.attemptedResume) return;
      connection.ready = true;
      this.#retryCount = 0;
      clearTimeout(connection.handshakeTimer);
      this.#sequence = payload.s;
      this.#status('connected', 'QQ 机器人已连接，等待本人发送消息。');
      return;
    }
    // A resumed session replays messages before it emits the RESUMED marker.
    if (!connection.ready && !connection.attemptedResume) return;
    if (payload.t === 'C2C_MESSAGE_CREATE' && nonempty(data?.id, 4096) &&
        nonempty(data?.author?.user_openid, 256)) {
      let callbackTimer;
      try {
        await Promise.race([
          Promise.resolve().then(() => this.#onMessage({
            id: data.id, senderId: data.author.user_openid,
            text: typeof data.content === 'string' ? data.content : '',
            timestamp: typeof data.timestamp === 'string' ? data.timestamp : null,
            attachments: Array.isArray(data.attachments) ? data.attachments : [],
            messageType: Number.isSafeInteger(data.message_type) ? data.message_type : 0,
          })),
          new Promise((_, reject) => {
            callbackTimer = timer(() => reject(new QQClientError('本机消息处理超时。')), CALLBACK_TIMEOUT_MS);
          }),
        ]);
      } catch {
        this.#fail(connection, '本机消息处理失败，正在重新连接以重新接收。');
        return;
      } finally { clearTimeout(callbackTimer); }
    }
    if (this.#active(connection.generation)) this.#sequence = payload.s;
  }

  #fail(connection, message, code) {
    if (connection.ended || !this.#active(connection.generation)) return;
    this.#closeSocket(connection);
    if (this.#socket === connection) this.#socket = null;
    this.#scheduleReconnect(connection.generation, message, code);
  }

  #scheduleReconnect(generation, message, code) {
    if (!this.#active(generation) || this.#retryTimer) return;
    this.#status('reconnecting', message, code);
    const delay = Math.min(30_000, 1000 * (2 ** Math.min(this.#retryCount++, 5))) + Math.floor(Math.random() * 250);
    this.#retryTimer = timer(() => {
      this.#retryTimer = null;
      void this.#connect(generation);
    }, delay);
  }

  #halt(error) {
    this.#running = false;
    this.#generation += 1;
    this.#cancelResources();
    this.#status('error', error.message, error.code ?? error.status);
  }
}
