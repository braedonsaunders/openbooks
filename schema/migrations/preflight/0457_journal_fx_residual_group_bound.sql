-- OpenBooks upgrade preflight for 0457_journal_fx_residual_group_bound.
-- One row per posted or reversed entry/subsidiary group whose stored
-- transaction evidence already exceeds the per-entry FX rounding bound.
-- Zero rows when the install is ready; drafts are excluded because they
-- stay mutable and post through the extended je_check_posted_balance gate.
SELECT '0457.fx_residual_exceeds_group_bound' AS code,
       'refuse' AS severity,
       format('journal entry %s subsidiary %s in organization %s', l.entry_id, l.subsidiary_id, l.org_id) AS subject,
       format('stored FX deviation %s over %s lines exceeds the group bound %s', sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4)))::text, count(*)::text, (count(*) * 0.00005)::text) AS detail,
       'Correct the entry through the ledger API (post a reversal and repost) before retrying the upgrade.' AS remedy
  FROM public.journal_lines l
  JOIN public.journal_entries e ON e.id = l.entry_id
 WHERE e.status IN ('posted', 'reversed')
 GROUP BY l.org_id, l.entry_id, l.subsidiary_id
HAVING sum(abs(l.amount - round(l.txn_amount * l.fx_rate, 4))) > count(*) * 0.00005;
