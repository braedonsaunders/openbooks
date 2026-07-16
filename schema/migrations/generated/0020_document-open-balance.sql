-- documents.open_balance — the amount remaining to settle (NetSuite's "Amount
-- Remaining"), denormalized onto the transaction record so lists can show, sort
-- and filter it without a live join. For a POSTED open-item document it is
-- abs(open-item journal line) − Σ live applications against it; NULL when the
-- concept doesn't apply (non-open-item kinds, drafts) or the document is voided.
--
-- Kept correct by two triggers so every code path (post, apply, unapply, void)
-- stays in sync, mirroring the denormalized-totals pattern. Idempotent.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS open_balance numeric(19, 4);

-- Recompute one document's open balance from its posted entry's open-item line.
CREATE OR REPLACE FUNCTION recompute_document_open_balance(p_doc uuid)
RETURNS void LANGUAGE sql AS $$
  UPDATE documents d SET open_balance = CASE
    WHEN d.status = 'voided' THEN NULL
    ELSE (
      SELECT abs(jl.amount) - coalesce((
        SELECT sum(a.amount) FROM applications a
         WHERE a.to_line_id = jl.id AND a.unapplied_at IS NULL
      ), 0)
        FROM journal_lines jl
       WHERE jl.entry_id = d.posted_entry_id AND jl.is_open_item
       LIMIT 1)
    END
  WHERE d.id = p_doc;
$$;

-- When a document is posted (posted_entry_id set) or voided (status change),
-- recompute its own open balance. pg_trigger_depth() = 0 guard prevents the
-- recompute's own UPDATE from re-firing this trigger.
CREATE OR REPLACE FUNCTION trg_document_open_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM recompute_document_open_balance(NEW.id);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS document_open_balance ON documents;
CREATE TRIGGER document_open_balance
AFTER UPDATE OF posted_entry_id, status ON documents
FOR EACH ROW
WHEN (pg_trigger_depth() = 0
      AND (NEW.posted_entry_id IS DISTINCT FROM OLD.posted_entry_id
           OR NEW.status IS DISTINCT FROM OLD.status))
EXECUTE FUNCTION trg_document_open_balance();

-- When an application changes (payment applied / unapplied / deleted), recompute
-- the target document's open balance.
CREATE OR REPLACE FUNCTION trg_application_open_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_doc uuid;
BEGIN
  SELECT d.id INTO v_doc
    FROM documents d
    JOIN journal_lines jl ON jl.entry_id = d.posted_entry_id
   WHERE jl.id = coalesce(NEW.to_line_id, OLD.to_line_id) AND jl.is_open_item;
  IF v_doc IS NOT NULL THEN
    PERFORM recompute_document_open_balance(v_doc);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS application_open_balance ON applications;
CREATE TRIGGER application_open_balance
AFTER INSERT OR UPDATE OR DELETE ON applications
FOR EACH ROW EXECUTE FUNCTION trg_application_open_balance();

-- Backfill existing posted open-item documents.
UPDATE documents d SET open_balance = ob.val
FROM (
  SELECT jl.entry_id,
         abs(jl.amount) - coalesce((
           SELECT sum(a.amount) FROM applications a
            WHERE a.to_line_id = jl.id AND a.unapplied_at IS NULL), 0) AS val
    FROM journal_lines jl
   WHERE jl.is_open_item
) ob
WHERE ob.entry_id = d.posted_entry_id
  AND d.posted_entry_id IS NOT NULL
  AND d.status <> 'voided';
