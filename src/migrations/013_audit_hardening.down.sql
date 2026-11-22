-- Down: removes the append-only protection only. Columns are kept (they may hold evidence).
DROP TRIGGER IF EXISTS trg_audit_logs_immutable ON audit_logs;
DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON audit_logs;
DROP FUNCTION IF EXISTS audit_logs_immutable();
