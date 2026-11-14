-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 010: Platform Control Centre (Super Admin)
-- Additive and idempotent: only ADD columns / CREATE ... IF NOT EXISTS. Existing rows and data are untouched.
-- New tables are managed by raw SQL in src/platform (no TypeORM entities), so this file is their only schema source.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Restaurant (organization) account lifecycle & verification ───────────────
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status_changed_by varchar(120);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS verification_status varchar(20) NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS verified_by varchar(120);
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS verification_note text;
CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations (status);

-- ── Platform administrators: role + optional explicit permission list ────────
ALTER TABLE staff ADD COLUMN IF NOT EXISTS platform_role varchar(30);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS platform_permissions jsonb;

-- ── Plans: trial length, visibility ──────────────────────────────────────────
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days integer NOT NULL DEFAULT 14;
ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;

-- ── Subscriptions: how it was granted, cancellation detail ───────────────────
ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'GATEWAY';
ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS assigned_by varchar(120);
ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS cancel_reason text;
-- Trials created before this column existed were tagged by the column default; recognise them
UPDATE organization_subscriptions SET source = 'TRIAL'
  WHERE source = 'GATEWAY' AND status = 'TRIAL' AND trial_ends_at IS NOT NULL AND razorpay_subscription_id IS NULL;

-- ── Invoices: gateway detail, failure + refund tracking ──────────────────────
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS gateway varchar(30) NOT NULL DEFAULT 'razorpay';
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS payment_method varchar(30);
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS failure_reason text;
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS refunded_amount_paise bigint NOT NULL DEFAULT 0;
ALTER TABLE subscription_invoices ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

-- ── Platform audit log (append-only) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid,
  actor_name varchar(120),
  actor_email varchar(180),
  actor_role varchar(30),
  action varchar(60) NOT NULL,
  category varchar(30) NOT NULL DEFAULT 'SYSTEM',
  entity_type varchar(40),
  entity_id varchar(100),
  entity_label varchar(200),
  organization_id uuid,
  summary text,
  changes jsonb,
  reason text,
  ip varchar(64),
  user_agent varchar(255),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pal_created ON platform_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pal_action ON platform_audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pal_org ON platform_audit_logs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pal_actor ON platform_audit_logs (actor_id, created_at DESC);

CREATE OR REPLACE FUNCTION platform_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_logs is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_platform_audit_immutable ON platform_audit_logs;
CREATE TRIGGER trg_platform_audit_immutable BEFORE UPDATE OR DELETE ON platform_audit_logs
  FOR EACH ROW EXECUTE FUNCTION platform_audit_immutable();
DROP TRIGGER IF EXISTS trg_platform_audit_no_truncate ON platform_audit_logs;
CREATE TRIGGER trg_platform_audit_no_truncate BEFORE TRUNCATE ON platform_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION platform_audit_immutable();

-- ── Internal notes on a restaurant ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS organization_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  author_id uuid,
  author_name varchar(120),
  body text NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_org_notes_org ON organization_notes (organization_id, created_at DESC);

-- ── Payment gateway webhook ledger ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(30) NOT NULL DEFAULT 'razorpay',
  event_id varchar(150),
  event_type varchar(100),
  status varchar(20) NOT NULL,
  http_status integer,
  error text,
  organization_id uuid,
  payment_id varchar(100),
  signature_valid boolean,
  summary jsonb,
  processing_ms integer,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_received ON webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_status ON webhook_events (status, received_at DESC);

