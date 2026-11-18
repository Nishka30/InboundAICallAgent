# Retell — Travel Inbound Agent configuration

Exact configuration to connect the live **Travel Inbound Agent** to this backend.
Grounded in a read-only inspection of the live Retell account (2026-11-18).

> **Nothing here was applied to the live agent.** Modifying the production agent /
> conversation flow is a production change; these are the exact steps + values to
> apply in the Retell dashboard (or, for the agent webhook, via one API call if you
> approve it). The agent must **never** claim a booking succeeded unless the backend
> returns `booked: true`, and must not invent availability, consultant names, or CRM
> data — this is encoded in the instructions below.

## Current state (inspected, read-only)

| Item                   | Value                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| Agent                  | `Travel Inbound Agent` (`agent_5e4c9bea6405eac74e8e41c92b`)                                           |
| Response engine        | **conversation-flow** (`conversation_flow_724d7d7da6e8`) — tools live in the Conversation Flow editor |
| Inbound number         | `+12318310814` (bound to the inbound agent)                                                           |
| Agent `webhook_url`    | **not set** → call lifecycle events are not being delivered yet                                       |
| Number inbound webhook | **not set** (optional; only needed for the dynamic greeting)                                          |

## What to configure

Let `PUBLIC` = the public HTTPS base URL where this service is reachable
(e.g. an ngrok tunnel or the deployed host). Two endpoints matter:

- **Lifecycle + inbound hook:** `POST {PUBLIC}/webhooks/retell`
- **Agent tools (custom functions):** `POST {PUBLIC}/webhooks/retell/functions`

### 1. Agent webhook (call lifecycle)

Set the agent's **Webhook URL** to `{PUBLIC}/webhooks/retell`. This delivers
`call_started`, `call_ended`, `call_analyzed`. The backend verifies the Retell
signature (HMAC-SHA256 with your API key) and acknowledges fast.

- Dashboard: open the agent → **Webhook settings** → Webhook URL = `{PUBLIC}/webhooks/retell`.
- Or via API (only if you approve a production write):
  `PATCH /update-agent/agent_5e4c9bea6405eac74e8e41c92b` with
  `{ "webhook_url": "{PUBLIC}/webhooks/retell" }`.

### 2. (Optional) Inbound greeting hook

To greet a known caller by name at answer time, set the **inbound webhook** on the
number `+12318310814` to `{PUBLIC}/webhooks/retell` as well. The backend answers the
`call_inbound` event with dynamic variables (`caller_known`, `customer_name`,
`existing_owner`, `person_key`). The agent works without this (the `identify_caller`
tool covers identification); it only improves the opening line.

### 3. Conversation-flow custom functions (tools)

In the **Conversation Flow editor** for `conversation_flow_724d7d7da6e8`, add each
tool below as a **Custom Function** with:

- **URL:** `{PUBLIC}/webhooks/retell/functions` (all tools share this one URL; the
  backend dispatches by the function `name`).
- **Method:** POST. Retell signs the request with your API key; the backend
  verifies it (same scheme as the webhook).
- **Speak during execution:** optional short filler (e.g. "Let me check that").

The backend binds the lead **server-side** from the Retell `call_id`; a lead id in
the arguments is only a hint. A logical failure comes back as a normal JSON payload
(so the agent can respond gracefully), never an HTTP error.

#### Tool parameter schemas

