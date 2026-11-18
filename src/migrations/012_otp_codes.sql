-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 012: one-time passcodes (email OTP for admin sign-in and sign-up verification).
-- Additive and idempotent. Only a salted HMAC of the code is stored, never the code itself.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose       varchar(30)  NOT NULL,            -- LOGIN | SIGNUP
  identifier    varchar(180) NOT NULL,            -- lower-cased email
  code_hash     varchar(128) NOT NULL,
  attempts      integer      NOT NULL DEFAULT 0,
  expires_at    timestamptz  NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_otp_lookup ON otp_codes (purpose, identifier, created_at DESC);
