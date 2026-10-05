-- OpenBooks upgrade preflight for 0527_stored_value_entity_fx.
--
-- The migration attributes every stored-value account to a legal entity
-- (source document subsidiary, else root, else sole subsidiary) and prices
-- every entry in the subsidiary functional currency (par, else source
-- document rate, else the rate the source journal posted at), refusing the
-- upgrade when an account cannot be attributed or an entry cannot be
-- priced. This probe lists the rows that would stop it. Zero rows means the
-- backfill is lossless and the upgrade may proceed.
SELECT '0527.unattributable_account' AS code,
       'refuse' AS severity,
       format('stored-value account %s (org %s) cannot be attributed to a legal entity', a.id, a.org_id) AS subject,
       CASE
         WHEN (SELECT count(*) FROM public.subsidiaries s WHERE s.org_id = a.org_id AND s.is_active AND NOT s.is_elimination) > 1
           THEN 'the organization has more than one legal entity and the account names no source document subsidiary'
         ELSE 'the organization has no root subsidiary to fall back to'
       END AS detail,
       'Set the issuing document''s subsidiary on the account''s source document, or give the organization a root subsidiary, then retry the upgrade.' AS remedy
  FROM public.stored_value_accounts a
 WHERE COALESCE(
         (SELECT d.subsidiary_id
            FROM public.documents d
           WHERE d.org_id = a.org_id AND d.id = a.source_document_id),
         (SELECT r.id
            FROM public.subsidiaries r
           WHERE r.org_id = a.org_id AND r.parent_id IS NULL),
         (SELECT s.id
            FROM public.subsidiaries s
           WHERE s.org_id = a.org_id
             AND (SELECT count(*) FROM public.subsidiaries s2 WHERE s2.org_id = a.org_id) = 1
           ORDER BY s.id LIMIT 1)
       ) IS NULL
UNION ALL
SELECT '0527.unpriced_entry' AS code,
       'refuse' AS severity,
       format('stored-value entry %s (org %s, account %s) cannot be priced in the subsidiary functional currency', e.id, e.org_id, e.account_id) AS subject,
       format('the card currency %s differs from the subsidiary base %s and neither the source document nor its journal carries a rate',
         e.currency,
         (SELECT sub.base_currency
            FROM public.stored_value_accounts a
            JOIN public.subsidiaries sub ON sub.org_id = a.org_id AND sub.id = COALESCE(
              (SELECT d.subsidiary_id
                 FROM public.documents d
                WHERE d.org_id = a.org_id AND d.id = a.source_document_id),
              (SELECT r.id
                 FROM public.subsidiaries r
                WHERE r.org_id = a.org_id AND r.parent_id IS NULL),
              (SELECT s.id
                 FROM public.subsidiaries s
                WHERE s.org_id = a.org_id
                  AND (SELECT count(*) FROM public.subsidiaries s2 WHERE s2.org_id = a.org_id) = 1
                ORDER BY s.id LIMIT 1))
           WHERE a.org_id = e.org_id AND a.id = e.account_id)) AS detail,
       'Set the exchange rate on the source document, then retry the upgrade rather than posting the liability at par.' AS remedy
  FROM public.stored_value_entries e
 WHERE COALESCE(
         (SELECT sub.base_currency
            FROM public.stored_value_accounts a
            JOIN public.subsidiaries sub ON sub.org_id = a.org_id AND sub.id = COALESCE(
              (SELECT d.subsidiary_id
                 FROM public.documents d
                WHERE d.org_id = a.org_id AND d.id = a.source_document_id),
              (SELECT r.id
                 FROM public.subsidiaries r
                WHERE r.org_id = a.org_id AND r.parent_id IS NULL),
              (SELECT s.id
                 FROM public.subsidiaries s
                WHERE s.org_id = a.org_id
                  AND (SELECT count(*) FROM public.subsidiaries s2 WHERE s2.org_id = a.org_id) = 1
                ORDER BY s.id LIMIT 1))
           WHERE a.org_id = e.org_id AND a.id = e.account_id),
         e.currency
       ) <> e.currency
   AND NOT EXISTS (
         SELECT 1
           FROM public.documents d
          WHERE d.org_id = e.org_id AND d.id = e.document_id
            AND d.fx_rate IS NOT NULL AND d.fx_rate <> 1
       )
   AND NOT EXISTS (
         SELECT 1
           FROM public.journal_lines jl
          WHERE jl.org_id = e.org_id
            AND jl.entry_id = e.journal_entry_id
            AND jl.currency = e.currency
            AND jl.fx_rate <> 1
       )
 ORDER BY 1, 3
 LIMIT 20;
