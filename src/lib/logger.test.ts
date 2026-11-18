import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACTED_PATHS } from './logger.js';

/**
 * Security: secrets and personal data must never reach the logs. We build a pino
 * logger with the SAME redaction config the service uses and assert that the
 * sensitive fields are censored.
 */
function captureLog(payload: Record<string, unknown>): string {
  let output = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      output += String(chunk);
      cb();
    },
  });
  const testLogger = pino({ redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' } }, stream);
  testLogger.info(payload, 'test');
  return output;
}

describe('logger redaction', () => {
  it('redacts provider keys, auth headers and personal data', () => {
    const output = captureLog({
      apiKey: 'super_secret_retell_key',
      secret: 'another_secret',
      phone: '+12318310814',
      email: 'caller@example.com',
      req: {
        headers: {
          authorization: 'Bearer super_secret_retell_key',
          'x-retell-signature': 'v=1,d=abc',
        },
      },
    });

    expect(output).not.toContain('super_secret_retell_key');
    expect(output).not.toContain('another_secret');
    expect(output).not.toContain('+12318310814');
    expect(output).not.toContain('caller@example.com');
    expect(output).toContain('[REDACTED]');
  });

  it('covers the Retell signature and lead-api key headers', () => {
    expect(REDACTED_PATHS).toContain('req.headers["x-retell-signature"]');
    expect(REDACTED_PATHS).toContain('req.headers["x-lead-api-key"]');
    expect(REDACTED_PATHS).toContain('apiKey');
  });
});
