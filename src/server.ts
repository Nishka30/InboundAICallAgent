import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env, databaseEnabled } from './config/env.js';
import { logger } from './lib/logger.js';
import { createShutdownHandler } from './lib/shutdown.js';
import { runMigrations } from './db/migrate.js';
import { closePool } from './db/pool.js';

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function registerProcessHandlers(server: Server): void {
  const shutdown = createShutdownHandler({
    closeServer: () => closeServer(server),
    // Release the Postgres pool (if one was created) during graceful shutdown.
    disconnect: () => closePool(),
    exit: (code) => process.exit(code),
  });

  const run = (signal: string): void => {
    void shutdown(signal);
  };

  process.on('SIGTERM', () => {
    run('SIGTERM');
  });
  process.on('SIGINT', () => {
    run('SIGINT');
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal(
      {
        err: reason instanceof Error ? { name: reason.name, message: reason.message } : undefined,
      },
      'unhandled promise rejection',
    );
    run('unhandledRejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: { name: error.name, message: error.message } }, 'uncaught exception');
    run('uncaughtException');
  });
}

async function start(): Promise<void> {
  // Apply database migrations before accepting traffic (idempotent, advisory-locked).
  // Fail loud: a configured-but-unmigratable database should stop the boot rather
  // than silently serve a service that cannot persist. The connection string is
  // never logged.
  if (databaseEnabled) {
    try {
      const { applied } = await runMigrations();
      logger.info(
        { appliedCount: applied.length, ...(applied.length > 0 ? { applied } : {}) },
        'database migrations up to date',
      );
    } catch (error) {
      logger.fatal(
        { err: error instanceof Error ? { name: error.name, message: error.message } : undefined },
        'database migration failed on startup',
      );
      process.exit(1);
    }
  } else {
    logger.warn('DATABASE_URL not set; using in-memory call store (no durable persistence)');
  }

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, nodeEnv: env.NODE_ENV, persistence: databaseEnabled ? 'postgres' : 'memory' },
      'inbound-caller server listening',
    );
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.fatal({ port: env.PORT }, 'port already in use');
    } else {
      logger.fatal({ err: { message: error.message } }, 'HTTP server error');
    }
    process.exit(1);
  });

  registerProcessHandlers(server);
}

void start().catch((error: unknown) => {
  logger.fatal(
    { err: error instanceof Error ? { name: error.name, message: error.message } : undefined },
    'fatal error during startup',
  );
  process.exit(1);
});
