SELECT '0543.adjustment_posting_outside_fiscal_year' AS code, 'notice' AS severity,
 e.entry_number::text AS subject,
 'This journal entry is dated ' || e.posting_date::text || ' but names adjustment period "' || p.name || '" of fiscal year ' || p.fiscal_year::text
   || ', so date-based and period-based reporting place it in different years. It stays as posted; new postings like it will be refused.' AS detail,
 'If the entry belongs to that fiscal year''s close, reverse it and repost it dated inside the fiscal year; otherwise reverse it and repost it to the period that covers its date.' AS remedy
FROM public.journal_entries e
JOIN public.accounting_periods p ON p.org_id = e.org_id AND p.id = e.period_id AND p.is_adjustment
LEFT JOIN LATERAL (
  SELECT min(r.starts_on) AS starts_on, max(r.ends_on) AS ends_on
    FROM public.accounting_periods r
   WHERE r.org_id = p.org_id AND r.fiscal_calendar_id = p.fiscal_calendar_id
     AND r.fiscal_year = p.fiscal_year AND NOT r.is_adjustment
) fy ON true
WHERE e.status IN ('posted', 'reversed')
  AND (e.posting_date < least(p.starts_on, fy.starts_on) OR e.posting_date > greatest(p.ends_on, fy.ends_on))
