'use strict';

const { loadConfig } = require('../../../packages/config');
const { createApp } = require('./app');
const { createHttpServer } = require('./http/server');
const { createLogger } = require('../../../packages/platform/logger');

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const app = createApp(config);
  const server = createHttpServer(app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  app.start();
  logger.info('Listening', {
    url: `http://${config.host}:${config.port}`,
    publicOrigin: config.publicOrigin || null,
    engine: config.engine
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref?.();
    server.close();
    await app.close();
    clearTimeout(force);
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    logger.error('Unhandled rejection', { error: err?.message || String(err) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err?.message || String(err), stack: err?.stack });
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  const logger = createLogger({ level: 'error' });
  logger.error('Failed to start Snagly', { error: err.message, stack: err.stack });
  process.exit(1);
});
