import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

export function sessionUpdate(config) {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions: 'Eres el asistente personal de voz del usuario. Habla en español de España, '
        + 'con naturalidad y respuestas breves. Ayuda con programación, organización y diagnosis '
        + 'de taller sin inventar datos. No tienes acceso a la sesión de Codex de ChatGPT, '
        + 'a sus archivos ni a su Mac. No afirmes haber ejecutado acciones: esta app no tiene '
        + 'herramientas para controlar dispositivos, ejecutar código o enviar mensajes.',
      max_output_tokens: 1024,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          noise_reduction: { type: 'near_field' },
          transcription: { model: 'gpt-4o-mini-transcribe', language: 'es' },
          turn_detection: {
            type: 'server_vad', threshold: 0.6, prefix_padding_ms: 300,
            silence_duration_ms: 600, create_response: true, interrupt_response: true,
          },
        },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice: config.voice },
      },
    },
  };
}

// Reconstruct allowed events rather than exposing arbitrary Realtime commands.
export function clientEvent(message) {
  const event = JSON.parse(message);
  switch (event.type) {
    case 'input_audio_buffer.append': {
      if (typeof event.audio !== 'string' || !event.audio.length || event.audio.length > 65536
        || event.audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(event.audio)) {
        throw new Error('Audio PCM no válido.');
      }
      const bytes = Buffer.from(event.audio, 'base64');
      if (bytes.length % 2 || bytes.toString('base64') !== event.audio) throw new Error('Audio PCM no válido.');
      return { type: event.type, audio: event.audio };
    }
    case 'response.cancel':
      return { type: event.type };
    case 'conversation.item.truncate':
      if (typeof event.item_id !== 'string' || !/^item_[a-zA-Z0-9_-]{1,200}$/.test(event.item_id)
        || event.content_index !== 0 || !Number.isInteger(event.audio_end_ms)
        || event.audio_end_ms < 0 || event.audio_end_ms > 3600000) {
        throw new Error('Interrupción no válida.');
      }
      return { type: event.type, item_id: event.item_id, content_index: 0, audio_end_ms: event.audio_end_ms };
    default:
      throw new Error('Evento no permitido.');
  }
}

function authorized(header, token) {
  const actual = Buffer.from(typeof header === 'string' ? header : '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createRelay(config, { connectUpstream } = {}) {
  const upstreamFactory = connectUpstream ?? (() => new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`,
    {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      agent: config.proxy ? new HttpsProxyAgent(config.proxy) : undefined,
      handshakeTimeout: 12000, maxPayload: 2 * 1024 * 1024,
    },
  ));
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', service: 'watch-voice-relay' }));
    } else { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const reject = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (req.url !== '/realtime') return reject('404 Not Found');
    if (!authorized(req.headers.authorization, config.accessToken)) return reject('401 Unauthorized');
    if (wss.clients.size >= config.maxConnections) return reject('503 Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (client) => {
    let upstream;
    let ready = false;
    let finished = false;
    let alive = true;
    let rateStart = Date.now();
    let bytesThisSecond = 0;
    const send = (event) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > 1024 * 1024) { finish(1013, 'Conexión demasiado lenta.'); return; }
      client.send(JSON.stringify(event));
    };
    const finish = (code = 1000, reason = 'Sesión finalizada.') => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); clearTimeout(setupTimeout); clearInterval(heartbeat);
      client.close(code, reason);
      if (upstream?.readyState === WebSocket.OPEN) upstream.close();
      else if (upstream?.readyState === WebSocket.CONNECTING) upstream.terminate();
    };
    const deadline = setTimeout(() => {
      send({ type: 'relay.error', message: 'Se ha alcanzado el límite de la sesión. Vuelve a conectar.' });
      finish(1000, 'Límite de sesión.');
    }, config.maxSessionSeconds * 1000);
    const setupTimeout = setTimeout(() => {
      send({ type: 'relay.error', message: 'El servicio de voz no respondió a tiempo.' });
      finish(1011, 'Tiempo de conexión agotado.');
    }, 15000);
    const heartbeat = setInterval(() => {
      if (!alive) return finish(1001, 'Conexión perdida.');
      alive = false; client.ping();
    }, 15000);
    client.on('pong', () => { alive = true; });
    client.on('close', () => finish());
    client.on('error', () => finish(1011, 'Error de conexión.'));
    client.on('message', (data, binary) => {
      if (finished) return;
      try {
        if (binary) throw new Error('Se esperaba JSON.');
        if (Date.now() - rateStart >= 1000) { rateStart = Date.now(); bytesThisSecond = 0; }
        bytesThisSecond += data.length;
        if (bytesThisSecond > 256 * 1024) throw new Error('Demasiados datos.');
        const event = clientEvent(data.toString());
        if (!ready || upstream?.readyState !== WebSocket.OPEN) throw new Error('El servicio aún no está listo.');
        if (upstream.bufferedAmount > 256 * 1024) throw new Error('Conexión demasiado lenta.');
        upstream.send(JSON.stringify(event));
      } catch {
        send({ type: 'relay.error', message: 'Solicitud no válida o conexión no preparada.' });
        finish(1008, 'Solicitud no válida.');
      }
    });
    try { upstream = upstreamFactory(); }
    catch {
      send({ type: 'relay.error', message: 'No se pudo iniciar el servicio de voz.' });
      finish(1011); return;
    }
    upstream.on('open', () => {
      if (!finished) upstream.send(JSON.stringify(sessionUpdate(config)));
    });
    upstream.on('message', (data) => {
      if (finished) return;
      try {
        const event = JSON.parse(data.toString());
        if (event.type === 'session.updated' && !ready) {
          ready = true; clearTimeout(setupTimeout);
          send({ type: 'relay.ready' });
        }
        if (event.type === 'error') {
          if (event.error?.code === 'response_cancel_not_active') return;
          // Do not forward upstream messages that could include configuration or credentials.
          send({ type: 'relay.error', message: 'El servicio de voz ha devuelto un error. Revisa la configuración y la cuota de API.' });
          finish(1011); return;
        }
        if (/^(response\.|conversation\.item\.|input_audio_buffer\.speech_)/.test(event.type)) send(event);
      } catch { finish(1011, 'Respuesta de voz no válida.'); }
    });
    upstream.on('error', () => {
      send({ type: 'relay.error', message: 'No se pudo conectar con el servicio de voz. Revisa acceso, modelo y cuota.' });
      finish(1011);
    });
    upstream.on('close', () => {
      if (!finished) {
        send({ type: 'relay.error', message: 'El servicio de voz se ha desconectado.' });
        finish(1011);
      }
    });
  });
  return {
    server,
    close: async () => {
      for (const client of wss.clients) client.close(1001, 'Servidor detenido.');
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
