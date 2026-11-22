-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 016: security hardening.
--  * request id on error logs (trace one complaint end to end)
--  * must_change_password: temporary passwords must be replaced at first sign-in
--  * two-factor (TOTP): encrypted secret, enabled flag, replay guard, hashed recovery codes
-- Additive and idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS request_id varchar(64);
CREATE INDEX IF NOT EXISTS idx_error_logs_request ON error_logs (request_id) WHERE request_id IS NOT NULL;

ALTER TABLE staff ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_secret_enc text;                 -- AES-256-GCM, same key as other stored secrets
ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_last_step bigint;                -- last accepted 30-second step: a code cannot be used twice
ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_recovery_hashes jsonb;           -- bcrypt hashes of one-time recovery codes
