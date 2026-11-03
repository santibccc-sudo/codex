export function readConfig(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${name} debe ser un entero entre ${min} y ${max}.`);
    }
    return value;
  };
  if (!env.OPENAI_API_KEY?.trim()) throw new Error('Falta OPENAI_API_KEY en el servidor.');
  if (!env.WATCH_ACCESS_TOKEN || env.WATCH_ACCESS_TOKEN.length < 32) {
    throw new Error('WATCH_ACCESS_TOKEN debe tener al menos 32 caracteres.');
  }
  return {
    apiKey: env.OPENAI_API_KEY,
    accessToken: env.WATCH_ACCESS_TOKEN,
    host: env.HOST || '127.0.0.1',
    port: integer('PORT', 8787, 0, 65535),
    model: env.REALTIME_MODEL || 'gpt-realtime',
    voice: env.REALTIME_VOICE || 'marin',
    maxSessionSeconds: integer('MAX_SESSION_SECONDS', 900, 1, 3600),
    maxConnections: integer('MAX_CONNECTIONS', 2, 1, 20),
    proxy: env.HTTPS_PROXY || env.https_proxy,
  };
}
