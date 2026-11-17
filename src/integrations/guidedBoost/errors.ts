/**
 * Error model for the Guided Boost client, mirroring CallScheduler's
 * `leadApi/errors.ts`: a typed error that classifies whether a failure is worth
 * retrying, and a path sanitizer so ids never leak into logs.
 */

export type GuidedBoostErrorKind =
  | 'auth' // 401/403 — permanent
  | 'not_found' // 404 — permanent
  | 'client' // other 4xx — permanent
  | 'rate_limit' // 429 — retryable
  | 'server' // 5xx — retryable
  | 'network' // transport/timeout — retryable
  | 'contract'; // response did not match the schema — permanent

const RETRYABLE: ReadonlySet<GuidedBoostErrorKind> = new Set(['rate_limit', 'server', 'network']);

export interface GuidedBoostErrorOptions {
  status?: number;
  path?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

export class GuidedBoostError extends Error {
  readonly kind: GuidedBoostErrorKind;
  readonly status?: number;
  readonly path?: string;
  readonly retryAfterMs?: number;

  constructor(kind: GuidedBoostErrorKind, message: string, options: GuidedBoostErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'GuidedBoostError';
    this.kind = kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.path !== undefined) this.path = options.path;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  get permanent(): boolean {
    return !this.retryable;
  }
}

/** Maps an HTTP status to an error kind. */
export function classifyStatus(status: number): GuidedBoostErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'client';
}

/** Replaces id-like path segments with `:id` so a path is safe to log. */
export function sanitizePath(path: string): string {
  return path
    .replace(/\/[^/?]*%40[^/?]*/gi, '/:personKey') // url-encoded email in a segment
    .replace(/\/(leads|persons|appointments)\/[^/?]+/gi, '/$1/:id');
}
