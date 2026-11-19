-- 0001_init — inbound call persistence.
--
-- Three tables mirror the in-memory CallRepository:
--   * inbound_calls    — one row per inbound call (the CallRecord scalars + JSONB
--                        for collected info and sanitized error notes).
--   * call_events      — the lifecycle/event timeline (one row per event) for
--                        tracing and debugging.
--   * processed_events — idempotency keys; a UNIQUE primary key makes
--                        "process each event once" atomic under concurrent
--                        webhook/tool deliveries.
--
-- No secrets are stored. Caller phone/email live here only because the existing
-- inbound flow already keeps them on the call record for tracing + CRM notes.
-- Idempotent: safe to run repeatedly (IF NOT EXISTS throughout).

CREATE TABLE IF NOT EXISTS inbound_calls (
  id                            TEXT        PRIMARY KEY,
  retell_call_id                TEXT        NOT NULL UNIQUE,
  agent_id                      TEXT,
  direction                     TEXT        NOT NULL DEFAULT 'inbound',
  inbound_number                TEXT,
  caller_number                 TEXT,

  status                        TEXT        NOT NULL DEFAULT 'RECEIVED',
  outcome                       TEXT        NOT NULL DEFAULT 'UNKNOWN',

  caller_type                   TEXT        NOT NULL DEFAULT 'UNKNOWN',
  lead_id                       TEXT,
  person_key                    TEXT,
  lead_created                  BOOLEAN     NOT NULL DEFAULT FALSE,

  started_at                    TIMESTAMPTZ,
  ended_at                      TIMESTAMPTZ,
  duration_ms                   INTEGER,

  transcript                    TEXT,
  summary                       TEXT,
  sentiment                     TEXT,
  disconnection_reason          TEXT,
  recording_url                 TEXT,

  booking_status                TEXT        NOT NULL DEFAULT 'NONE',
  appointment_id                TEXT,
  booking_failure_reason        TEXT,

  consultation_requested        BOOLEAN     NOT NULL DEFAULT FALSE,
  requested_existing_consultant BOOLEAN     NOT NULL DEFAULT FALSE,
  inquiry_status                TEXT        NOT NULL DEFAULT 'NONE',
  urgency                       TEXT        NOT NULL DEFAULT 'NORMAL',
  lead_resolved                 BOOLEAN     NOT NULL DEFAULT FALSE,
  has_existing_consultation     BOOLEAN     NOT NULL DEFAULT FALSE,
  owner_email                   TEXT,
  owner_name                    TEXT,

  collected_info                JSONB       NOT NULL DEFAULT '{}'::jsonb,
  errors                        JSONB       NOT NULL DEFAULT '[]'::jsonb,
  crm_updated_at                TIMESTAMPTZ,

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_calls_lead_id    ON inbound_calls (lead_id);
CREATE INDEX IF NOT EXISTS idx_inbound_calls_person_key ON inbound_calls (person_key);
CREATE INDEX IF NOT EXISTS idx_inbound_calls_status     ON inbound_calls (status);
CREATE INDEX IF NOT EXISTS idx_inbound_calls_created_at ON inbound_calls (created_at);
CREATE INDEX IF NOT EXISTS idx_inbound_calls_started_at ON inbound_calls (started_at);

CREATE TABLE IF NOT EXISTS call_events (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  call_id        TEXT        NOT NULL REFERENCES inbound_calls (id) ON DELETE CASCADE,
  retell_call_id TEXT        NOT NULL,
  event_type     TEXT        NOT NULL,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail         JSONB,
  is_error       BOOLEAN     NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_call_events_call_id     ON call_events (call_id);
CREATE INDEX IF NOT EXISTS idx_call_events_retell_call ON call_events (retell_call_id);
CREATE INDEX IF NOT EXISTS idx_call_events_type        ON call_events (event_type);
CREATE INDEX IF NOT EXISTS idx_call_events_at          ON call_events (at);

CREATE TABLE IF NOT EXISTS processed_events (
  retell_call_id TEXT        NOT NULL REFERENCES inbound_calls (retell_call_id) ON DELETE CASCADE,
  event_key      TEXT        NOT NULL,
  processed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (retell_call_id, event_key)
);
