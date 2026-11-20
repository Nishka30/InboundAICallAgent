# Inbound Caller — backend service

Headless backend for the **inbound** AI calling experience (a customer dials the
Travel Inbound number and talks to a Retell voice agent). There is **no frontend**.
It is a standalone Node.js + TypeScript (ESM/NodeNext, strict) service that:

- receives the Retell inbound webhook + call-lifecycle events,
- identifies the caller from their phone number via **Guided Boost**,
- serves the agent's backend **tools** (identify / lead / notes / availability / booking),
- tracks a full inbound call lifecycle and transcript,
- writes the result back to Guided Boost.

It is the inbound counterpart to the outbound **CallScheduler** service and reuses
its proven Retell + Guided Boost patterns, but is an **independent service** with
no runtime dependency on it. See [`PROJECT_CONTEXT.md`](./PROJECT_CONTEXT.md) for
the cross-system architecture.

---

## Data flow

```text
Caller dials the inbound number
  → Retell  →  POST /webhooks/retell      (event: call_inbound)
                 ├ verify signature (fail closed)
                 ├ best-effort identify caller by phone (Guided Boost)
                 └ answer with dynamic_variables (greets a known caller)
  → Retell places the call; the agent converses and calls tools:
       POST /webhooks/retell/functions     (identify_caller, get_lead, create_lead,
                                            update_lead, add_call_note,
                                            update_call_outcome, get_available_slots,
                                            book_consultation)
         └ each is signature-verified and BOUND to the call server-side by call_id
  → Retell lifecycle webhooks: POST /webhooks/retell
       call_started  → open call record (INBOUND_RECEIVED, CALL_STARTED)
       call_ended    → duration, disconnection (CALL_ENDED)
       call_analyzed → transcript, summary, sentiment → finalize CRM note (CALL_ANALYZED, CRM_UPDATED)
```

Dependencies point one way: `routes → controllers → services → integrations`.
All Guided Boost HTTP lives in `GuidedBoostClient`; all Retell signature logic in
`integrations/retell`.

---

## Endpoints

