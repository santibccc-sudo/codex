import { readConfig } from './config.js';
import { createRelay } from './relay.js';

try {
  const config = readConfig();
  const relay = createRelay(config);
  relay.server.on('error', () => { console.error('No se pudo abrir el puerto del servidor.'); process.exitCode = 1; });
  relay.server.listen(config.port, config.host, () => {
    console.log(`Servidor de voz preparado en ${config.host}:${config.port}. TLS debe terminar en el proxy de despliegue.`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => relay.close().then(() => process.exit(0)));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
