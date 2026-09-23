-- Rehearsal mechanization of the 0296.malformed_remittance_marker remedy
-- (schema/migrations/preflight/0296_payroll_remittance_destination_snapshot.sql).
--
-- Deterministic rule (also named in the preflight remedy text): an operator
-- who knows the true window and parties corrects the marker, or voids the
-- bill — both need live knowledge no SQL can invent. This file takes the
-- tag-removal branch: strip the payrollRemittance tag from exactly the
-- bills the preflight refuses (same scope and violation predicate, never
-- ids), leaving the bill itself untouched. An untagged bill keeps the
-- fail-closed window-overlap refusal until it is correctly re-marked, so
-- nothing is silently marked covered. Bills with valid markers are never
-- touched. Idempotent: a second run matches no bill.
--
-- Self-contained for the rehearsal runner: one transaction as the migration
-- owner with the RLS bypass the forced-RLS catalog otherwise denies.
begin;
set local app.bypass_rls = 'on';
UPDATE public.documents b
   SET custom = b.custom - 'payrollRemittance'
  FROM (SELECT d.id,
               d.custom -> 'payrollRemittance' ->> 'from' AS from_v,
               d.custom -> 'payrollRemittance' ->> 'to' AS to_v,
               d.custom -> 'payrollRemittance' ->> 'partyId' AS party_v,
               d.custom -> 'payrollRemittance' ->> 'filingAccountId' AS filing_v
          FROM public.documents d
         WHERE d.kind = 'vendor_bill'
           AND d.status <> 'voided'
           AND jsonb_typeof(d.custom -> 'payrollRemittance') = 'object'
           AND (d.custom -> 'payrollRemittance') ?| array['from', 'to', 'partyId', 'filingAccountId']) m
 WHERE b.id = m.id
   AND (m.from_v IS NULL
        OR m.from_v !~ '^\d{4}-\d{2}-\d{2}$'
        OR (CASE WHEN m.from_v ~ '^\d{4}-\d{2}-\d{2}$' THEN (
                  substring(m.from_v, 1, 4)::int NOT BETWEEN 1 AND 9999
                  OR substring(m.from_v, 6, 2)::int NOT BETWEEN 1 AND 12
                  OR substring(m.from_v, 9, 2)::int NOT BETWEEN 1 AND 31
                  OR (substring(m.from_v, 6, 2)::int = 2 AND substring(m.from_v, 9, 2)::int > 29)
                  OR (substring(m.from_v, 6, 2)::int IN (4, 6, 9, 11) AND substring(m.from_v, 9, 2)::int > 30)
                  OR (substring(m.from_v, 6, 2)::int = 2 AND substring(m.from_v, 9, 2)::int = 29
                      AND NOT (substring(m.from_v, 1, 4)::int % 4 = 0
                               AND (substring(m.from_v, 1, 4)::int % 100 <> 0
                                    OR substring(m.from_v, 1, 4)::int % 400 = 0))))
             ELSE false END)
        OR m.to_v IS NULL
        OR m.to_v !~ '^\d{4}-\d{2}-\d{2}$'
        OR (CASE WHEN m.to_v ~ '^\d{4}-\d{2}-\d{2}$' THEN (
                  substring(m.to_v, 1, 4)::int NOT BETWEEN 1 AND 9999
                  OR substring(m.to_v, 6, 2)::int NOT BETWEEN 1 AND 12
                  OR substring(m.to_v, 9, 2)::int NOT BETWEEN 1 AND 31
                  OR (substring(m.to_v, 6, 2)::int = 2 AND substring(m.to_v, 9, 2)::int > 29)
                  OR (substring(m.to_v, 6, 2)::int IN (4, 6, 9, 11) AND substring(m.to_v, 9, 2)::int > 30)
                  OR (substring(m.to_v, 6, 2)::int = 2 AND substring(m.to_v, 9, 2)::int = 29
                      AND NOT (substring(m.to_v, 1, 4)::int % 4 = 0
                               AND (substring(m.to_v, 1, 4)::int % 100 <> 0
                                    OR substring(m.to_v, 1, 4)::int % 400 = 0))))
             ELSE false END)
        OR m.party_v IS NULL
        OR m.party_v !~ '^[0-9a-fA-F-]{36}$'
        OR m.party_v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        OR (m.filing_v IS NOT NULL
            AND (m.filing_v !~ '^[0-9a-fA-F-]{36}$'
                 OR m.filing_v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')));
commit;
