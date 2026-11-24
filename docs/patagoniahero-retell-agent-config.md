# Retell — PatagoniaHero Inbound Agent configuration

Exact, ready-to-apply configuration for the **PatagoniaHero** (`PH`) inbound agent.
It mirrors the proven Himalayan Wonders (HW) agent structure
([retell-agent-config.md](./retell-agent-config.md)) and changes **only
brand-specific content** (greeting, prompt, packages). The backend, the 10 tools,
and both URLs are shared and unchanged.

> **Nothing here has been applied to any live Retell agent.** Creating the agent,
> attaching tools, and assigning the phone number are Retell **dashboard**
> actions (the conversation-flow builder is not safely reconstructable via a single
> API call — same as HW). This document is the exact values to paste in. The agent
> must **never** claim a booking succeeded unless the backend returns `booked: true`
> with an `appointment_id`, and must not invent availability, consultant names, or
> CRM data.

## Shared backend — do NOT change

PatagoniaHero reuses the **same** deployed Inbound AI Caller backend as HW. The
backend resolves the brand from the **dialed number** (`+12088125606 → PH`) via the
`INBOUND_BRAND_NUMBERS` config; no PH-specific logic exists or is needed in the
backend.

| Item                             | Value                                                            |
| -------------------------------- | --------------------------------------------------------------- |
| Brand code                       | `PH`                                                            |
| Inbound number (dialed)          | `+12088125606`  (+1 (208) 812-5606)                             |
| Lifecycle + inbound webhook URL  | `https://inboundaicallagent.onrender.com/webhooks/retell`       |
| Custom-functions (tools) URL     | `https://inboundaicallagent.onrender.com/webhooks/retell/functions` |
| Response engine                  | **conversation-flow** (new flow for PH; mirror HW's structure)  |
| HW agent / number                | **untouched** (`+12318310814 → HW`)                             |

> Prerequisite (outside this doc): `INBOUND_BRAND_NUMBERS` in the **Render**
> environment must include `+12088125606=PH` (local `.env` already does). Until the
> production env has this pair, PH calls fall back to the default brand (`HW`).

## What to configure (Retell dashboard)

Create a **new** agent (e.g. `PatagoniaHero Inbound Agent`) with its **own**
conversation flow. Do not clone into, or edit, the HW agent or flow.

### 1. Agent webhook (call lifecycle)

Set the new agent's **Webhook URL** to
`https://inboundaicallagent.onrender.com/webhooks/retell`. This delivers
`call_started`, `call_ended`, `call_analyzed`. The backend verifies the Retell
signature (HMAC-SHA256 with your API key) and acknowledges fast.

- Dashboard: agent → **Webhook settings** → Webhook URL.
- Or, once the agent exists, one API write:
  `PATCH /update-agent/<PH_AGENT_ID>` with
  `{ "webhook_url": "https://inboundaicallagent.onrender.com/webhooks/retell" }`.

### 2. (Optional) Inbound greeting hook

To greet a known caller by name at answer time, set the **inbound webhook** on
`+12088125606` to the same `.../webhooks/retell` URL. The backend answers the
`call_inbound` event with dynamic variables (`caller_known`, `customer_name`,
`existing_owner`, `person_key`). The agent works without this (the `identify_caller`
tool still identifies the caller); it only improves the opening line.

### 3. Phone number assignment

Bind `+12088125606` to the new PH agent as its inbound number. `+12318310814`
stays bound to HW. Each number routes to its own agent; the backend keeps them
apart by brand.

### 4. Conversation-flow custom functions (tools)

In the **Conversation Flow editor** for the PH flow, add each of the **10 tools**
below as a **Custom Function**. These are **byte-identical to HW** — same URL, same
method, same schemas — because the backend dispatches by the function `name` and is
brand-agnostic. **Do not** create PH-specific tool variants.

- **URL (all 10 tools):** `https://inboundaicallagent.onrender.com/webhooks/retell/functions`
- **Method:** POST (Retell signs with your API key; the backend verifies it).
- **Speak during execution:** optional short filler (e.g. "Let me check that").

The backend binds the lead **server-side** from the Retell `call_id`; a lead id in
the arguments is only a hint. A logical failure returns a normal JSON payload (so
the agent responds gracefully), never an HTTP error.

#### The 10 tools (unchanged from HW)

```jsonc
// 1. identify_caller — call FIRST. Resolves the caller from their phone.
{ "name": "identify_caller", "parameters": { "type": "object", "properties": {
  "phone_number": { "type": "string", "description": "Caller's number; omit to use the call's own caller id." }
} } }

// 2. get_lead — fetch details for a known lead.
{ "name": "get_lead", "parameters": { "type": "object", "required": ["lead_id"],
  "properties": { "lead_id": { "type": "string" } } } }

// 3. create_lead — (gated; no confirmed endpoint yet) for a brand-new caller.
{ "name": "create_lead", "parameters": { "type": "object", "properties": {
  "name": {"type":"string"}, "email": {"type":"string"}, "phone": {"type":"string"},
  "destination": {"type":"string"}, "travel_dates": {"type":"string"},
  "travelers": {"type":"string"}, "budget": {"type":"string"},
  "interests": {"type":"string"}, "travel_style": {"type":"string"}, "notes": {"type":"string"} } } }

// 4. update_lead — add collected info to an existing lead (gated; same as create).
{ "name": "update_lead", "parameters": { "type": "object", "properties": {
  "lead_id": {"type":"string"}, "name": {"type":"string"}, "email": {"type":"string"},
  "destination": {"type":"string"}, "travel_dates": {"type":"string"}, "travelers": {"type":"string"},
  "budget": {"type":"string"}, "interests": {"type":"string"}, "travel_style": {"type":"string"}, "notes": {"type":"string"} } } }

// 5. submit_inquiry — NEW caller who does NOT want a consultant, OR when a booking
//    could not be completed. Captures the inquiry and sends it to the new-lead API.
{ "name": "submit_inquiry", "parameters": { "type": "object", "properties": {
  "name": {"type":"string"}, "email": {"type":"string"}, "phone": {"type":"string"},
  "destination": {"type":"string"}, "travel_dates": {"type":"string"}, "travelers": {"type":"string"},
  "budget": {"type":"string"}, "interests": {"type":"string"}, "travel_style": {"type":"string"},
  "inquiry": {"type":"string", "description": "The caller's request in their own words."},
  "consultation_requested": {"type":"boolean"}, "booking_failed": {"type":"boolean"} } } }

// 6. log_issue — EXISTING caller's issue. normal → CRM note; urgent → escalation.
{ "name": "log_issue", "parameters": { "type": "object", "required": ["issue"], "properties": {
  "issue": {"type":"string"},
  "urgency": {"type":"string", "enum": ["normal","urgent"]},
  "request_existing_consultant": {"type":"boolean"} } } }

// 7. add_call_note — free-form note on the lead.
{ "name": "add_call_note", "parameters": { "type": "object", "required": ["note"],
  "properties": { "note": {"type":"string"}, "lead_id": {"type":"string"} } } }

// 8. update_call_outcome — record the final outcome.
{ "name": "update_call_outcome", "parameters": { "type": "object", "required": ["outcome"],
  "properties": { "outcome": {"type":"string"}, "summary": {"type":"string"}, "lead_id": {"type":"string"} } } }

// 9. get_available_slots — availability in the customer's timezone. Call DATE-FIRST
//    (one local day), then read times from the returned slots.
{ "name": "get_available_slots", "parameters": { "type": "object", "required": ["timezone"],
  "properties": { "timezone": {"type":"string", "description": "IANA, e.g. America/Santiago"},
  "date": {"type":"string", "description": "A single local day YYYY-MM-DD"},
  "from": {"type":"string"}, "to": {"type":"string"} } } }

// 10. book_consultation — book. starts_at MUST be an exact value from get_available_slots.
{ "name": "book_consultation", "parameters": { "type": "object",
  "required": ["confirmed","starts_at","meeting_type"], "properties": {
  "confirmed": {"type":"boolean"},
  "starts_at": {"type":"string"},
  "meeting_type": {"type":"string", "enum": ["phone","whatsapp","video"]},
  "timezone": {"type":"string"}, "confirmed_destination": {"type":"string"}, "notes": {"type":"string"} } } }
```

## PatagoniaHero greeting

Set the flow's opening message (begin-message) to:

```
Thank you for calling PatagoniaHero — your specialists for Patagonia and Antarctica
adventures. My name is Sol, and I'm here to help you plan your trip. How can I help
you today?
```

(Keep it warm and short; let the caller interrupt. This is an INBOUND call — the
caller called us.)

## PatagoniaHero agent instructions (global prompt)

Paste into the PH conversation flow's global/agent instructions:

```
You are the Inbound Travel Agent for PatagoniaHero, specialists in Patagonia (Chile
and Argentina — Torres del Paine, the Southern Patagonian Ice Field, El Chaltén) and
Antarctica expeditions. This is an INBOUND call — the customer called you. Greet them
warmly, ask how you can help, and LISTEN first to understand their intent before
doing anything. Be natural and concise; let them interrupt. Do not behave like an
outbound sales call and never say "I'm calling you because…". Never claim an action
(booking, note, lead) succeeded unless the tool result confirms it. Never invent
availability, consultant names, appointment details, prices, or CRM information.

Start by calling identify_caller.

== PATAGONIAHERO PACKAGES ==
You know six PatagoniaHero packages. Recommend the TOP 3 first when they naturally
match the caller's interest, but you can discuss and recommend ALL six.

TOP 3 — priority / best-selling (lead with these when they fit):
  1. Classic W Trek Torres del Paine — 7 Days. The iconic "W" route through Torres
     del Paine: the base of the Towers, French Valley, and Grey Glacier. The most
     popular first trip to Patagonia; great for most fitness levels.
  2. Circuit Torres del Paine — 10 Days. The full "O" circuit around the Paine
     massif — everything in the W plus the remote back side and the John Gardner
     Pass. For travelers who want the complete, quieter circuit.
  3. Patagonia Adventure — 15 Days. A comprehensive journey across highlights of
     Chilean and Argentine Patagonia for travelers who want the fullest experience.

THE OTHER 3 (offer when they match the caller's interest):
  4. 10 Days in Patagonia: Huemul Circuit & Glaciers. A challenging trek including
     the demanding Huemul Circuit with views over the Southern Patagonian Ice Field;
     for experienced, well-prepared hikers.
  5. 6-Day Antarctica Express Cruise. A shorter Antarctic expedition cruise — the
     fast way to reach the white continent for those with limited time.
  6. Antarctic Sea Kayaking. An add-on/specialty Antarctic experience: sea kayaking
     among icebergs and wildlife for the adventurous traveler.

Matching guidance: trekking / Torres del Paine / "the W" → #1; full circuit / remote
/ more time → #2; "see as much as possible" / combined Chile+Argentina → #3; hardcore
trekking / ice field / Huemul → #4; Antarctica, short on time → #5; Antarctica, wants
kayaking/wildlife up close → #6. If unsure, ask one or two questions about their
interests, timeframe, and fitness, then recommend from the TOP 3 first.

== NEW caller (known = false) ==
- Help with their question. Collect only what's relevant and offered: name, phone,
  email, destination/package interest, travel dates, travelers, budget, interests,
  and their inquiry. Do not interrogate; skip anything they don't provide.
- EMAIL: when they give an email, read it back and explicitly confirm it is correct
  before using it ("I have that as a-d-a at example dot com — is that right?"). Only
  treat the email as collected after they confirm.
- Ask whether they'd like to speak with a human travel consultant.
  • If YES: collect what's needed, then handle availability DATE-FIRST:
      1) Ask their city/timezone.
      2) Ask which day works, then call get_available_slots for that single day.
      3) Offer the returned times for that day; if none work, try another day.
      4) Get explicit confirmation of one specific time.
      5) RE-CHECK availability for that day with get_available_slots immediately
         before booking, to be sure the chosen time is still open.
      6) Call book_consultation with the exact starts_at from the slots. Only tell
         them it is booked if the result has booked = true AND an appointment_id is
         returned. If booking does not succeed, tell them it was NOT booked, then
         call submit_inquiry with booking_failed = true so the team can follow up.
  • If NO: call submit_inquiry (consultation_requested = false) to capture their
    inquiry so the team can follow up. This is a good outcome.

== EXISTING caller (known = true) ==
- Greet them by name; if existing_owner is present, acknowledge their consultant.
- If has_existing_consultation is true, do NOT book another one — help with their
  existing booking instead.
- Understand their need:
  • Simple/non-urgent question → call log_issue with the details (urgency "normal").
  • They want their existing consultant → call log_issue with
    request_existing_consultant = true.
  • Urgent problem (e.g. travelling now, booking failure, emergency) → call log_issue
    with urgency "urgent" so it is escalated.
  • Genuinely needs a NEW consultation and has none → availability DATE-FIRST and
    RE-CHECK before booking (same steps and same booked = true + appointment_id rule
    as above).
- Never create a duplicate lead for an existing caller.

End every call naturally, and call update_call_outcome with a short summary.
```

## Security (unchanged from HW)

- Every webhook and tool request is verified with the Retell signature (HMAC-SHA256
  over the raw body, keyed by the API key; 5-minute replay window) — fail closed.
- The API key lives only in the backend env, never in a tool/agent field, logs, or a
  response. Tools return no credentials.
- Confirm Retell sends `x-retell-signature` on custom-function calls in your setup;
  an unsigned tool call returns 401.

## What can / cannot be done via API

- **Can** (one API write, once the agent exists, with your approval): set the PH
  agent `webhook_url`.
- **Dashboard only** (conversation-flow editor): creating the agent + flow, adding
  the 10 custom-function tool nodes, the greeting, the global instructions, and
  binding the phone number — the flow builder is not reconstructable safely via a
  single API call, and these are production actions on your live Retell account.

## Do NOT

- Do not change the shared backend, or add any PH-specific backend logic.
- Do not modify the Himalayan Wonders agent, flow, or number (`+12318310814`).
- Do not publish the PatagoniaHero agent.
- Do not make a live test call.
