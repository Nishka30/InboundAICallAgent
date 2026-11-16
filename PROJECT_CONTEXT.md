# Inbound — Project Context

> **Purpose of this document.** Before any inbound call logic is written, this
> captures the shared architecture across the three systems (CallScheduler,
> Inbound, Guided Boost), the proven patterns worth reusing from CallScheduler,
> the Guided Boost APIs that already exist, what is genuinely missing, the
> intended inbound call lifecycle, and the open decisions that need David's
> confirmation.
>
> **Status:** context/inspection step only. No inbound call flow, AI conversation,
> intent detection, booking, database, or new Guided Boost endpoint is implemented
> here.
>
> **Inspection note.** CallScheduler was inspected directly from the local clone
> at `../CallSchedulerPOC/CallScheduler`. The Guided Boost repository
> (`davidurmann-alt/guided-boost`) was **not** directly accessible in this
> environment (no `gh` CLI; the repo is private). Guided Boost's API surface below
> is therefore documented from **CallScheduler's verified consumer-side
> integration** — field names marked `CONFIRMED` there were validated against the
> live host `https://guided-boost.lovable.app` — plus David's confirmed written
> contract for the `/api/caller/*` routes. These should be re-verified against the
> Guided Boost source when it is available (see §10).

---

## 1. What Inbound is responsible for

Inbound is a **new, headless, standalone backend service** (Node.js + TypeScript +
Express, ESM/NodeNext, strict TS). No frontend. It owns the **telephony / call
side of inbound calls** and nothing else. Its eventual responsibilities:

- Receive inbound Retell calls (webhooks + the inbound call-handling hooks).
- Handle the inbound call lifecycle (started → ongoing → ended → analyzed).
- Identify the caller from their phone number (E.164).
- Talk to Guided Boost to find/create the right lead/person.
- Identify the existing owner/salesperson when there is one.
- Detect caller intent.
- Collect required information conversationally.
- Maintain call / conversation state.
- Capture the transcript and call result.
- Send the relevant inbound call information back to Guided Boost.
- Support CRM/lead integration through Guided Boost's existing APIs.

**Explicitly NOT Inbound's job.** It must not become a second CRM and must not
duplicate Guided Boost's lead/customer/booking/ownership logic. Guided Boost stays
the system of record; Inbound integrates over HTTP only.

**Current scaffold (already in place).** See `src/`:

