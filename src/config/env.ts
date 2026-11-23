import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment contract for the Inbound caller service.
 *
 * Mirrors the CallScheduler (outbound) pattern: a single Zod schema validated
 * once at startup, with values deliberately NEVER echoed on failure, and every
 * provider credential OPTIONAL at startup so the HTTP server and health probes
 * boot without secrets. Each integration has a single `require*` enforcement
 * point (below) that fails loudly, naming the missing variable but not its value.
 *
 * Scope for this scaffolding step: Retell (inbound webhook verification) and the
 * Guided Boost API client. No call logic, no database, no AI conversation yet.
 */

/**
 * An optional variable that is absent when unset OR set to an empty string.
 * `.env.example` ships placeholders like `RETELL_API_KEY=`, which dotenv loads
 * as `''`; plain `.optional()` only covers `undefined`, so an empty placeholder
 * would otherwise fail validation and stop the server booting.
 */
function optionalString() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    z.string().min(1).optional(),
  );
}

/** Splits a comma-separated list into trimmed, non-empty entries. */
const commaList = z.string().transform((value) =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0),
);

/** An https base URL with any trailing slash normalised away. */
function httpsBaseUrl(defaultValue: string, field: string) {
  return z
    .string()
    .url(`${field} must be an absolute URL`)
    .default(defaultValue)
    .refine(
      (value) => value.startsWith('https://'),
      `${field} must use https so credentials are never sent in clear text`,
    )
    .transform((value) => value.replace(/\/+$/, ''));
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3100),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /**
   * Comma-separated browser origin allowlist. Empty means "send no cross-origin
   * access headers", the secure default for a server-to-server service. "*" is
   * rejected.
   */
  CORS_ALLOWED_ORIGINS: commaList
    .default('')
    .refine(
      (origins) => !origins.includes('*'),
      'CORS_ALLOWED_ORIGINS must not contain "*". List explicit origins instead.',
    ),

  // -------------------------------------------------------------------------
  // Retell (inbound). The webhook is signature-verified with the API key —
  // Retell signs webhooks with your API key; there is no separate webhook
  // secret (confirmed from the CallScheduler implementation / Retell SDK).
  // -------------------------------------------------------------------------

  /**
   * Retell REST API base URL. Must be https so the bearer key is never sent in
   * clear text. Kept here so a future inbound call-control client reuses it.
   */
  RETELL_API_BASE_URL: httpsBaseUrl('https://api.retellai.com', 'RETELL_API_BASE_URL'),

  /**
   * Bearer credential for the Retell API, and the key used to VERIFY inbound
   * webhook signatures. Optional at startup; `requireRetellWebhookKey()` is the
   * single enforcement point. Never logged.
   */
  RETELL_API_KEY: optionalString(),

  /** Id of the configured Retell inbound agent. Informational for now. */
  RETELL_AGENT_ID: optionalString(),

  /** Human-readable agent name, informational only (never sent to the API). */
  RETELL_AGENT_NAME: optionalString(),

  /** Registered Retell inbound number (E.164), when applicable. Informational. */
  RETELL_INBOUND_NUMBER: optionalString(),

  /** Per-request timeout for future Retell API calls. */
  RETELL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),

  /**
   * Replay window for inbound webhook signatures, in ms. Matches Retell's SDK
   * default of 5 minutes. A stale timestamp fails verification.
   */
  RETELL_WEBHOOK_REPLAY_WINDOW_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(300_000),

  // -------------------------------------------------------------------------
  // Guided Boost (separate repository, integrated over HTTP only). These mirror
  // the CallScheduler Lead API / caller settings so the same authenticated CRM
  // surface can be reused. NO new Guided Boost endpoints are introduced here.
  // -------------------------------------------------------------------------

  /** Guided Boost host serving `/api/crm/*` and `/api/caller/*`. */
  GUIDED_BOOST_BASE_URL: httpsBaseUrl('https://guided-boost.lovable.app', 'GUIDED_BOOST_BASE_URL'),

  /**
   * Sent as the `X-Lead-API-Key` header. Optional so the server boots without
   * it; `requireGuidedBoostApiKey()` is the single enforcement point. Never
   * logged, never included in an error message.
   */
  GUIDED_BOOST_API_KEY: optionalString(),

  /**
   * Fixed write identity, sent on authorised CRM writes as `X-Agent-Email` /
   * `X-Agent-Name`. Not secrets (an address + a label); kept in config so they
   * are not hard-coded.
   */
  GUIDED_BOOST_AGENT_EMAIL: z.string().min(1).default('inbound-caller@himalayanwonders.com'),
  GUIDED_BOOST_AGENT_NAME: z.string().min(1).default('AI Inbound Caller'),

  /**
   * DEFAULT / fallback brand sent to Guided Boost when the dialed number is not in
   * `INBOUND_BRAND_NUMBERS` (e.g. the single-brand phase). Accepts a brand code
   * (HW, TH, PH, AH) or a domain such as `himalayanwonders.com`. Not a secret.
   */
  GUIDED_BOOST_BRAND: z.string().min(1).default('HW'),

  /**
   * Per-number brand mapping: the number the caller DIALED determines the brand.
   * Comma-separated `<e164>=<brand>` pairs, e.g.
   * `+12318310814=HW,+1555XXXXXXX=TH`. Empty = single-brand mode (every call uses
   * GUIDED_BOOST_BRAND). A dialed number not in a non-empty map falls back to the
   * default brand with a warning (never silently a wrong brand; see `resolveBrand`).
   * Not a secret; the caller's own number is NEVER used for brand.
   */
  INBOUND_BRAND_NUMBERS: optionalString(),

  /** Per-request timeout for Guided Boost API calls. */
  GUIDED_BOOST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),

  /** Retry budget for a single safe request. 0 disables retries entirely. */
  GUIDED_BOOST_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(3),

  // -------------------------------------------------------------------------
  // Persistence (Neon / Postgres). OPTIONAL: when unset the service uses the
  // in-memory call store (local dev / tests). When set, the Postgres-backed
  // repository is used and migrations run at startup. The value is a secret
  // connection string (contains the password) and is NEVER logged.
  // -------------------------------------------------------------------------
  DATABASE_URL: optionalString(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses an environment-like object. Exported for tests; application code should
 * use the `env` singleton below.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    // Values are intentionally omitted so a bad key or URL is never echoed into
    // a log or a crash report.
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}

