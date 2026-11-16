import { logger } from './logger.js';

/** Hard cap on how long we wait for in-flight work before exiting anyway. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownDependencies {
  /** Stops accepting new connections and resolves once in-flight ones finish. */
  closeServer: () => Promise<void>;
  /** Terminates the process. Injected so the behaviour can be unit tested. */
  exit: (code: number) => void;
  /**
   * Releases any owned resources (DB pool, provider clients). Optional: the
   * scaffold owns none yet, so this is a seam for later steps. A failure here is
   * logged and never blocks the exit.
   */
  disconnect?: () => Promise<void>;
  timeoutMs?: number;
}

/**
 * Builds the graceful-shutdown routine.
 *
 * The HTTP server is closed first so no new request is accepted, then any owned
 * resources are released. The returned function is idempotent — a second signal
 * during shutdown is ignored rather than starting a competing teardown.
 */
export function createShutdownHandler(
  deps: ShutdownDependencies,
): (signal: string) => Promise<void> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'shutdown signal received, closing server');

    // Exit even if a connection refuses to drain.
    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs }, 'graceful shutdown timed out, forcing exit');
      deps.exit(1);
    }, timeoutMs);
    forceExit.unref?.();

    let exitCode = 0;

    try {
      await deps.closeServer();
      logger.info('HTTP server closed');
    } catch (error) {
      exitCode = 1;
      logger.error({ err: toLoggableError(error) }, 'error closing HTTP server');
    }

    if (deps.disconnect) {
      try {
        await deps.disconnect();
        logger.info('resources released');
      } catch (error) {
        exitCode = 1;
        logger.error({ err: toLoggableError(error) }, 'error releasing resources');
      }
    }

    clearTimeout(forceExit);
    deps.exit(exitCode);
  };
}

function toLoggableError(error: unknown): { name: string; message: string } | undefined {
  return error instanceof Error ? { name: error.name, message: error.message } : undefined;
}
