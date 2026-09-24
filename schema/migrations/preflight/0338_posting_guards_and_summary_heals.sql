-- OpenBooks upgrade preflight for 0338_posting_guards_and_summary_heals.
--
-- Read-only. 0338's sections land successively; the G8 section heals posted
-- documents whose cached open_balance is NULL (backfill: recompute from the
-- posted entry's open-item lines). That recompute raises where the open
-- lines mix currencies against the document currency, so an install
-- carrying such a document would fail the upgrade mid-flight. This
-- preflight names those documents BEFORE anything applies:
--
-- 0338.mixed_currency_open_lines (refuse): a posted document whose
-- open-item lines are not all in the document currency. The operator fixes
-- the lines through the governed amend path (or voids and reissues the
-- document) and re-runs the check. Zero rows means the backfill cannot hit
-- the currency guard.
--
-- 0338.null_open_balance_healed (notice): a posted document with a NULL
-- cached open_balance that 0338 recomputes from its lines. No action
-- required; listed so the operator can see what the upgrade re-derives.
SELECT '0338.mixed_currency_open_lines' AS code,
       'refuse' AS severity,
       format('documents %s (org %s, number %s)', d.id, d.org_id, d.document_number) AS subject,
       format('posted document %s has open-item lines in more than one currency; the 0338 open-balance backfill refuses mixed-currency open items instead of guessing a denomination', d.id) AS detail,
       'Correct the open lines so every open-item line carries the document currency, through the governed amend path — or void and reissue the document — then re-run the upgrade check.' AS remedy
  FROM public.documents d
 WHERE d.status = 'posted'
   AND d.posted_entry_id IS NOT NULL
   AND EXISTS (
         SELECT 1
           FROM public.journal_lines jl
          WHERE jl.entry_id = d.posted_entry_id
            AND jl.org_id = d.org_id
            AND jl.is_open_item
            AND jl.currency IS DISTINCT FROM d.currency
       )
UNION ALL
SELECT '0338.null_open_balance_healed' AS code,
       'notice' AS severity,
       format('documents %s (org %s, number %s)', d.id, d.org_id, d.document_number) AS subject,
       format('posted document %s has a NULL cached open_balance; 0338 recomputes it from the posted entry''s open-item lines', d.id) AS detail,
       'No action required: the upgrade re-derives the cache deterministically from posted lines and applications.' AS remedy
  FROM public.documents d
 WHERE d.status = 'posted'
   AND d.posted_entry_id IS NOT NULL
   AND d.open_balance IS NULL
 LIMIT 51;
