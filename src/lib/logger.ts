import pino from 'pino';
import { env, isProduction, isTest } from '../config/env.js';

/**
 * Fields that must never reach the logs. Covers auth headers, provider keys, and
 * the personal data handled on behalf of callers/leads. Mirrors the
 * CallScheduler redaction set, plus the Retell signature header.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-lead-api-key"]',
  'req.headers["x-api-key"]',
  'req.headers["x-retell-signature"]',
  'res.headers["set-cookie"]',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'phone',
  'phoneNumber',
  'email',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.secret',
  '*.phone',
  '*.phoneNumber',
  '*.email',
];

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: REDACTED_PATHS,
    censor: '[REDACTED]',
  },
  base: { service: 'inbound-caller' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  // Pretty output is a local-development convenience only; production emits JSON.
  ...(isProduction || isTest
    ? {}
    : { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:standard' } } }),
});

export type Logger = typeof logger;
