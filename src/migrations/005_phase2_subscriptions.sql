-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 005: Phase 2 Feature 3 — Multi-Tenant SaaS Subscriptions & Billing
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Create Enums if not exists
DO $$ BEGIN
  CREATE TYPE subscription_status AS ENUM (
    'TRIAL',
    'ACTIVE',
    'PAST_DUE',
    'GRACE_PERIOD',
    'HALTED',
    'CANCELLED',
    'EXPIRED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE billing_interval AS ENUM ('MONTHLY', 'YEARLY');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE subscription_invoice_status AS ENUM (
    'DRAFT',
    'PAID',
    'FAILED',
    'REFUNDED'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- 2. Create subscription_plans table
CREATE TABLE IF NOT EXISTS subscription_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  billing_interval VARCHAR(20) NOT NULL DEFAULT 'MONTHLY',
  base_price NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  tax_percentage NUMERIC(5,2) NOT NULL DEFAULT 18.00,
  max_outlets INT NOT NULL DEFAULT 1,
  max_tables_per_outlet INT NOT NULL DEFAULT 10,
  features TEXT NOT NULL DEFAULT '',
  razorpay_plan_id VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Create organization_subscriptions table
CREATE TABLE IF NOT EXISTS organization_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES subscription_plans(id),
  status VARCHAR(30) NOT NULL DEFAULT 'TRIAL',
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
  trial_ends_at TIMESTAMPTZ,
  grace_period_ends_at TIMESTAMPTZ,
  razorpay_subscription_id VARCHAR(100),
  razorpay_customer_id VARCHAR(100),
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_org_sub_org_id ON organization_subscriptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_sub_razorpay_id ON organization_subscriptions(razorpay_subscription_id);

-- 4. Create subscription_invoices table
CREATE TABLE IF NOT EXISTS subscription_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES organization_subscriptions(id) ON DELETE CASCADE,
  invoice_number VARCHAR(50) NOT NULL UNIQUE,
  billing_period_start TIMESTAMPTZ NOT NULL,
  billing_period_end TIMESTAMPTZ NOT NULL,
  base_amount NUMERIC(10,2) NOT NULL,
  tax_percentage NUMERIC(5,2) NOT NULL DEFAULT 18.00,
  tax_amount NUMERIC(10,2) NOT NULL DEFAULT 0.00,
  total_amount NUMERIC(10,2) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  razorpay_payment_id VARCHAR(100),
  razorpay_invoice_id VARCHAR(100),
  paid_at TIMESTAMPTZ,
  invoice_pdf_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_invoices_org ON subscription_invoices(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_invoices_number ON subscription_invoices(invoice_number);

-- 5. Create subscription_audit_logs table
CREATE TABLE IF NOT EXISTS subscription_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action VARCHAR(100) NOT NULL,
  actor VARCHAR(100),
  reason TEXT,
  metadata JSONB,
  idempotency_key VARCHAR(150),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sub_audit_org ON subscription_audit_logs(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sub_audit_idempotency ON subscription_audit_logs(idempotency_key);

-- 6. Seed Default Plans if not present
INSERT INTO subscription_plans (id, code, name, description, billing_interval, base_price, currency, tax_percentage, max_outlets, max_tables_per_outlet, features)
VALUES 
  ('11111111-1111-1111-1111-111111111101', 'STARTER', 'Starter Plan', 'For single-outlet cafes and QSRs', 'MONTHLY', 1499.00, 'INR', 18.00, 1, 15, 'QR_ORDERING,KDS'),
  ('11111111-1111-1111-1111-111111111102', 'GROWTH', 'Growth Plan', 'For growing multi-table dine-in restaurants', 'MONTHLY', 2999.00, 'INR', 18.00, 3, 40, 'QR_ORDERING,KDS,INVENTORY,ANALYTICS'),
  ('11111111-1111-1111-1111-111111111103', 'ENTERPRISE', 'Enterprise Plan', 'For restaurant chains and franchises', 'MONTHLY', 5999.00, 'INR', 18.00, -1, -1, 'QR_ORDERING,KDS,INVENTORY,ANALYTICS,MULTI_OUTLET,ADVANCED_REPORTS')
ON CONFLICT (code) DO NOTHING;
