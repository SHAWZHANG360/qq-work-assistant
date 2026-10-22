import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { QQClient, QQClientError } from './qq-client.mjs';

const SECRET = 'mock-app-secret-do-not-log';
const TOKEN = 'mock-access-token-do-not-log';
const CONTENT = 'mock-private-work-content';

async function until(predicate, timeout = 3500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Timed out waiting for the mock protocol');
    await delay(5);
  }
}

function fixture(t, { handler, onMessage, heartbeatAck = true, expiresIn = '7200' } = {}) {
  const requests = [];
  const sockets = [];
  const statuses = [];
  const messages = [];
  const diagnostics = [];
  class MockWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
    }
    send(raw) {
      const payload = JSON.parse(raw);
      this.sent.push(payload);
      if (payload.op === 1 && heartbeatAck) queueMicrotask(() => this.receive({ op: 11 }));
    }
    close(code = 1000) {
      this.closed = true;
      this.readyState = 3;
      this.serverClose(code);
    }
    receive(payload) {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
    }
    serverClose(code) {
      this.readyState = 3;
      const event = new Event('close');
      Object.defineProperty(event, 'code', { value: code });
      this.dispatchEvent(event);
    }
  }
  const fetchImpl = async (url, options) => {
    const request = { url, ...options, json: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    const custom = await handler?.(request, requests);
    if (custom) return custom;
    if (url.endsWith('/app/getAppAccessToken')) return Response.json({ access_token: TOKEN, expires_in: expiresIn });
    if (url.endsWith('/gateway')) return Response.json({ url: 'wss://api.bot.qq.com/websocket/' });
    return Response.json({ id: 'reply-1', timestamp: '2026-10-14T12:00:00+08:00' });
  };
  const client = new QQClient({
    appId: 'mock-app-123', clientSecret: SECRET, fetchImpl, WebSocketImpl: MockWebSocket,
    onStatus: value => statuses.push(value),
    onDiagnostic: value => diagnostics.push(value),
    onMessage: async value => { messages.push(value); await onMessage?.(value); },
  });
  t.after(() => client.stop());
  const open = async () => { client.start(); await until(() => sockets.length > 0); return sockets[0]; };
  const ready = async (socket, heartbeatInterval = 10_000) => {
    socket.receive({ op: 10, d: { heartbeat_interval: heartbeatInterval } });
    socket.receive({ op: 0, s: 1, t: 'READY', d: { session_id: 'mock-session-1' } });
    await until(() => statuses.some(value => value.state === 'connected'));
  };
  return { client, requests, sockets, statuses, messages, diagnostics, open, ready };
}

function message(sequence, extra = {}) {
  return {
    op: 0, s: sequence, t: 'C2C_MESSAGE_CREATE', d: {
      id: `message-${sequence}`, author: { user_openid: 'owner-openid' },
      content: CONTENT, timestamp: '2026-10-14T10:00:00+08:00', message_type: 0, ...extra,
    },
  };
}

test('official token + gateway + Identify; connected only after READY; no automatic replies', async t => {
  const f = fixture(t);
  const socket = await f.open();
  assert.equal(f.statuses.some(value => value.state === 'connected'), false);
  assert.equal(f.requests[0].url, 'https://api.bot.qq.com/app/getAppAccessToken');
  assert.deepEqual(f.requests[0].json, { appId: 'mock-app-123', clientSecret: SECRET });
  assert.equal(f.requests[1].url, 'https://api.bot.qq.com/gateway');
  assert.equal(f.requests[1].headers.Authorization, `QQBot ${TOKEN}`);
  socket.receive({ op: 10, d: { heartbeat_interval: 10_000 } });
  assert.deepEqual(socket.sent[0], { op: 2, d: { token: `QQBot ${TOKEN}`, intents: 1 << 25, shard: [0, 1] } });
  assert.equal(f.statuses.some(value => value.state === 'connected'), false);
  socket.receive({ op: 0, s: 1, t: 'READY', d: { session_id: 'mock-session-1' } });
  await until(() => f.statuses.some(value => value.state === 'connected'));
  f.client.start();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.requests.filter(value => value.url.includes('/messages')).length, 0);
});