| File                                                                                                    | Role                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server.ts`                                                                                         | Boot, graceful shutdown, process signal handlers, `EADDRINUSE` guard.                                                                                |
| `src/app.ts`                                                                                            | Express factory: helmet, CORS allowlist, request id/logger, **Retell webhook mounted raw-body-first before `express.json()`**, error + 404 handlers. |
| `src/config/env.ts`                                                                                     | Zod env contract, validated once at boot; secrets optional at startup with single `require*` enforcement points; values never echoed on failure.     |
| `src/routes/retell.routes.ts`                                                                           | `POST /webhooks/retell` with a raw body parser (`type: () => true`).                                                                                 |
| `src/controllers/retellWebhook.controller.ts`                                                           | Maps webhook result → HTTP status (503/401/400/204).                                                                                                 |
| `src/services/retellWebhook.service.ts`                                                                 | **Placeholder**: verify signature → parse envelope → acknowledge. No lifecycle yet.                                                                  |
| `src/integrations/retell/webhookVerify.ts`                                                              | Retell signature verification (HMAC-SHA256 over `rawBody + timestamp`, keyed by the API key; 5-min replay window; constant-time).                    |
| `src/integrations/guidedBoost/client.ts`                                                                | **Placeholder** Guided Boost client: config + header plumbing (`X-Lead-API-Key`, write identity headers); no endpoints called yet.                   |
| `src/routes/health.routes.ts`, `src/services/health.service.ts`, `src/controllers/health.controller.ts` | Health endpoints.                                                                                                                                    |
| `src/middleware/*`, `src/lib/*`                                                                         | requestId, requestLogger, errorHandler, notFound; logger (pino), errors, shutdown.                                                                   |

**Dev port: `3100`** (kept as instructed — `PORT` default in `env.ts` and
`.env` / `.env.example`).

---

## 2. What CallScheduler is responsible for

CallScheduler is the **existing, proven outbound AI calling service**. It is the
reference implementation for Retell + Guided Boost patterns. **It must not be
modified.** Its responsibilities:

- Discover leads to call — two sources:
  - **POLL**: incremental Lead API listing (`GET /api/crm/leads?since=&cursor=`).
  - **QUEUE**: Guided Boost hands off a lead (`GET /api/caller/queue`); Guided
    Boost owns eligibility + the timeout, CallScheduler makes exactly one attempt.
- Decide eligibility, enforce call windows / holds.
- Place the outbound call via Retell (`POST /v2/create-phone-call`), gated behind
  `RETELL_CALLING_ENABLED`.
- Handle the Retell webhook lifecycle (`call_started`, `call_ended`,
  `call_analyzed`) with idempotent, terminal-safe persistence.
- Host the Retell **booking custom-function** tool (`POST /webhooks/retell/booking`)
  so the agent can fetch team slots and book during the call.
- Persist call records, transcripts, recordings, analysis, appointments.
- Write results back to the CRM (call notes for every outcome) and report final
  status to the Guided Boost caller queue.
- Reconciliation, retry/finalization sweeps, deadline monitoring, lead lifecycle
  audit trail.

It uses **Postgres via Prisma** (`LeadProcessing`, `CallRecord`,
`LeadLifecycleEvent`, `IntegrationCursor`, `AppointmentRecord`).

---

## 3. What Guided Boost is responsible for

Guided Boost is a **separate repository** — the customer-facing frontend + CRM. It
is the **system of record** for all lead/customer/business data:

- Lead capture, lead/person data, corrections, questionnaire answers.
- Ownership / salesperson assignment and routing.
- Notes, appointments / booking, availability.
- Phone number validation / E.164 derivation (it returns a `phone` verdict).
- Authentication for service-to-service API calls (the `X-Lead-API-Key` surface).

**Do not** copy its frontend/CRM code into Inbound, and **do not** modify it in
this step. Inbound talks to it over HTTP only.

---

## 4. Interaction between the three systems

```text
                         Retell
                        /      \
             outbound  /        \  inbound
                      /          \
              CallScheduler     Inbound
               (existing)        (new)
                      \          /
                       \        /
                     Guided Boost
                    CRM / Leads (source of truth)
```

- **CallScheduler ↔ Retell:** outbound. Places calls, receives call-lifecycle
  webhooks, serves the in-call booking function.
- **Inbound ↔ Retell:** inbound. Receives inbound call webhooks/hooks and will
  serve its own in-call functions.
- **Both ↔ Guided Boost:** over the same authenticated CRM/Lead API surface.
- **CallScheduler and Inbound are independent services.** They do **not** depend on
  each other at runtime. It is intentional and acceptable that each contains its
  own Retell integration code, because they handle opposite call directions. The
  rule is: **reuse proven patterns, do not create a runtime dependency on
  CallScheduler, and do not invent a divergent implementation.**

---

## 5. Relevant CallScheduler files / patterns (reference, do not modify)

Paths are relative to `../CallSchedulerPOC/CallScheduler/`.

### Retell integration

| File                                          | What to reuse                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/integrations/retell/webhookVerify.ts`    | Signature verification. **Already copied into Inbound** (`src/integrations/retell/webhookVerify.ts`) verbatim as a pattern. HMAC-SHA256 over `rawBody + timestamp`, keyed by `RETELL_API_KEY` (no separate webhook secret), 5-min replay window, constant-time compare, fails closed.                                                                                       |
| `src/integrations/retell/webhookSchemas.ts`   | Zod envelope `{ event, call }`; `call_id` required; `call_status`, `disconnection_reason`, `start/end_timestamp` (ms), `call_analysis`, `transcript`, `transcript_object`, `transcript_with_tool_calls`, `recording_url`, `agent_id`, etc. all `.nullish()` + `.passthrough()`. Directly adaptable for inbound.                                                             |
| `src/integrations/retell/client.ts`           | Outbound REST client (`POST /v2/create-phone-call`). **Single-shot, never retried** (create-call is not idempotent); bearer key only in the header, never logged; pre-flight guards before any network call. Not needed for inbound call-answering, but the _client shape_ (DI `fetch`, Zod boundary, typed errors) is the template for any Retell REST call Inbound makes. |
| `src/integrations/retell/errors.ts`           | `RetellApiError` with `permanent` / `uncertain` classification — reuse the pattern.                                                                                                                                                                                                                                                                                         |
| `src/integrations/retell/outcomeMap.ts`       | `mapRetellResult(payload) -> { status, outcome }`, **defaults everything to UNKNOWN**; telephony outcomes (voicemail/no-answer/busy/invalid/DNC/callback) mapped, business outcomes (interested/booked) deliberately left UNKNOWN.                                                                                                                                          |
| `src/integrations/retell/functionSchemas.ts`  | Zod request schema + arg readers for Retell **custom-function (in-call tool)** calls — the model for inbound conversational tools.                                                                                                                                                                                                                                          |
| `src/integrations/retell/dynamicVariables.ts` | `buildAgentDynamicVariables()` — maps lead context → agent prompt variables (`customer_name`, `brand_name`, `enquired_destination`, timezone hints…), **omission over invention**. Direct template for priming an inbound agent with the identified caller's context.                                                                                                       |

### Webhook routes, controllers, services

| File                                            | What to reuse                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/retell.routes.ts`                   | Raw-body router for both `POST /webhooks/retell` (lifecycle) and `POST /webhooks/retell/booking` (tool), mounted before `express.json()`. Inbound already mirrors the lifecycle route.                                                                                                                                                                                                                                             |
| `src/controllers/retellWebhook.controller.ts`   | Thin controller mapping the HTTP-agnostic result to status codes.                                                                                                                                                                                                                                                                                                                                                                  |
| `src/services/retellWebhook.service.ts`         | **Core lifecycle pattern**: verify → validate → map → persist with terminal-safe, order-independent, idempotent merge keyed on the unique provider call id; secondary effects (CRM note, status report, lifecycle event) never fail the webhook; DB errors throw so the provider retries.                                                                                                                                          |
| `src/services/retellBookingFunction.service.ts` | **Core in-call tool pattern**: same signature auth; **lead bound SERVER-SIDE** from `call.call_id` → `CallRecord` (never trust a lead id in the model args); fresh-availability re-validation; idempotent (returns an existing appointment rather than double-booking); interactive short timeout + no retries so a slow upstream degrades to a spoken fallback. The single most relevant file for inbound conversational booking. |

### Persistence

| File                                                                                     | What to reuse                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                                                                   | `CallRecord` model (provider-neutral; `retellCallId` unique for idempotency; transcript/analysis/recording/`direction`/`customerTz`/`providerMetadata`; CRM-note delivery tracking) and `CallStatus` / `CallOutcome` / `LeadSource` enums. `CallRecord.direction` already exists and can carry `inbound`. |
| `src/repositories/callRecord.repository.ts`                                              | `recordCallAttempt`, `attachProviderCallId`, `recordCallResult`, `computeSafeCallUpdate`, `applyWebhookCallEvent` (terminal-safe merge), `findByRetellCallId`, note-delivery helpers. The idempotent/terminal-safe merge logic is the reuse target.                                                       |
| `src/repositories/leadLifecycle.repository.ts` + `src/services/leadLifecycle.service.ts` | Durable, **non-PII** audit trail pattern (`LeadLifecycleEvent`).                                                                                                                                                                                                                                          |

### Configuration, error handling, platform

| File                                                                                | What to reuse                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/env.ts`                                                                 | Single Zod schema validated at boot; secrets optional at startup; one `require*` enforcement point per integration; values never echoed. **Inbound's `env.ts` already follows this exactly.** |
| `src/lib/logger.ts`, `src/lib/errors.ts`, `src/lib/shutdown.ts`, `src/middleware/*` | Pino logger, error classes, graceful shutdown, requestId/requestLogger/errorHandler — **already mirrored in Inbound.**                                                                        |
| `src/integrations/leadApi/errors.ts`                                                | `LeadApiError` with `permanent`/`retryable` + `classifyStatus()` + `sanitizeLeadApiPath()` — the Guided Boost client error model to reuse.                                                    |

### Docs worth reading in CallScheduler

`docs/retell-integration.md` (verified Retell webhook + create-call contract),
`docs/architecture.md`, `docs/retell-booking-tools.md`, `docs/calendar-integration.md`,
`docs/retell-agent-prompt.md`.

---

## 6. Relevant Guided Boost APIs (existing — reuse, do not duplicate)

Documented from CallScheduler's verified consumer-side clients. Base host:
`https://guided-boost.lovable.app`. Two logical surfaces share the host:
`/api/crm/*` (Lead API) and `/api/caller/*` (caller queue/status). Reference:
`../CallSchedulerPOC/CallScheduler/src/integrations/leadApi/*` and
`.../integrations/guidedBoost/*`.

### Authentication (service-to-service)

- **Reads:** header `X-Lead-API-Key: <key>`. (CallScheduler env `LEAD_API_KEY_CALLER`;
  Inbound env `GUIDED_BOOST_API_KEY`.)
- **Authorized CRM writes:** additionally `X-Agent-Email` and `X-Agent-Name`
  (fixed caller write identity; CallScheduler `CRM_AGENT_EMAIL`/`CRM_AGENT_NAME`,
  Inbound `GUIDED_BOOST_AGENT_EMAIL`/`GUIDED_BOOST_AGENT_NAME`). The
  final-status report sends `X-Lead-API-Key` + `X-Agent-Email`.
- **Public (no auth):** `POST /api/public/lead-forward`.
- No new credential is introduced; Inbound reuses the same key surface.

### Read endpoints (`GET`) — `LeadApiClient`, `CallerQueueClient`

| Endpoint                                           | Purpose                                                                                                                                                     | Notes for inbound                                                                                                                                                           |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/crm/leads?since=&cursor=&brand=&limit=`  | Incremental lead listing.                                                                                                                                   | Outbound discovery; **not** the inbound entry path, but the row shape (incl. `phone`, `whatsapp`, `sales_agent_email`, `person_key`, `lead_status`) is the lead vocabulary. |
| `GET /api/crm/leads/<id>`                          | One lead's full detail: `captured`, `current`, `answers[]`, `phone` verdict, `notes[]`, etc.                                                                | Fetch lead context once the caller is identified.                                                                                                                           |
| `GET /api/crm/persons/<personKey>`                 | Person history: `profile` (identity, counts, salesAgent, leadStatus…), `leads[]`, `appointments[]`, `notes[]`. `personKey` = `email:<addr>` or `lead:<id>`. | Owner/salesperson + history for the identified caller.                                                                                                                      |
| `GET /api/crm/leads/<id>/team-slots?tz=&from=&to=` | Pooled/owner availability.                                                                                                                                  | In-call slot offering (see booking function).                                                                                                                               |
| `GET /api/caller/queue`                            | Next offered queue lead (or empty).                                                                                                                         | Outbound pull model — **not used by inbound.**                                                                                                                              |

### Write endpoints — `CalendarClient`, `CallerStatusClient` (single-shot, not retried)

| Endpoint                             | Purpose                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/crm/appointments/team`    | Book with owner-first/rotation handled **server-side** (`lead_id`, `starts_at`, `meeting_type`, `customer_tz`, `notes`, `booked_by:"caller"`). The caller never assigns the agent itself.                                                                                                                                                                                      |
| `PATCH /api/crm/appointments/<id>`   | Reschedule (`starts_at`) or cancel (`status:"cancelled"`, `cancel_reason`).                                                                                                                                                                                                                                                                                                    |
| `POST /api/crm/leads/<id>/notes`     | Call note for every outcome (`{ kind:"call", note }`) or a lead note (`note`, `note_status?`, `next_followup?`).                                                                                                                                                                                                                                                               |
| `POST /api/public/lead-forward`      | Forward a declining lead to the legacy centre (public, no key).                                                                                                                                                                                                                                                                                                                |
| `POST /api/caller/leads/<id>/status` | **Caller final-status report.** Statuses: `booked`, `reached_no_booking`, `callback_requested`, `no_answer`, `voicemail`, `wrong_number`, `do_not_call`, `call_failed`, `not_attempted`. Same status re-send = safe; a _different_ final status after one is accepted → HTTP 409 (first wins). Also accepts the intermediate `call_in_progress` (one-time deadline extension). |

> **Source caveat.** The `/api/caller/*` routes were **not present** in the Guided
> Boost source clone CallScheduler had; they come from David's confirmed written
> contract. The exact JSON field names for artifact fields on a final status
> (summary/transcript/recording/call id/times) are inferred from the snake_case
> convention and remain a contract ambiguity (see §10).

---

## 7. What can be reused

Reuse as **patterns / copied modules**, never as a runtime dependency on
CallScheduler:

- **Retell signature verification** — already copied (`webhookVerify.ts`).
- **Raw-body-first webhook mounting** — already in place in Inbound `app.ts`.
- **Webhook event Zod schemas** (`webhookSchemas.ts`) — adopt largely as-is.
- **Webhook service shape**: verify → validate → map → idempotent persist; keep
  secondary effects non-fatal; let DB errors trigger provider retry.
- **In-call custom-function pattern** (`retellBookingFunction.service.ts`):
  server-side lead binding by `call_id`, fresh re-validation, idempotency, graceful
  spoken fallbacks, interactive timeouts.
- **Outcome mapping** defaulting to UNKNOWN (`outcomeMap.ts`).
- **Dynamic-variable mapping** with omission-over-invention (`dynamicVariables.ts`).
- **Guided Boost / Lead API client model**: typed, DI `fetch`, Zod boundary
  parsing, bounded retry/backoff on GET (429/5xx/network only), single-shot
  writes, key only in headers and never logged, `LeadApiError` classification.
- **CallRecord persistence model + idempotent terminal-safe merge**
  (`callRecord.repository.ts`, `prisma/schema.prisma`).
- **Lifecycle audit-trail pattern** (non-PII only).
- **Config/env discipline, logger, graceful shutdown, middleware** — already
  mirrored.
- **Existing Guided Boost endpoints in §6** — reuse directly; do not create
  parallel functionality.

---

## 8. What does NOT exist yet (to be added later — not in this step)

**In Inbound (to build later):**

1. **Inbound webhook dispatch + lifecycle.** The current
   `retellWebhook.service.ts` only verifies + acknowledges. Needs real handling of
   inbound events — including Retell's **`call_inbound`** hook (dynamic agent /
   dynamic-variable response at call-answer time), plus `call_started` /
   `call_ended` / `call_analyzed`. CallScheduler only handles the three outbound
   lifecycle events, **not** `call_inbound` — this is net-new.
2. **Caller identification by phone number** — resolve the inbound E.164 to a
   Guided Boost person/lead (which existing GB lookup to use is an open question —
   see §10).
3. **Owner/salesperson identification** from the person/lead record.
4. **Intent detection** (not implemented anywhere yet).
5. **Conversational information collection + conversation/call state** management.
6. **In-call function tools for inbound** (e.g. booking), modeled on
   `retellBookingFunction.service.ts`.
7. **Transcript / call-result capture + send-back to Guided Boost** — an
   inbound-appropriate reporting path. The outbound `POST /api/caller/leads/<id>/status`
   is queue-attempt-oriented; the inbound equivalent (how an inbound call result
   is reported) is undefined.
8. **Real Guided Boost client methods** — the placeholder client lists the planned
   methods but calls nothing. Transport retries/backoff + Zod boundary parsing
   still to be ported.
9. **Persistence layer** — Inbound currently has **no database**. CallRecord-style
   persistence (for idempotency, state, transcript capture) will be needed, but a
   DB is explicitly out of scope for this step.

**In Guided Boost (potential future additions — DO NOT create them now):**

- A phone-number → caller **lookup** endpoint, if none of the existing endpoints
  suffices for inbound identification.
- **Lead/person creation** for an unknown inbound caller (current CRM clients are
  read + append-note + book; no "create person/lead" method is present in the
  consumer code).
- An **inbound call-result reporting** endpoint (distinct from the outbound
  caller-queue final-status report), if the outbound one is not appropriate.

Each of the above needs David's confirmation **before** anything is built, per the
constraints.

---

## 9. Expected inbound call lifecycle (high level, proposed)

```text
Caller dials the Retell inbound number
        |
        v
Retell -> POST /webhooks/retell  (call_inbound hook, at answer time)   [NEW]
   - verify signature (same scheme as outbound)                        [REUSE webhookVerify]
   - read the caller's from_number (E.164)
   - identify caller in Guided Boost by phone                          [NEW: which GB lookup? §10]
       -> found: load lead/person context + current owner/salesperson  [REUSE leadApi/persons]
       -> not found: decide create-vs-anonymous                        [NEW: §10]
   - respond to Retell with the agent + dynamic variables (context)    [REUSE dynamicVariables pattern]
        |
        v
call_started  -> create/open an inbound call record, state = in progress   [NEW persistence]
        |
        v
(During the call) conversational flow:
   - detect intent                                                     [NEW]
   - collect required info                                             [NEW]
   - optional in-call tools (e.g. get slots / book)                    [REUSE booking-function pattern]
        |
        v
call_ended    -> mark telephony-terminal                               [REUSE outcomeMap + merge]
call_analyzed -> capture transcript / analysis / recording / summary   [REUSE webhook merge]
        |
        v
Send inbound result back to Guided Boost                               [NEW: inbound reporting path, §10]
   - write a CRM note for the call                                     [REUSE POST /api/crm/leads/<id>/notes]
   - (if applicable) record booking                                    [REUSE POST /api/crm/appointments/team]
   - report the inbound outcome                                        [NEW endpoint/shape TBD]
```

Properties carried over from CallScheduler: signature verification fails closed;
webhook processing is idempotent and terminal-safe (keyed on the provider call id);
secondary CRM effects never fail the webhook; lead binding for in-call tools is
server-side from `call_id`; non-PII logging and audit only.

---

## 10. Architectural questions that require David's confirmation

1. **Caller identification endpoint.** Which existing Guided Boost API resolves an
   inbound **phone number → person/lead**? The consumer code exposes
   `GET /api/crm/leads/<id>` and `GET /api/crm/persons/<personKey>` (keyed by
   `email:` / `lead:`, not phone) and the listing (by `since`/`cursor`). Is there
   a phone/E.164 search endpoint, or should one be added?
2. **Unknown caller handling.** If the number matches no existing lead/person,
   should Inbound **create** a lead/person in Guided Boost (and via which endpoint —
   none is present in the current consumer code), or handle the call anonymously
   and hand off for manual creation?
3. **Inbound result reporting.** How should an inbound call outcome be reported
   back? Is `POST /api/caller/leads/<id>/status` appropriate for inbound, or is a
   separate inbound reporting endpoint/shape needed? What is the inbound status
   vocabulary (the outbound nine statuses are attempt-oriented)?
4. **Retell inbound configuration.** Is there a dedicated **Retell inbound agent**
   and inbound number already provisioned (`RETELL_AGENT_ID`,
   `RETELL_INBOUND_NUMBER`)? Do we use the `call_inbound` dynamic-agent response,
   and which **dynamic-variable names** does the inbound agent prompt read?
5. **Owner/salesperson routing on inbound.** When an identified caller already has
   an owner, what should the inbound agent do (route/mention/book with that owner)?
   Booking assignment is server-side today — does inbound booking follow the same
   owner-first/rotation rules?
6. **Final-status artifact field names.** The exact JSON field names for
   summary/transcript/recording/call-id/times on the Guided Boost status report are
   inferred (snake_case) and unconfirmed — confirm before sending artifacts.
7. **Persistence.** When Inbound adds a database, is it a separate datastore (it
   must not share CallScheduler's), and what are the retention rules for inbound
   transcripts/recordings (CallScheduler stores transcripts; its schema predates a
   formal retention policy)?
8. **Guided Boost API key scope.** Does the existing `X-Lead-API-Key` caller key
   grant Inbound the reads/writes it needs, or is a distinct inbound key/identity
   wanted for attribution?
9. **Custom-function auth for inbound tools.** Confirm Retell's in-call
   custom-function authentication for the inbound agent (CallScheduler reuses the
   webhook signature scheme and flags this to confirm before go-live).

---

## Environment file rule (process note)

Any add/remove/rename/change of a variable in `.env.example` **must** be mirrored
in `.env` (and vice versa). This step changed **no** environment variables; the two
files were verified to carry the identical set of keys. `.env` is gitignored and
must never be committed, and no secret values appear in this document.
