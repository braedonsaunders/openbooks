SELECT
  'posted_journal_out_of_balance'::text AS code,
  'refuse'::text AS severity,
  format('journal entry %s (%s)', bad.entry_number, bad.id) AS subject,
  format(
    'Posted or reversed entry %s sums to %s instead of zero; migration 0380 assumes posted history balances and forbids rewriting it in place.',
    bad.entry_number,
    bad.total
  ) AS detail,
  'Reverse the entry through the ledger API (a reversal entry linking reverses_entry_id) and repost the corrected entry, then rerun the migration.'::text AS remedy
FROM (
  SELECT e.id, e.entry_number, sum(l.amount)::text AS total
  FROM public.journal_entries e
  JOIN public.journal_lines l
    ON l.entry_id = e.id AND l.org_id = e.org_id
  WHERE e.status IN ('posted', 'reversed')
  GROUP BY e.id, e.entry_number
  HAVING sum(l.amount) <> 0
) AS bad
UNION ALL
SELECT
  'posted_journal_without_lines'::text AS code,
  'refuse'::text AS severity,
  format('journal entry %s (%s)', e.entry_number, e.id) AS subject,
  format(
    'Posted or reversed entry %s carries no lines; migration 0380 assumes posted history is complete and forbids rewriting it in place.',
    e.entry_number
  ) AS detail,
  'Void the empty entry through the ledger correction path (reverse and repost with its intended lines, or reverse it away), then rerun the migration.'::text AS remedy
FROM public.journal_entries e
WHERE e.status IN ('posted', 'reversed')
  AND NOT EXISTS (
    SELECT 1 FROM public.journal_lines l
    WHERE l.entry_id = e.id AND l.org_id = e.org_id
  );
