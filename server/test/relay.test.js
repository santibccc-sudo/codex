import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { readConfig } from '../config.js';
import { createRelay, clientEvent, sessionUpdate } from '../relay.js';

const token = 'test-device-token-that-is-at-least-32-characters';
const config = { apiKey: 'test-upstream-key', accessToken: token, model: 'gpt-realtime', voice: 'marin',
  maxConnections: 2, maxSessionSeconds: 30 };

function inbox(socket) {
  const queue = [];
  let pending;
  socket.on('message', (data) => {
    const event = JSON.parse(data.toString());
    if (pending) { const resolve = pending; pending = null; resolve(event); }
    else queue.push(event);
  });
  return () => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = null; reject(new Error('No llegó el evento esperado.')); }, 2000);
      pending = (event) => { clearTimeout(timer); resolve(event); };
    });
  };
}

async function fixture(t, overrides = {}) {
  const mock = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(mock, 'listening');
  const relay = createRelay({ ...config, ...overrides }, {
    connectUpstream: () => new WebSocket(`ws://127.0.0.1:${mock.address().port}`),
  });
  relay.server.listen(0, '127.0.0.1');
  await once(relay.server, 'listening');
  const base = `127.0.0.1:${relay.server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    for (const upstream of mock.clients) upstream.terminate();
    await relay.close();
    await new Promise((resolve) => mock.close(resolve));
  });
  return {
    base, mock,
    async pair() {
      const connected = once(mock, 'connection');
      const client = new WebSocket(`ws://${base}/realtime`, { headers: { Authorization: `Bearer ${token}` } });
      clients.push(client);
      const nextClient = inbox(client);
      const [upstream] = await connected;
      const nextUpstream = inbox(upstream);
      if (client.readyState !== WebSocket.OPEN) await once(client, 'open');
      return { client, upstream, nextClient, nextUpstream };
    },
  };
}

test('config requires credentials, validates limits and preserves proxy selection', () => {
  assert.throws(() => readConfig({}), /OPENAI_API_KEY/);
  assert.throws(() => readConfig({ OPENAI_API_KEY: 'test', WATCH_ACCESS_TOKEN: 'short' }), /WATCH_ACCESS_TOKEN/);
  assert.throws(() => readConfig({ OPENAI_API_KEY: 'test', WATCH_ACCESS_TOKEN: token, PORT: 'abc' }), /PORT/);
  assert.equal(readConfig({ OPENAI_API_KEY: 'test', WATCH_ACCESS_TOKEN: token, HTTPS_PROXY: 'http://proxy:8080' }).proxy,
    'http://proxy:8080');
});

test('session uses the GA audio schema and Spanish instructions without tools', () => {
  const event = sessionUpdate(config);
  assert.equal(event.type, 'session.update');
  assert.deepEqual(event.session.output_modalities, ['audio']);
  assert.deepEqual(event.session.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(event.session.audio.input.turn_detection.interrupt_response, true);
  assert.match(event.session.instructions, /No tienes acceso/);
  assert.equal(event.session.tools, undefined);
});

test('client allowlist rejects commands, invalid PCM and malformed truncation', () => {
  for (const event of [
    { type: 'session.update', session: {} },
    { type: 'input_audio_buffer.append', audio: 'AAAA' }, // three bytes: not PCM16
    { type: 'input_audio_buffer.append', audio: 'not base64' },
    { type: 'conversation.item.truncate', item_id: 'item_a', content_index: 0, audio_end_ms: -1 },
  ]) assert.throws(() => clientEvent(JSON.stringify(event)));
  assert.deepEqual(clientEvent('{"type":"response.cancel","extra":"ignored"}'), { type: 'response.cancel' });
});

test('health endpoint responds and unsupported routes are rejected', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`http://${f.base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', service: 'watch-voice-relay' });
  assert.equal((await fetch(`http://${f.base}/missing`)).status, 404);
});

test('WebSocket refuses missing and incorrect authentication', async (t) => {
  const f = await fixture(t);
  for (const authorization of ['', 'Bearer wrong']) {
    const client = new WebSocket(`ws://${f.base}/realtime`, { headers: { Authorization: authorization } });
    const status = await new Promise((resolve, reject) => {
      client.on('error', reject);
      client.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); client.terminate(); });
    });
    assert.equal(status, 401);
  }
  assert.equal(f.mock.clients.size, 0);
});

test('readiness waits for session.updated, then relays PCM, transcripts, audio and interruption', async (t) => {
  const f = await fixture(t);
  const { client, upstream, nextClient, nextUpstream } = await f.pair();
  assert.deepEqual(await nextUpstream(), sessionUpdate(config));
  upstream.send(JSON.stringify({ type: 'session.created', session: { private: 'not forwarded' } }));
  upstream.send(JSON.stringify({ type: 'session.updated' }));
  assert.deepEqual(await nextClient(), { type: 'relay.ready' });
  const append = { type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') };
  client.send(JSON.stringify(append));
  assert.deepEqual(await nextUpstream(), append);
  for (const event of [
    { type: 'input_audio_buffer.speech_started' },
    { type: 'conversation.item.input_audio_transcription.completed', transcript: 'Hola' },
    { type: 'response.output_audio.delta', item_id: 'item_demo', response_id: 'resp_demo', delta: 'AAA=' },
    { type: 'response.output_audio_transcript.delta', delta: 'Hola, ¿qué necesitas?' },
  ]) {
    upstream.send(JSON.stringify(event));
    assert.deepEqual(await nextClient(), event);
  }
  const truncate = { type: 'conversation.item.truncate', item_id: 'item_demo', content_index: 0, audio_end_ms: 150 };
  client.send(JSON.stringify(truncate));
  assert.deepEqual(await nextUpstream(), truncate);
  client.send(JSON.stringify({ type: 'response.cancel' }));
  assert.deepEqual(await nextUpstream(), { type: 'response.cancel' });
});

test('invalid client event closes connection without forwarding it', async (t) => {
  const f = await fixture(t);
  const { client, upstream, nextClient, nextUpstream } = await f.pair();
  await nextUpstream();
  upstream.send('{"type":"session.updated"}');
  await nextClient();
  const closed = once(client, 'close');
  client.send('{"type":"session.update","session":{"instructions":"override"}}');
  assert.equal((await nextClient()).type, 'relay.error');
  assert.equal((await closed)[0], 1008);
});

test('upstream error is sanitized and closes the session', async (t) => {
  const f = await fixture(t);
  const { client, upstream, nextClient, nextUpstream } = await f.pair();
  await nextUpstream();
  const closed = once(client, 'close');
  upstream.send(JSON.stringify({ type: 'error', error: { message: 'secret test-upstream-key' } }));
  const error = await nextClient();
  assert.equal(error.type, 'relay.error');
  assert.doesNotMatch(JSON.stringify(error), /test-upstream-key/);
  assert.equal((await closed)[0], 1011);
});

test('closing the watch also releases its upstream connection', async (t) => {
  const f = await fixture(t);
  const { client, upstream, nextUpstream } = await f.pair();
  await nextUpstream();
  const closed = once(upstream, 'close');
  client.close();
  await closed;
  assert.equal(upstream.readyState, WebSocket.CLOSED);
});

test('session deadline ends both directions', async (t) => {
  const f = await fixture(t, { maxSessionSeconds: 1 });
  const { client, nextClient, nextUpstream } = await f.pair();
  await nextUpstream();
  const closed = once(client, 'close');
  assert.match((await nextClient()).message, /límite/);
  assert.equal((await closed)[0], 1000);
});
