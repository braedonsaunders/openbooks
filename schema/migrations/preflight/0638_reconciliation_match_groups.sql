-- OpenBooks upgrade preflight for 0638_reconciliation_match_groups.
--
-- Read-only mirror of the pair-unique precheck: duplicate
-- (org, statement, journal) pairs would reject the new
-- recon_matches_pair_claim index. Zero rows means ready.
SELECT '0638.duplicate_match_pair' AS code,
       'refuse' AS severity,
       format('org %s statement %s journal %s: %s rows share the pair',
              a.org_id, a.statement_line_id, a.journal_line_id, a.pairs) AS subject,
       format('reconciliation_matches holds %s rows for org %s statement %s journal %s; the pair must appear once',
              a.pairs, a.org_id, a.statement_line_id, a.journal_line_id) AS detail,
       'Delete the duplicate reconciliation_matches rows (keep one per pair) before applying 0638.' AS remedy
  FROM (SELECT org_id, statement_line_id, journal_line_id, count(*) AS pairs
          FROM public.reconciliation_matches
         GROUP BY org_id, statement_line_id, journal_line_id
        HAVING count(*) > 1) a
 ORDER BY a.org_id, a.statement_line_id, a.journal_line_id
 LIMIT 20;