test('forwards only C2C, preserves raw text/attachment metadata, and does not expand chat records', async t => {
  const f = fixture(t);
  const socket = await f.open();
  await f.ready(socket);
  socket.receive({ ...message(2), t: 'GROUP_AT_MESSAGE_CREATE' });
  socket.receive({ op: 0, s: 3, t: 'FRIEND_ADD', d: { user_openid: 'stranger' } });
  socket.receive(message(4, {
    message_type: 102, content: '[聊天记录]',
    attachments: [{ filename: 'shot.png', content_type: 'image/png', url: 'https://example.invalid/image.png' }],
    msg_elements: [{ content: 'nested text must not be invented as the ordinary message' }],
  }));
  await until(() => f.messages.length === 1);
  assert.deepEqual(f.messages[0], {
    id: 'message-4', senderId: 'owner-openid', text: '[聊天记录]', timestamp: '2026-10-14T10:00:00+08:00',
    messageType: 102, attachments: [{ filename: 'shot.png', content_type: 'image/png', url: 'https://example.invalid/image.png' }],
  });
  assert.equal(f.requests.length, 2);
  assert.equal(f.diagnostics.at(-1).eventType, 'C2C_MESSAGE_CREATE');
  assert.doesNotMatch(JSON.stringify(f.diagnostics), /聊天记录|owner-openid|shot\.png|nested text/);
});

test('reply uses C2C endpoint, original msg_id, explicit sequence and QQBot authentication', async t => {
  const f = fixture(t);
  await f.open();
  const result = await f.client.reply({ senderId: 'owner-openid', messageId: 'message-1', content: '已记录', msgSeq: 2 });
  assert.equal(result.id, 'reply-1');
  assert.equal(f.requests.at(-1).url, 'https://api.bot.qq.com/v2/users/owner-openid/messages');
  assert.deepEqual(f.requests.at(-1).json, { content: '已记录', msg_type: 0, msg_id: 'message-1', msg_seq: 2 });
  assert.equal(f.requests.at(-1).headers.Authorization, `QQBot ${TOKEN}`);
  assert.equal(f.requests.at(-1).redirect, 'error');
  await assert.rejects(f.client.reply({ senderId: 'owner-openid', messageId: 'message-1', content: '', msgSeq: 1 }), QQClientError);
});

test('proactive reminders use official C2C without an expired or invented message id', async t => {
  const f=fixture(t);await f.open();
  await f.client.push({senderId:'owner-openid',content:'提醒测试'});
  assert.equal(f.requests.at(-1).url,'https://api.bot.qq.com/v2/users/owner-openid/messages');
  assert.deepEqual(f.requests.at(-1).json,{content:'提醒测试',msg_type:0});
});

test('HTTP 200 token business error fails closed without echoing secrets or server messages', async t => {
  const f = fixture(t, { handler: req => req.url.endsWith('/app/getAppAccessToken')
    ? Response.json({ code: 100016, message: `server echo ${SECRET} ${TOKEN} ${CONTENT}` }) : undefined });
  f.client.start();
  await until(() => f.statuses.some(value => value.state === 'error'));
  assert.equal(f.sockets.length, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.statuses.at(-1).code, 100016);
  assert.doesNotMatch(JSON.stringify(f.statuses), new RegExp(`${SECRET}|${TOKEN}|${CONTENT}`));
});

test('reply reports business errors safely and retries only a rejected authentication once', async t => {
  let replies = 0;
  const f = fixture(t, { handler: req => {
    if (!req.url.includes('/messages')) return;
    replies += 1;
    if (replies === 1) return Response.json({ message: TOKEN }, { status: 401 });
    return Response.json({ err_code: 40034005, message: `${SECRET} ${CONTENT}` });
  } });
  await f.open();
  await assert.rejects(f.client.reply({ senderId: 'owner-openid', messageId: 'message-1', content: '已记录' }), error => {
    assert.equal(error.code, 40034005);
    assert.doesNotMatch(String(error), new RegExp(`${SECRET}|${TOKEN}|${CONTENT}`));
    return true;
  });
  assert.equal(replies, 2);
  assert.equal(f.requests.filter(req => req.url.endsWith('/app/getAppAccessToken')).length, 2);
});

test('heartbeats acknowledge the last processed sequence; a missing ACK reconnects', async t => {
  const f = fixture(t, { heartbeatAck: false });
  const socket = await f.open();
  await f.ready(socket, 40);
  socket.receive(message(2));
  await until(() => f.messages.length === 1);
  await until(() => socket.sent.some(value => value.op === 1));
  assert.deepEqual(socket.sent.find(value => value.op === 1), { op: 1, d: 2 });
  await until(() => f.statuses.some(value => value.state === 'reconnecting'));
  assert.equal(socket.closed, true);
  assert.match(f.statuses.at(-1).message, /心跳/);
});

