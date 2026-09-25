-- OpenBooks forward migration 0374_pay_stub_employment_required.
-- Every payslip must retain the employment that produced it. Legacy nulls
-- are reconstructed only when worker, pay-run legal entity, and pay date
-- identify exactly one effective employment; the preflight refuses all
-- zero-match and ambiguous rows before this migration can run.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

LOCK TABLE public.pay_stubs IN ACCESS EXCLUSIVE MODE;

WITH resolved AS (
  SELECT s.org_id, s.id AS stub_id, min(e.id::text)::uuid AS employment_id
    FROM public.pay_stubs s
    JOIN public.pay_runs r
      ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
    JOIN public.documents d
      ON d.org_id = r.org_id AND d.id = r.document_id
    JOIN public.worker_employments e
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
  HAVING count(DISTINCT e.id) = 1
)
-- The registry primary key is the reconstructed row identity, so a replay
-- intentionally converges on the same provenance record.
INSERT INTO public.upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
SELECT org_id, '0374_pay_stub_employment_required', 'pay_stubs', stub_id,
       'employment_id reconstructed from the pay-run legal entity and pay date matched to exactly one effective employment for the recorded worker'
  FROM resolved
ON CONFLICT DO NOTHING;

WITH resolved AS (
  SELECT s.org_id, s.id AS stub_id, min(e.id::text)::uuid AS employment_id
    FROM public.pay_stubs s
    JOIN public.pay_runs r
      ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
    JOIN public.documents d
      ON d.org_id = r.org_id AND d.id = r.document_id
    JOIN public.worker_employments e
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
  HAVING count(DISTINCT e.id) = 1
)
UPDATE public.pay_stubs s
   SET employment_id = r.employment_id
  FROM resolved r
 WHERE s.org_id = r.org_id AND s.id = r.stub_id
   AND s.employment_id IS NULL;

ALTER TABLE public.pay_stubs ALTER COLUMN employment_id SET NOT NULL;