-- ── Sign-in history ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS login_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid,
  email varchar(180),
  success boolean NOT NULL,
  reason varchar(60),
  is_platform_admin boolean NOT NULL DEFAULT false,
  organization_id uuid,
  ip varchar(64),
  user_agent varchar(255),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_events_staff ON login_events (staff_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_events_created ON login_events (created_at DESC);

-- ── Server error log (5xx only; never request bodies or tokens) ──────────────
CREATE TABLE IF NOT EXISTS error_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method varchar(10),
  path varchar(300),
  status integer NOT NULL,
  error_name varchar(100),
  message text,
  stack text,
  user_id uuid,
  organization_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_error_logs_created ON error_logs (created_at DESC);

-- ── Background job history & periodic health samples ─────────────────────────
CREATE TABLE IF NOT EXISTS job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name varchar(60) NOT NULL,
  status varchar(10) NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  result jsonb,
  error text
);
CREATE INDEX IF NOT EXISTS idx_job_runs_name ON job_runs (job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS health_snapshots (
  id bigserial PRIMARY KEY,
  taken_at timestamptz NOT NULL DEFAULT now(),
  db_ok boolean NOT NULL,
  db_latency_ms integer,
  heap_mb integer,
  rss_mb integer,
  api_requests integer,
  api_errors integer,
  p95_ms integer,
  ws_clients integer
);
CREATE INDEX IF NOT EXISTS idx_health_snapshots_taken ON health_snapshots (taken_at DESC);

-- ── Platform settings (secrets are stored AES-256-GCM encrypted) ─────────────
CREATE TABLE IF NOT EXISTS platform_settings (
  key varchar(100) PRIMARY KEY,
  value jsonb,
  encrypted text,
  is_secret boolean NOT NULL DEFAULT false,
  updated_by varchar(120),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Feature availability: global switch + per-restaurant overrides ───────────
CREATE TABLE IF NOT EXISTS feature_flags (
  feature_key varchar(60) PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  description text,
  updated_by varchar(120),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS org_feature_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature_key varchar(60) NOT NULL,
  mode varchar(10) NOT NULL,
  reason text,
  set_by varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, feature_key)
);
INSERT INTO feature_flags (feature_key, enabled, description) VALUES
  ('QR_ORDERING', true, 'Guest QR ordering and the live order flow'),
  ('KDS', true, 'Kitchen display and ticket workflow'),
  ('INVENTORY', true, 'Ingredients, recipes and stock deduction'),
  ('ANALYTICS', true, 'Sales reports and dashboards'),
  ('MULTI_OUTLET', true, 'More than one outlet / branch per brand'),
  ('ADVANCED_REPORTS', true, 'Advanced exports and reports')
ON CONFLICT (feature_key) DO NOTHING;

-- ── Announcements (banners shown inside the merchant console) ────────────────
CREATE TABLE IF NOT EXISTS announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title varchar(200) NOT NULL,
  body text NOT NULL,
  kind varchar(20) NOT NULL DEFAULT 'ANNOUNCEMENT',
  severity varchar(10) NOT NULL DEFAULT 'INFO',
  audience varchar(20) NOT NULL DEFAULT 'ALL',
  organization_ids uuid[] NOT NULL DEFAULT '{}',
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  dismissible boolean NOT NULL DEFAULT true,
  created_by varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements (is_active, starts_at DESC);

-- ── Notification templates, sends and per-recipient delivery ─────────────────
CREATE TABLE IF NOT EXISTS notification_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key varchar(60) NOT NULL UNIQUE,
  name varchar(120) NOT NULL,
  channel varchar(10) NOT NULL DEFAULT 'EMAIL',
  subject varchar(200) NOT NULL,
  body text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  updated_by varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO notification_templates (key, name, channel, subject, body) VALUES
  ('WELCOME', 'Welcome to Pangat', 'EMAIL', 'Welcome to Pangat, {{ownerName}}',
   'Hi {{ownerName}},\n\nYour restaurant {{restaurantName}} is set up on Pangat. Sign in at {{loginUrl}} to finish your setup.\n\nThe Pangat team'),
  ('TRIAL_ENDING', 'Trial ending soon', 'EMAIL', 'Your Pangat trial ends in {{daysLeft}} days',
   'Hi {{ownerName}},\n\nThe free trial for {{restaurantName}} ends on {{endDate}}. Choose a plan in Billing to keep taking orders without interruption.\n\nThe Pangat team'),
  ('SUBSCRIPTION_EXPIRED', 'Subscription expired', 'EMAIL', 'Your Pangat subscription has expired',
   'Hi {{ownerName}},\n\nThe subscription for {{restaurantName}} has expired. Renew your plan in Billing to restore full access.\n\nThe Pangat team'),
  ('PAYMENT_FAILED', 'Payment failed', 'EMAIL', 'We could not collect your Pangat payment',
   'Hi {{ownerName}},\n\nA payment for {{restaurantName}} did not go through. Please update your payment method to avoid interruption.\n\nThe Pangat team'),
  ('PLAN_ASSIGNED', 'Plan activated', 'EMAIL', 'Your Pangat plan is now {{planName}}',
   'Hi {{ownerName}},\n\n{{restaurantName}} is now on the {{planName}} plan until {{endDate}}.\n\nThe Pangat team'),
  ('GENERAL_NOTICE', 'General notice', 'IN_APP', '{{subject}}', '{{message}}')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS platform_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject varchar(200) NOT NULL,
  body text NOT NULL,
  channels text[] NOT NULL DEFAULT '{}',
  audience varchar(20) NOT NULL,
  target_ids uuid[] NOT NULL DEFAULT '{}',
  template_key varchar(60),
  status varchar(15) NOT NULL DEFAULT 'SENDING',
  total integer NOT NULL DEFAULT 0,
  delivered integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_by_name varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_platform_notifications_created ON platform_notifications (created_at DESC);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES platform_notifications(id) ON DELETE CASCADE,
  channel varchar(10) NOT NULL,
  staff_id uuid,
  organization_id uuid,
  recipient_email varchar(180),
  status varchar(12) NOT NULL,
  error text,
  provider_message_id varchar(150),
  rendered_subject varchar(200),
  rendered_body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification ON notification_deliveries (notification_id);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_inbox ON notification_deliveries (staff_id, channel, created_at DESC);

-- ── Platform event feed (signups, failed payments, webhook trouble, tickets...) ─
CREATE TABLE IF NOT EXISTS platform_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type varchar(60) NOT NULL,
  severity varchar(10) NOT NULL DEFAULT 'INFO',
  title varchar(200) NOT NULL,
  detail text,
  organization_id uuid,
  entity_type varchar(40),
  entity_id varchar(100),
  actor_name varchar(120),
  acknowledged_at timestamptz,
  acknowledged_by varchar(120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_platform_events_created ON platform_events (created_at DESC);

-- ── Support & issue management ───────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS support_ticket_seq START 1001;
CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number integer NOT NULL DEFAULT nextval('support_ticket_seq'),
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  restaurant_id uuid,
  reporter_staff_id uuid,
  reporter_name varchar(120),
  reporter_email varchar(180),
  category varchar(20) NOT NULL DEFAULT 'SUPPORT',
  subject varchar(200) NOT NULL,
  description text NOT NULL,
  priority varchar(10) NOT NULL DEFAULT 'MEDIUM',
  status varchar(15) NOT NULL DEFAULT 'OPEN',
  assignee_id uuid,
  assignee_name varchar(120),
  resolution text,
  source varchar(12) NOT NULL DEFAULT 'RESTAURANT',
  first_response_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_org ON support_tickets (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS support_ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  type varchar(20) NOT NULL,
  author_id uuid,
  author_name varchar(120),
  author_kind varchar(10) NOT NULL DEFAULT 'ADMIN',
  body text,
  internal boolean NOT NULL DEFAULT false,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_ticket_events_ticket ON support_ticket_events (ticket_id, created_at);

-- ── Data export history ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS data_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  scope varchar(20) NOT NULL,
  kind varchar(40) NOT NULL,
  requested_by uuid,
  requested_by_name varchar(120),
  status varchar(10) NOT NULL DEFAULT 'COMPLETED',
  row_counts jsonb,
  bytes integer,
  checksum varchar(80),
  filters jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_data_exports_created ON data_exports (created_at DESC);
