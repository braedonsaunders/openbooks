-- open_balance, corrected for BOTH application roles + multi-line docs.
--
-- 0020's recompute only subtracted applications where the doc's line was the
-- TARGET (to_line_id) and read a single open line (LIMIT 1). Two defects:
--   1. A payment / credit / receipt-journal is consumed as the SOURCE
--      (from_line_id) — its open_balance never decremented, so fully-applied
--      vendor credits still displayed fully open.
--   2. A document with several open lines (e.g. a journal with AR and AP
--      legs) only counted the first.
-- open_balance = Σ|open lines| − Σ(applications touching those lines in
-- EITHER role). NULL when the doc has no open lines (not an open-item doc).

CREATE OR REPLACE FUNCTION recompute_document_open_balance(p_doc uuid)
RETURNS void LANGUAGE sql AS $$
  UPDATE documents d SET open_balance = CASE
    WHEN d.status = 'voided' THEN NULL
    ELSE (
      SELECT CASE WHEN count(jl.id) = 0 THEN NULL
             ELSE sum(abs(jl.amount)) - coalesce(sum(ap.applied), 0) END
        FROM journal_lines jl
        LEFT JOIN LATERAL (
          SELECT sum(a.amount) AS applied
            FROM applications a
           WHERE (a.to_line_id = jl.id OR a.from_line_id = jl.id)
             AND a.unapplied_at IS NULL
        ) ap ON true
       WHERE jl.entry_id = d.posted_entry_id AND jl.is_open_item
    )
    END
  WHERE d.id = p_doc;
$$;
--> statement-breakpoint

-- An application settles BOTH documents: the open item (to) and the paying /
-- crediting document (from). Recompute each side's document.
CREATE OR REPLACE FUNCTION trg_application_open_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_doc uuid;
BEGIN
  FOR v_doc IN
    SELECT DISTINCT d.id
      FROM documents d
      JOIN journal_lines jl ON jl.entry_id = d.posted_entry_id
     WHERE jl.is_open_item
       AND jl.id IN (coalesce(NEW.to_line_id, OLD.to_line_id),
                     coalesce(NEW.from_line_id, OLD.from_line_id))
  LOOP
    PERFORM recompute_document_open_balance(v_doc);
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- One-time global recompute now that both roles count.
SELECT recompute_document_open_balance(d.id)
  FROM documents d
 WHERE d.posted_entry_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM journal_lines jl
                WHERE jl.entry_id = d.posted_entry_id AND jl.is_open_item);
