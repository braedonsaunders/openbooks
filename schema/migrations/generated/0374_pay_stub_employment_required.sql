-- OpenBooks forward migration 0374_pay_stub_employment_required.
-- Every payslip must retain the employment that produced it. Legacy stubs
-- predate worker_employments, so this migration first backfills one
-- employment (single open version from the earliest stub pay date) per
-- worker and pay-run legal entity that has no employments at all, then
-- reconstructs legacy nulls only when worker, pay-run legal entity, and
-- pay date identify exactly one effective employment. The preflight refuses
-- only stubs no backfill can legitimately cover (keys with existing
-- history that does not resolve, or stubs with no pay-run legal entity)
-- before this migration can run.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

LOCK TABLE public.pay_stubs IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.worker_employments IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.worker_employment_versions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.upgrade_legacy_provenance IN ACCESS EXCLUSIVE MODE;

-- Backfill (UPGRADE-0374-EMPLOYMENT-BACKFILL): legacy pay stubs predate
-- worker_employments, so their worker and pay-run legal entity resolve to
-- zero employments and the reconstruction below would match nothing. For
-- each such key with NO existing employments at all, create one employment
-- with a single open version effective from the earliest stub pay date, so
-- every legitimately historical stub resolves exactly one employment
-- below. Keys that already have employments are never touched here: their
-- history belongs to the HR path, and stubs their versions do not cover
-- stay for the preflight refusal. The employer subsidiary always comes
-- from the pay runs (never invented): the run document's subsidiary, or —
-- when the run carries none and the org has exactly one subsidiary — that
-- sole subsidiary, which is deterministic, not a guess. Stubs with no
-- resolvable legal entity cannot form a key and stay for the preflight
-- refusal.
WITH org_single_sub AS (
  SELECT org_id, min(id::text)::uuid AS only_subsidiary_id
    FROM public.subsidiaries
   GROUP BY org_id
  HAVING count(*) = 1
),
legacy_keys AS (
  SELECT DISTINCT s.org_id, s.employee_party_id AS worker_party_id,
         COALESCE(d.subsidiary_id, oss.only_subsidiary_id) AS employer_subsidiary_id
    FROM public.pay_stubs s
    JOIN public.pay_runs r
      ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
    JOIN public.documents d
      ON d.org_id = r.org_id AND d.id = r.document_id
    LEFT JOIN org_single_sub oss
      ON oss.org_id = s.org_id
   WHERE s.employment_id IS NULL
     AND COALESCE(d.subsidiary_id, oss.only_subsidiary_id) IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM public.worker_employments e
        WHERE e.org_id = s.org_id
          AND e.worker_party_id = s.employee_party_id
          AND e.employer_subsidiary_id = COALESCE(d.subsidiary_id, oss.only_subsidiary_id)
     )
),
new_employments AS (
  INSERT INTO public.worker_employments (org_id, worker_party_id, employer_subsidiary_id)
  SELECT org_id, worker_party_id, employer_subsidiary_id
    FROM legacy_keys
  RETURNING id, org_id, worker_party_id, employer_subsidiary_id
),
new_versions AS (
  INSERT INTO public.worker_employment_versions
    (org_id, employment_id, version_no, status, effective_from, effective_to)
  SELECT e.org_id, e.id, 1, 'active', first_pay.min_pay_date, NULL
    FROM new_employments e
    JOIN (
      SELECT s.org_id, s.employee_party_id AS worker_party_id,
             COALESCE(d.subsidiary_id, oss.only_subsidiary_id) AS employer_subsidiary_id,
             min(s.pay_date) AS min_pay_date
        FROM public.pay_stubs s
        JOIN public.pay_runs r
          ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
        JOIN public.documents d
          ON d.org_id = r.org_id AND d.id = r.document_id
        LEFT JOIN org_single_sub oss
          ON oss.org_id = s.org_id
       WHERE s.employment_id IS NULL
         AND COALESCE(d.subsidiary_id, oss.only_subsidiary_id) IS NOT NULL
       GROUP BY s.org_id, s.employee_party_id, COALESCE(d.subsidiary_id, oss.only_subsidiary_id)
    ) first_pay
      ON first_pay.org_id = e.org_id
     AND first_pay.worker_party_id = e.worker_party_id
     AND first_pay.employer_subsidiary_id = e.employer_subsidiary_id
  RETURNING id, org_id, employment_id
)
-- The registry primary key is the backfilled row identity, so a replay
-- intentionally converges on the same provenance record. The note names the
-- version rule; readers must not key off it.
INSERT INTO public.upgrade_legacy_provenance (org_id, migration, table_name, row_id, note)
SELECT e.org_id, '0374_pay_stub_employment_required', 'worker_employments', e.id,
       'employment backfilled from legacy pay history (UPGRADE-0374-EMPLOYMENT-BACKFILL): single open version effective from the earliest stub pay date for this worker and pay-run legal entity'
  FROM new_employments e
ON CONFLICT DO NOTHING;

WITH org_single_sub AS (
  SELECT org_id, min(id::text)::uuid AS only_subsidiary_id
    FROM public.subsidiaries
   GROUP BY org_id
  HAVING count(*) = 1
),
resolved AS (
  SELECT s.org_id, s.id AS stub_id, min(e.id::text)::uuid AS employment_id
    FROM public.pay_stubs s
    JOIN public.pay_runs r
      ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
    JOIN public.documents d
      ON d.org_id = r.org_id AND d.id = r.document_id
    LEFT JOIN org_single_sub oss
      ON oss.org_id = s.org_id
    JOIN public.worker_employments e
      ON e.org_id = s.org_id
     AND e.worker_party_id = s.employee_party_id
     AND e.employer_subsidiary_id = COALESCE(d.subsidiary_id, oss.only_subsidiary_id)
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

WITH org_single_sub AS (
  SELECT org_id, min(id::text)::uuid AS only_subsidiary_id
    FROM public.subsidiaries
   GROUP BY org_id
  HAVING count(*) = 1
),
resolved AS (
  SELECT s.org_id, s.id AS stub_id, min(e.id::text)::uuid AS employment_id
    FROM public.pay_stubs s
    JOIN public.pay_runs r
      ON r.org_id = s.org_id AND r.document_id = s.pay_run_document_id
    JOIN public.documents d
      ON d.org_id = r.org_id AND d.id = r.document_id
    LEFT JOIN org_single_sub oss
      ON oss.org_id = s.org_id
    JOIN public.worker_employments e
      ON e.org_id = s.org_id
     AND e.worker_party_id = s.employee_party_id
     AND e.employer_subsidiary_id = COALESCE(d.subsidiary_id, oss.only_subsidiary_id)
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