```jsonc
// identify_caller — call FIRST. Resolves the caller from their phone.
{ "name": "identify_caller", "parameters": { "type": "object", "properties": {
  "phone_number": { "type": "string", "description": "Caller's number; omit to use the call's own caller id." }
} } }
// returns: { known, caller_type, person_key?, lead_id?, name?, existing_owner?,
//            lead_status?, has_existing_consultation, existing_consultation? }

// get_lead — fetch details for a known lead.
{ "name": "get_lead", "parameters": { "type": "object", "required": ["lead_id"],
  "properties": { "lead_id": { "type": "string" } } } }

// create_lead — (gated; no confirmed endpoint yet) for a brand-new caller.
{ "name": "create_lead", "parameters": { "type": "object", "properties": {
  "name": {"type":"string"}, "email": {"type":"string"}, "phone": {"type":"string"},
  "destination": {"type":"string"}, "travel_dates": {"type":"string"},
  "travelers": {"type":"string"}, "budget": {"type":"string"},
  "interests": {"type":"string"}, "travel_style": {"type":"string"}, "notes": {"type":"string"} } } }

// update_lead — add collected info to an existing lead (gated; same as create).
{ "name": "update_lead", "parameters": { "type": "object", "properties": {
  "lead_id": {"type":"string"}, "name": {"type":"string"}, "email": {"type":"string"},
  "destination": {"type":"string"}, "travel_dates": {"type":"string"}, "travelers": {"type":"string"},
  "budget": {"type":"string"}, "interests": {"type":"string"}, "travel_style": {"type":"string"}, "notes": {"type":"string"} } } }

// submit_inquiry — NEW caller who does NOT want a consultant, OR when a booking
// could not be completed. Captures the inquiry and sends it to the new-lead API.
{ "name": "submit_inquiry", "parameters": { "type": "object", "properties": {
  "name": {"type":"string"}, "email": {"type":"string"}, "phone": {"type":"string"},
  "destination": {"type":"string"}, "travel_dates": {"type":"string"}, "travelers": {"type":"string"},
  "budget": {"type":"string"}, "interests": {"type":"string"}, "travel_style": {"type":"string"},
  "inquiry": {"type":"string", "description": "The caller's request in their own words."},
  "consultation_requested": {"type":"boolean"}, "booking_failed": {"type":"boolean"} } } }
// returns: { captured, outcome: "sent"|"captured"|"failed", lead_id?, message }

// log_issue — EXISTING caller's issue. normal → CRM note; urgent → escalation.
{ "name": "log_issue", "parameters": { "type": "object", "required": ["issue"], "properties": {
  "issue": {"type":"string"},
  "urgency": {"type":"string", "enum": ["normal","urgent"]},
  "request_existing_consultant": {"type":"boolean"} } } }
// returns: { logged, urgent?, escalated?, message }

// add_call_note — free-form note on the lead.
{ "name": "add_call_note", "parameters": { "type": "object", "required": ["note"],
  "properties": { "note": {"type":"string"}, "lead_id": {"type":"string"} } } }

// update_call_outcome — record the final outcome.
{ "name": "update_call_outcome", "parameters": { "type": "object", "required": ["outcome"],
  "properties": { "outcome": {"type":"string"}, "summary": {"type":"string"}, "lead_id": {"type":"string"} } } }

// get_available_slots — availability in the customer's timezone.
{ "name": "get_available_slots", "parameters": { "type": "object", "required": ["timezone"],
  "properties": { "timezone": {"type":"string", "description": "IANA, e.g. Asia/Kolkata"},
  "date": {"type":"string", "description": "A single local day YYYY-MM-DD"},
  "from": {"type":"string"}, "to": {"type":"string"} } } }
// returns: { available, slots:[{ starts_at, local }], timezone_label } | { available:false, reason }

// book_consultation — book. starts_at MUST be the exact value from get_available_slots.
{ "name": "book_consultation", "parameters": { "type": "object",
  "required": ["confirmed","starts_at","meeting_type"], "properties": {
  "confirmed": {"type":"boolean"},
  "starts_at": {"type":"string"},
  "meeting_type": {"type":"string", "enum": ["phone","whatsapp","video"]},
  "timezone": {"type":"string"}, "confirmed_destination": {"type":"string"}, "notes": {"type":"string"} } } }
// returns: { booked:true, appointment_id, consultant?, starts_at_local? } | { booked:false, reason, already_has_consultation? }
```

## Agent instructions (global prompt)

Paste into the conversation flow's global/agent instructions:

```
You are the Travel Inbound Agent for Himalayan Wonders. This is an INBOUND call —
the customer called you. Greet them warmly, ask how you can help, and LISTEN first
to understand their intent before doing anything. Be natural and concise; let them
interrupt. Do not behave like an outbound sales call and never say "I'm calling you
because…". Never claim an action (booking, note, lead) succeeded unless the tool
result confirms it. Never invent availability, consultant names, appointment details,
or CRM information.

Start by calling identify_caller.

NEW caller (known = false):
- Help with their question. Collect only what's relevant and offered: name, phone,
  email, destination, travel dates, travelers, budget, interests, and their inquiry.
  Do not interrogate; skip anything they don't provide.
- Ask whether they'd like to speak with a human travel consultant.
  • If YES: collect what's needed, call get_available_slots (ask their city/timezone
    first), offer the returned times, get explicit confirmation, then call
    book_consultation. Only tell them it's booked if the result has booked = true.
    If booking does not succeed, tell them it was NOT booked, then call submit_inquiry
    with booking_failed = true so the team can follow up.
  • If NO: call submit_inquiry (consultation_requested = false) to capture their
    inquiry so the team can follow up. This is a good outcome.

EXISTING caller (known = true):
- Greet them by name; if existing_owner is present, acknowledge their consultant.
- If has_existing_consultation is true, do NOT book another one — help with their
  existing booking instead.
- Understand their need:
  • Simple/non-urgent question → call log_issue with the details (urgency "normal").
  • They want their existing consultant → call log_issue with
    request_existing_consultant = true.
  • Urgent problem (e.g. travelling now, booking failure, emergency) → call log_issue
    with urgency "urgent" so it is escalated.
  • Genuinely needs a NEW consultation and has none → get_available_slots → confirm →
    book_consultation (same booked = true rule).
- Never create a duplicate lead for an existing caller.

End every call by calling update_call_outcome with a short summary.
```

## Security

- Every webhook and tool request is verified with the Retell signature (HMAC-SHA256
  over the raw body, keyed by the API key; 5-minute replay window) — fail closed.
- The API key lives only in the backend env, never in a tool/agent field, logs, or a
  response. Tools return no credentials.
- Confirm that Retell sends `x-retell-signature` on custom-function calls in your
  setup (it does for webhooks); if a tool call arrives unsigned, the backend returns
  401 and the signing expectation must be revisited.

## What can / cannot be done via API

- **Can** (one API write, with your approval): set the agent `webhook_url`.
- **Dashboard only** (conversation-flow editor): adding the custom-function tool
  nodes and the global instructions above — the flow builder is not reconstructable
  safely via a single API call, and editing the live flow is a production change.