| Endpoint                          | Purpose                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET  /health`                    | Liveness — 200 while the process serves requests.                                                            |
| `GET  /health/ready`              | Readiness — reports required-config presence (no secret values). `not_ready` if `RETELL_API_KEY` is missing. |
| `POST /webhooks/retell`           | Retell inbound hook (`call_inbound`) + lifecycle (`call_started`/`call_ended`/`call_analyzed`).              |
| `POST /webhooks/retell/functions` | The agent's backend tools, dispatched by function `name`.                                                    |

Both webhook routes use a **raw body parser mounted before `express.json()`** so
signatures verify over the exact bytes Retell sent. Fail-closed status codes:
`503` (no `RETELL_API_KEY`), `401` (missing/invalid/stale signature), `400`
(unparseable/invalid payload), `204`/`200` on success.

---

## Agent tools (custom functions)

All tools are called at `POST /webhooks/retell/functions` with the Retell body
`{ call: { call_id, ... }, name, args }`. The lead is always bound **server-side**
from `call_id` — a lead id in `args` is only a hint. A logical failure is returned
to the agent as a normal JSON payload (so it can respond gracefully), never an HTTP
error. **A booking is reported successful only when the payload has `booked: true`.**

| Tool                  | Args (JSON)                                                                                                      | Returns (payload)                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `identify_caller`     | `{ phone_number? }` (falls back to the call's caller number)                                                     | `{ known, caller_type, lead_id?, name?, existing_owner? }`                                     |
| `get_lead`            | `{ lead_id }`                                                                                                    | `{ found, lead_id?, name?, destination?, lead_status?, sales_agent?, person_key? }`            |
| `create_lead`         | `{ name?, email?, phone?, destination?, travel_dates?, travelers?, interests?, budget?, travel_style?, notes? }` | `{ created, lead_id?, already_exists? }`                                                       |
| `update_lead`         | `{ lead_id?, ...same fields }`                                                                                   | `{ updated, lead_id? }`                                                                        |
| `submit_inquiry`      | `{ …lead fields, inquiry?, consultation_requested?, booking_failed? }`                                           | `{ captured, outcome: sent/captured/failed, lead_id?, message }`                               |
| `log_issue`           | `{ issue, urgency?: normal/urgent, request_existing_consultant? }`                                               | `{ logged, urgent?, escalated?, message }`                                                     |
| `add_call_note`       | `{ note, lead_id? }`                                                                                             | `{ added }`                                                                                    |
| `update_call_outcome` | `{ outcome, summary?, lead_id? }`                                                                                | `{ recorded, outcome }`                                                                        |
| `get_available_slots` | `{ timezone, date? \| from?/to? }`                                                                               | `{ available, slots:[{ starts_at, local }], timezone_label }` or `{ available:false, reason }` |
| `book_consultation`   | `{ confirmed, starts_at, meeting_type, timezone?, confirmed_destination?, notes? }`                              | `{ booked:true, appointment_id, consultant?, starts_at_local? }` or `{ booked:false, reason }` |

`meeting_type` is **restricted to `phone` \| `whatsapp` \| `video`**; anything else
(e.g. "travel consultation") is rejected. `starts_at` must be the exact UTC instant
returned by `get_available_slots`, re-validated against fresh availability before booking.

The exact JSON Schemas Retell needs for each tool are in
[Retell configuration](#retell-configuration) and derived from
`src/integrations/retell/functionSchemas.ts`.

---

## Inbound lifecycle events

Recorded on each call record's timeline (honest — only when they actually happen):
`INBOUND_RECEIVED → CALL_STARTED → CALLER_IDENTIFIED → (LEAD_CREATED) →
CONVERSATION via TOOL_CALLED → (BOOKING_ATTEMPTED → BOOKING_CONFIRMED | BOOKING_FAILED)
→ CALL_ENDED → CALL_ANALYZED → CRM_UPDATED | CRM_UPDATE_FAILED`.

Each call record holds: internal id, Retell call id, agent id, inbound/caller
numbers, status, outcome, caller type, lead id, timestamps, duration, transcript,
summary, sentiment, disconnection reason, recording URL, booking status +
appointment id, collected info, the lifecycle timeline, processed-event keys
(idempotency), and sanitized errors.

---

## Environment

Uses the existing `.env` (copy from `.env.example`). **No new variables were added**
by this implementation. Required to actually run calls:

- `RETELL_API_KEY` — verifies every Retell webhook/tool signature (Retell signs with
  the API key; there is no separate webhook secret). The service boots without it but
  `/health/ready` reports `not_ready`.
- `RETELL_AGENT_ID`, `RETELL_INBOUND_NUMBER` — the existing Travel Inbound agent/number.
- `GUIDED_BOOST_API_KEY` (+ `GUIDED_BOOST_BASE_URL`, `GUIDED_BOOST_AGENT_EMAIL/NAME`) —
  the Guided Boost CRM integration. Without it, calls still run but the caller is
  treated as unknown and CRM writes are skipped (recorded locally for follow-up).

Secrets are validated once at boot, never echoed on failure, and never logged.

---

## Running

```bash
npm install
npm run dev            # tsx watch, port 3100
# or
npm run build && npm start
```

```bash
curl http://localhost:3100/health
curl -i http://localhost:3100/health/ready
```

## Scripts

`npm run typecheck` · `npm run lint` · `npm run format` · `npm test` (Vitest) ·
`npm run build`.

---

## Testing

Unit + integration tests (mocked external services; **no paid Retell calls**) under
`src/**/*.test.ts`, run with `npm test`. Coverage: signature verification
(valid/invalid/replay), webhook lifecycle (complete/incomplete/duplicate/failed CRM),
caller identification (lead/customer/unknown/unreachable), lead creation
(success/duplicate-safe/failure), booking (`booked=true`/`false`/missing id/invalid
meeting type), phone normalization, and log redaction (secret never logged).

---

## Security

- Every Retell request (webhook + tools) is HMAC-SHA256 signature-verified over the
  raw bytes, with a replay window; fail closed.
- Secrets come only from env, are never logged (pino redaction covers
  `authorization`, `x-retell-signature`, `x-lead-api-key`, `apiKey`, `phone`, `email`),
  and are never returned to any client or to the agent.
- Server-to-server by default: no wildcard CORS, `helmet`, bounded request bodies.
- The Retell API key is never exposed through any endpoint.

---

## Retell configuration

See the **Live test** section below and the final implementation report for the exact
webhook URLs, tool schemas, and the one in-call auth point to confirm. The Retell
**agent and number already exist**; this service provides the webhook + tool backend
they call. It does not create or modify agents from code.

---

## Persistence (limitation)

The first version stores call records **in process memory** (`callRepository`),
behind a small interface so it can be swapped for a durable store (Postgres/Prisma,
mirroring CallScheduler's `CallRecord`) without changing callers. State does not
live during a call in memory, but the authoritative record is now persisted to
Neon/Postgres (see Persistence), so it survives restarts and spans runs.

## Known follow-ups

- A durable CRM-note retry queue (a failed end-of-call note is recorded locally and in
  Neon, but not auto-retried yet).

### Guided Boost inbound caller APIs (implemented — the authoritative integration)

- `POST /api/caller/inbound/identify` (`identifyInboundCaller`) — one call returns
  known/new, phone-verification, owner, newest lead, booking/consultation state and a
  (non-amount) payment summary. Drives `identify_caller`.
- `POST /api/caller/inbound/inquiries` (`submitInboundInquiry`) — captures a new
  inquiry or an existing guest's question; retry-safe (the API dedups within 30
  minutes). Drives `submit_inquiry`.
- `POST /api/caller/inbound/issues` (`submitInboundIssue`) — logs an existing guest's
  issue to their lead and alerts the owner (admins too when urgent, or when there is no
  owner); **single-shot** (it sends email, so it is never retried). Drives `log_issue`.
- **Lead create / update have no confirmed Guided Boost endpoint.** They are gated
  off (`LEAD_WRITE_ENDPOINTS_CONFIRMED = false` in `guidedBoost/client.ts`): the client
  raises `unsupported` without firing a request, the tools return a graceful
  "captured for follow-up" result, and the collected info is retained on the call
  record. Flip the flag and set the real path/schema once Guided Boost confirms them.
