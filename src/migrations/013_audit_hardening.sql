-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 013: tamper-resistant restaurant audit log.
--  * more evidence per entry (who, from where, which request)
--  * account-level events that belong to no single outlet (organization_id; restaurant_id may now be empty)
--  * append-only: UPDATE / DELETE / TRUNCATE are rejected by the database itself, like platform_audit_logs
--  * history can no longer vanish with an outlet: the cascading foreign key becomes RESTRICT
-- Additive and idempotent.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS organization_id uuid;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_email varchar(180);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip varchar(64);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent varchar(255);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_id varchar(64);
ALTER TABLE audit_logs ALTER COLUMN restaurant_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_staff_created ON audit_logs (staff_id, created_at DESC);

-- Foreign keys: never let deleting an outlet or a person erase or edit history
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'audit_logs'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) ILIKE '%REFERENCES restaurants%'
  LOOP
    EXECUTE format('ALTER TABLE audit_logs DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_restaurant_restrict') THEN
    ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_restaurant_restrict FOREIGN KEY (restaurant_id) REFERENCES restaurants(id) ON DELETE RESTRICT;
  END IF;
  -- staff_id was ON DELETE SET NULL, which is an UPDATE of an audit row; the name/role/email columns already carry who it was
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'audit_logs'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) ILIKE '%REFERENCES staff%'
  LOOP
    EXECUTE format('ALTER TABLE audit_logs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
CREATE TRIGGER trg_audit_logs_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON audit_logs;
CREATE TRIGGER trg_audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();
