# Inbound Caller — backend service

Headless backend for the **inbound** AI calling experience (a customer dials in).
There is **no frontend** in this project. It is a standalone Node.js + TypeScript
service that will handle an inbound Retell webhook, run the inbound call
lifecycle, identify the caller, detect intent, collect information, and integrate
with **Guided Boost** (a separate repository) over HTTP.

> **Status: scaffold only.** The HTTP server, configuration, health endpoints,
> and a signature-verified **placeholder** Retell webhook are in place. No call
> logic, no AI conversation, no CRM integration, and no database yet.

It is the inbound counterpart to the existing outbound **CallScheduler** service,
and deliberately reuses its proven patterns (see
[Patterns reused from CallScheduler](#patterns-reused-from-callscheduler)).

## Relationship to the other repositories

- **CallScheduler** (sibling service) — the existing **outbound** AI caller. Owns
  the Retell outbound client, webhook verification, call records, and the Guided
  Boost queue/status handoff. This service mirrors its structure; it is **not**
  modified.
- **Guided Boost** (separate repo) — the customer website + CRM + Lead API.
  Integrated over HTTP only via the `GuidedBoostClient`. Its frontend/CRM code is
  **not** copied here, and **no new Guided Boost endpoint** is introduced by this
  scaffold.

## Requirements

- Node.js ≥ 20.11
- npm 10+

## Setup

```bash
npm install
cp .env.example .env   # all provider credentials are optional at startup
npm run dev            # or: npm run build && npm start
```

```bash
curl http://localhost:3100/health
curl -i http://localhost:3100/health/ready
```

The server boots without any Retell or Guided Boost credentials. An integration
fails loudly (naming the missing variable, never its value) only when it is
actually used.

## Endpoints

| Endpoint                | Purpose                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /health`           | Liveness — always 200 while the process can serve requests.                                         |
| `GET /health/ready`     | Readiness — 200 when required dependencies are up (none yet).                                       |
| `POST /webhooks/retell` | **Placeholder** inbound Retell webhook: verifies the signature and acknowledges; no call logic yet. |

The webhook fails closed: `503` if `RETELL_API_KEY` is unset, `401` on a missing
or invalid signature, `400` on an unparseable body, `204` on a verified event
(acknowledged but not yet processed).

## Structure

```
src/
  config/env.ts                        Zod-validated env + Retell/Guided Boost config
  lib/                                 logger (pino + redaction), errors, shutdown
  middleware/                          request id, access logging, errors, 404
  integrations/
    retell/webhookVerify.ts            Retell signature verification (reused)
    guidedBoost/client.ts              placeholder Guided Boost API client
  controllers/                         thin request handlers (health, retell webhook)
  services/                            health model, placeholder webhook processing
  routes/                              URL shape only (health, retell, index)
  app.ts                               Express wiring
  server.ts                            startup, signals, graceful shutdown
```

Dependencies point one way: routes → controllers → services → integrations.

## Patterns reused from CallScheduler

Referenced from the sibling `../src` (outbound service) and adapted:

- `config/env.ts` — Zod env contract, value-free failures, optional-at-startup
  secrets with single `require*` enforcement points.
- `lib/logger.ts` — pino with sensitive-field redaction (incl. `x-retell-signature`).
- `lib/errors.ts` — `AppError` + consistent JSON error shape.
- `lib/shutdown.ts` — idempotent graceful shutdown (DB disconnect dropped; none yet).
- `middleware/{requestId,requestLogger,errorHandler,notFound}.ts` — verbatim pattern.
- `integrations/retell/webhookVerify.ts` — **reused**; HMAC-SHA256 over
  `rawBody + timestamp`, keyed by the API key, 5-minute replay window, constant-time.
- `routes/retell.routes.ts` + `app.ts` — raw-body webhook mounted **before** the
  JSON parser, so signatures verify over exact bytes.
- `controllers/health.controller.ts` + `services/health.service.ts` — liveness/
  readiness split.

## Not implemented yet (next steps)

Inbound call lifecycle & dispatch, caller/phone identification, intent detection,
information collection, transcript/result handling, the Guided Boost client
methods (identify → context → slots → book → note), a datastore for inbound call
records, and tests.
