-- Down: bill numbers and credit notes are statutory records, so nothing is dropped. Only the append-only protection is lifted.
DROP TRIGGER IF EXISTS trg_tax_documents_immutable ON tax_documents;
DROP TRIGGER IF EXISTS trg_tax_documents_no_truncate ON tax_documents;
DROP FUNCTION IF EXISTS tax_documents_immutable();
