-- Pilot readiness: alert delivery outcomes + go-live checklist confirmations. Additive and idempotent.

-- Every email an operator alert tries to send is recorded, with its outcome, so a failure is visible and retryable instead of silently lost.
CREATE TABLE IF NOT EXISTS platform_event_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES platform_events(id) ON DELETE CASCADE,
  channel varchar(10) NOT NULL DEFAULT 'EMAIL',
  recipient varchar(180) NOT NULL DEFAULT '',
  status varchar(10) NOT NULL DEFAULT 'PENDING',          -- PENDING | SENDING | SENT | FAILED
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  provider varchar(20),
  message_id varchar(200),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_event_delivery UNIQUE (event_id, channel, recipient),   -- one email per event per recipient: duplicates are impossible
  CONSTRAINT chk_delivery_status CHECK (status IN ('PENDING','SENDING','SENT','FAILED'))
);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_due ON platform_event_deliveries (status, next_attempt_at);

-- Manual go-live confirmations (QR placed, GST reviewed ...): who confirmed and when. Automatic checks are never stored, they are derived live.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS onboarding jsonb NOT NULL DEFAULT '{}'::jsonb;
