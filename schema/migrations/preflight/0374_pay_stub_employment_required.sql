WITH unmatched AS (
  SELECT s.org_id, s.id, count(DISTINCT e.id) AS candidates
    FROM public.pay_stubs s
    JOIN public.pay_runs r
      ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
    JOIN public.documents d
      ON d.org_id = r.org_id AND d.id = r.document_id
    LEFT JOIN public.worker_employments e
      ON e.org_id = s.org_id
     AND e.worker_party_id = s.employee_party_id
     AND e.employer_subsidiary_id = d.subsidiary_id
     AND EXISTS (
       SELECT 1
         FROM public.worker_employment_versions v
        WHERE v.org_id = e.org_id AND v.employment_id = e.id
          AND v.effective_from <= s.pay_date
          AND (v.effective_to IS NULL OR s.pay_date < v.effective_to)
     )
   WHERE s.employment_id IS NULL
   GROUP BY s.org_id, s.id
  HAVING count(DISTINCT e.id) <> 1
)
SELECT
  'pay_stub_employment_unresolved'::text AS code,
  'refuse'::text AS severity,
  format('org %s, pay stub %s', org_id, id) AS subject,
  format('Pay stub has %s employment matches for its worker, pay-run legal entity, and pay date; exactly one is required.', candidates) AS detail,
  'Correct the worker employment or effective-date history so the pay-run legal entity and pay date identify exactly one employment, then rerun the migration.'::text AS remedy
FROM unmatched;
