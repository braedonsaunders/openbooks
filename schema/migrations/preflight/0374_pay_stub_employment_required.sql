WITH org_single_sub AS (
  SELECT org_id, min(id::text)::uuid AS only_subsidiary_id
    FROM public.subsidiaries
   GROUP BY org_id
  HAVING count(*) = 1
),
keyed AS (
  SELECT s.org_id, s.id AS stub_id, s.employee_party_id AS worker_party_id,
         COALESCE(d.subsidiary_id, oss.only_subsidiary_id) AS employer_subsidiary_id, s.pay_date
    FROM public.pay_stubs s
    LEFT JOIN public.pay_runs r
      ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
    LEFT JOIN public.documents d
      ON d.org_id = s.org_id AND d.id = s.pay_run_document_id
    LEFT JOIN org_single_sub oss
      ON oss.org_id = s.org_id
   WHERE s.employment_id IS NULL
),
effective AS (
  SELECT k.org_id, k.stub_id, count(DISTINCT e.id) AS candidates
    FROM keyed k
    JOIN public.worker_employments e
      ON e.org_id = k.org_id
     AND e.worker_party_id = k.worker_party_id
     AND e.employer_subsidiary_id = k.employer_subsidiary_id
     AND EXISTS (
       SELECT 1
         FROM public.worker_employment_versions v
        WHERE v.org_id = e.org_id AND v.employment_id = e.id
          AND v.effective_from <= k.pay_date
          AND (v.effective_to IS NULL OR k.pay_date < v.effective_to)
     )
   GROUP BY k.org_id, k.stub_id
),
key_rows AS (
  SELECT k.org_id, k.stub_id, count(DISTINCT e.id) AS key_count
    FROM keyed k
    JOIN public.worker_employments e
      ON e.org_id = k.org_id
     AND e.worker_party_id = k.worker_party_id
     AND e.employer_subsidiary_id = k.employer_subsidiary_id
   GROUP BY k.org_id, k.stub_id
)
SELECT
  '0374.pay_stub_employment_unresolved'::text AS code,
  'refuse'::text AS severity,
  format('org %s, pay stub %s', k.org_id, k.stub_id) AS subject,
  CASE
    WHEN k.employer_subsidiary_id IS NULL
      THEN 'Pay stub has no resolvable pay-run legal entity (missing pay run, or no subsidiary on the run in a multi-subsidiary org); no employment key can be formed and the 0374 backfill cannot cover it.'
    ELSE format('Pay stub has %s employment matches for its worker, pay-run legal entity, and pay date; exactly one is required, and the key already has employment history the 0374 backfill will not touch.', COALESCE(e.candidates, 0))
  END AS detail,
  CASE
    WHEN k.employer_subsidiary_id IS NULL
      THEN 'Link the stub to its pay run and give that run a legal-entity subsidiary (or consolidate to one subsidiary), then rerun the migration.'::text
    ELSE 'Correct the worker employment or effective-date history so the pay-run legal entity and pay date identify exactly one employment, then rerun the migration.'::text
  END AS remedy
FROM keyed k
LEFT JOIN effective e
  ON e.org_id = k.org_id AND e.stub_id = k.stub_id
LEFT JOIN key_rows kr
  ON kr.org_id = k.org_id AND kr.stub_id = k.stub_id
WHERE k.employer_subsidiary_id IS NULL
   OR (COALESCE(kr.key_count, 0) > 0 AND COALESCE(e.candidates, 0) <> 1);
