-- OpenBooks upgrade preflight for 0494_document_tenders.
--
-- The migration backfills every documents.custom.tenders element into the
-- typed table and refuses the upgrade when an element is malformed, so this
-- probe lists the elements that would stop it: a non-object entry, a kind
-- outside the writer set, an account id that is not a uuid, or an amount
-- that is not a positive decimal with at most four places. Zero rows means
-- the backfill is lossless and the upgrade may proceed.
SELECT '0494.malformed_cash_tender' AS code,
       'refuse' AS severity,
       format('documents row %s (org %s, %s) tender %s is not backfillable', d.id, d.org_id, d.document_number, t.pos) AS subject,
       CASE
         WHEN jsonb_typeof(t.t) <> 'object' THEN 'the tender entry is not an object'
         WHEN NOT (t.t->>'kind' IN ('cash', 'card', 'bank')) THEN format('kind %s is outside cash, card, bank', coalesce(t.t->>'kind', 'missing'))
         WHEN (t.t->>'accountId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN 'the tender names no uuid account'
         ELSE format('amount %s is not a positive decimal with at most four places', coalesce(t.t->>'amount', 'missing'))
       END AS detail,
       'Correct the tenders on the draft document (method, clearing or bank account, positive amount), then retry the upgrade.' AS remedy
  FROM public.documents d
  CROSS JOIN LATERAL jsonb_array_elements(d.custom->'tenders') WITH ORDINALITY AS t(t, pos)
 WHERE d.custom ? 'tenders'
   AND (jsonb_typeof(t.t) <> 'object'
     OR NOT (t.t->>'kind' IN ('cash', 'card', 'bank'))
     OR (t.t->>'accountId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     OR (t.t->>'amount') !~ '^[0-9]+(\.[0-9]{1,4})?$'
     OR (t.t->>'amount')::numeric <= 0
     OR (t.t->>'reference' IS NOT NULL AND jsonb_typeof(t.t->'reference') <> 'string'))
 ORDER BY d.org_id, d.id, t.pos
 LIMIT 20;