test('resume uses processed sequence and delivers replay before RESUMED without marking connected early', async t => {
  const f = fixture(t);
  const first = await f.open();
  await f.ready(first);
  first.receive(message(2));
  await until(() => f.messages.length === 1);
  first.serverClose(4009);
  await until(() => f.sockets.length === 2);
  const second = f.sockets[1];
  second.receive({ op: 10, d: { heartbeat_interval: 10_000 } });
  assert.deepEqual(second.sent[0], { op: 6, d: { token: `QQBot ${TOKEN}`, session_id: 'mock-session-1', seq: 2 } });
  second.receive(message(3));
  await until(() => f.messages.length === 2);
  assert.equal(f.statuses.filter(value => value.state === 'connected').length, 1);
  second.receive({ op: 0, s: 4, t: 'RESUMED', d: '' });
  await until(() => f.statuses.filter(value => value.state === 'connected').length === 2);
});

test('callback failure is retried from the last successfully processed sequence', async t => {
  let attempts = 0;
  const f = fixture(t, { onMessage: () => { if (++attempts === 1) throw new Error(`${CONTENT} ${TOKEN}`); } });
  const first = await f.open();
  await f.ready(first);
  first.receive(message(2));
  await until(() => f.statuses.some(value => value.state === 'reconnecting'));
  await until(() => f.sockets.length === 2);
  const second = f.sockets[1];
  second.receive({ op: 10, d: { heartbeat_interval: 10_000 } });
  assert.equal(second.sent[0].op, 6);
  assert.equal(second.sent[0].d.seq, 1);
  second.receive(message(2));
  await until(() => attempts === 2);
  assert.doesNotMatch(JSON.stringify(f.statuses), new RegExp(`${TOKEN}|${CONTENT}`));
});

test('fatal permission close does not retry; stop cancels a pending reconnect and ignores stale events', async t => {
  const fatal = fixture(t);
  const socket = await fatal.open();
  await fatal.ready(socket);
  socket.serverClose(4014);
  assert.equal(fatal.statuses.at(-1).state, 'error');
  assert.equal(fatal.statuses.at(-1).code, 4014);
  assert.equal(fatal.statuses.some(value => value.state === 'reconnecting'), false);

  const stopped = fixture(t);
  const second = await stopped.open();
  await stopped.ready(second);
  second.serverClose(4009);
  stopped.client.stop();
  second.receive(message(2));
  await delay(1350);
  assert.equal(stopped.sockets.length, 1);
  assert.equal(stopped.messages.length, 0);
  assert.equal(stopped.statuses.at(-1).state, 'stopped');
});

test('short lived credentials refresh without user messages or extra sockets', async t => {
  const f = fixture(t, { expiresIn: '1' });
  await f.open();
  await until(() => f.requests.filter(req => req.url.endsWith('/app/getAppAccessToken')).length >= 2, 2000);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.requests.filter(req => req.url.includes('/messages')).length, 0);
});

test('a temporary token refresh failure restores connected status after automatic recovery', async t => {
  let tokenRequests = 0;
  const f = fixture(t, { handler: req => {
    if (!req.url.endsWith('/app/getAppAccessToken')) return;
    tokenRequests += 1;
    if (tokenRequests === 2) throw new Error(`private server error ${TOKEN}`);
    return Response.json({ access_token: TOKEN, expires_in: tokenRequests === 1 ? '0.1' : '7200' });
  } });
  const socket = await f.open();
  await f.ready(socket);
  await until(() => f.statuses.some(value => value.state === 'error'));
  assert.equal(f.statuses.at(-1).state, 'error');
  await until(() => f.statuses.filter(value => value.state === 'connected').length === 2, 6500);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.statuses.at(-1).state, 'connected');
  assert.equal(f.requests.filter(req => req.url.includes('/messages')).length, 0);
  assert.doesNotMatch(JSON.stringify(f.statuses), new RegExp(TOKEN));
});

test('rejects nonofficial or unencrypted gateway addresses before sending a credential', async t => {
  for (const url of ['ws://api.bot.qq.com/websocket', 'wss://qq.com.example.invalid/websocket', 'wss://user:pass@api.bot.qq.com/']) {
    const f = fixture(t, { handler: req => req.url.endsWith('/gateway') ? Response.json({ url }) : undefined });
    f.client.start();
    await until(() => f.statuses.some(value => value.state === 'error'));
    assert.equal(f.sockets.length, 0);
  }
});