export const env: Env = parseEnv(process.env);

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/**
 * Whether durable Postgres persistence is enabled. Off in tests (the in-memory
 * store is used for unit tests regardless of a stray DATABASE_URL in the shell),
 * on whenever a connection string is configured.
 */
export const databaseEnabled = Boolean(env.DATABASE_URL) && !isTest;

/**
 * Returns the Postgres connection string, or throws a value-free error. Single
 * enforcement point; the URL (which contains the password) is never echoed.
 */
export function requireDatabaseUrl(source: Env = env): string {
  if (!source.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured; Postgres persistence is unavailable.');
  }
  return source.DATABASE_URL;
}

/**
 * Returns the Retell key used to verify inbound webhook signatures, or throws a
 * value-free error naming the missing variable. Single enforcement point: the
 * server boots without it, but an attempt to verify a webhook fails loudly here.
 */
export function requireRetellWebhookKey(source: Env = env): string {
  if (!source.RETELL_API_KEY) {
    throw new Error('RETELL_API_KEY is not configured; cannot verify Retell webhook signatures.');
  }
  return source.RETELL_API_KEY;
}

/** The Guided Boost client configuration needed to make authenticated calls. */
export interface GuidedBoostConfig {
  baseUrl: string;
  apiKey: string;
  agentEmail: string;
  agentName: string;
  timeoutMs: number;
  maxRetries: number;
}

/**
 * Resolves the Guided Boost configuration, or throws a value-free error naming
 * the missing API key. The base URL and identities always have defaults, so the
 * key is the only thing that can be missing.
 */
export function requireGuidedBoostConfig(source: Env = env): GuidedBoostConfig {
  if (!source.GUIDED_BOOST_API_KEY) {
    throw new Error(
      'GUIDED_BOOST_API_KEY is not configured. Set it in .env before calling Guided Boost.',
    );
  }
  return {
    baseUrl: source.GUIDED_BOOST_BASE_URL,
    apiKey: source.GUIDED_BOOST_API_KEY,
    agentEmail: source.GUIDED_BOOST_AGENT_EMAIL,
    agentName: source.GUIDED_BOOST_AGENT_NAME,
    timeoutMs: source.GUIDED_BOOST_TIMEOUT_MS,
    maxRetries: source.GUIDED_BOOST_MAX_RETRIES,
  };
}

/** Convenience accessor used by the single Guided Boost key enforcement point. */
export function requireGuidedBoostApiKey(source: Env = env): string {
  return requireGuidedBoostConfig(source).apiKey;
}
