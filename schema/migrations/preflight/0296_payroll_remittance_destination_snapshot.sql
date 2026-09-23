-- OpenBooks upgrade preflight for 0296_payroll_remittance_destination_snapshot.
--
-- U1 (REFUSE): read-only mirror of g24's in-migration marker precheck (same
-- wider rule, verified against the final bytes): any live vendor_bill
-- (status <> voided) whose payrollRemittance marker is an object naming at
-- least one of from/to/partyId/filingAccountId refuses when a required
-- field (from/to/partyId) is missing, a value violates its shape, or a
-- shape-valid value cannot cast (impossible calendar date verified
-- field-by-field against ::date semantics, 36-char dash/hex that is not a
-- uuid). One row per (bill, field, complaint). Markers that are not objects,
-- or objects naming none of the four keys, are safe-skipped by the backfill
-- (overlap refusal stands) and surface nothing. Zero U1 rows means the
-- coverage backfill cannot hit a generic cast error.
--
-- U4 (NOTICE): read-only mirror of g24's pack-aware reconciliation (final
-- bytes 126d6d89 after U5, superseding 96d038a4 after PR6b, which supersedes
-- a24896ea in 99247664, which supersedes the U2 line-matching predicate;
-- PR6b is trigger-only (the paired amend+migration authority bypass in
-- pay_stub_line_remittance_guard()) and U5 is lock-only (no-transaction
-- declaration, INVALID-index guard, snapshot FK NOT VALID plus VALIDATE,
-- CONCURRENTLY index builds) — so the mirrored marker precheck, party
-- check, multiset account check, app-row scoping, voided cleanup and
-- 50-capped NOTICE are unchanged. REFUSE unchanged from U1). A live
-- structured-marker bill gains coverage only
-- when its recorded party equals the marker party AND its non-zero lines
-- per (account, net) equal the committed window/party/filing/entity
-- accrual groups per (liability, net with credits negated) in both
-- directions. Each candidate line resolves through the same order the
-- bill-creation path uses: a region-scoped settings key on (component
-- country, systemKey, stub province) first (an unconfigured region
-- resolves NULL and never falls through), then the frozen line snapshot,
-- then the pack default settings key — from the frozen 0296-era map (AU
-- payg_withholding; CA income_tax/cpp/cpp2/ei/qpip/hsf plus QC-region
-- cpp/cpp2/qpip/hsf; IE ie_paye/prsi/usc), only non-empty string settings
-- values counting, text compare both sides. The snapshot column
-- (pay_stub_lines.remittance_party_id) is added BY 0296, so no preflight
-- may reference it: the preflight reads the component's CURRENT vendor
-- instead, which is exactly what the migration's snapshot backfill stamps
-- (SET remittance_party_id = c.remittance_party_id over committed runs and
-- in-scope kinds where the component vendor is NOT NULL). Same rows, same
-- values — the proxy is exact on every pre-0296 install.
-- Bills failing either check get no coverage rows and keep the fail-closed
-- overlap refusal. app-recorded coverage rows (created_by NOT NULL) cannot
-- be referenced: the coverage table is created by 0296 itself, so on every
-- install where this preflight runs it does not exist yet and the exclusion
-- is vacuous (reapply installs from pre-release 0296 builds are dev-only;
-- already-covered bills may be listed — check created_by before acting).
WITH marked AS (
  SELECT b.org_id,
         b.id,
         b.document_number,
         b.party_id AS bill_party,
         b.subsidiary_id,
         b.custom -> 'payrollRemittance' ->> 'from' AS from_v,
         b.custom -> 'payrollRemittance' ->> 'to' AS to_v,
         b.custom -> 'payrollRemittance' ->> 'partyId' AS party_v,
         b.custom -> 'payrollRemittance' ->> 'filingAccountId' AS filing_v
    FROM public.documents b
   WHERE b.kind = 'vendor_bill'
     AND b.status <> 'voided'
     AND jsonb_typeof(b.custom -> 'payrollRemittance') = 'object'
     AND (b.custom -> 'payrollRemittance') ?| array['from', 'to', 'partyId', 'filingAccountId']
),
sane AS (
  SELECT org_id, id, document_number, bill_party, subsidiary_id,
         CASE WHEN from_v ~ '^\d{4}-\d{2}-\d{2}$'
               AND NOT (substring(from_v, 1, 4)::int NOT BETWEEN 1 AND 9999
                        OR substring(from_v, 6, 2)::int NOT BETWEEN 1 AND 12
                        OR substring(from_v, 9, 2)::int NOT BETWEEN 1 AND 31
                        OR (substring(from_v, 6, 2)::int = 2 AND substring(from_v, 9, 2)::int > 29)
                        OR (substring(from_v, 6, 2)::int IN (4, 6, 9, 11) AND substring(from_v, 9, 2)::int > 30)
                        OR (substring(from_v, 6, 2)::int = 2 AND substring(from_v, 9, 2)::int = 29
                            AND NOT (substring(from_v, 1, 4)::int % 4 = 0
                                     AND (substring(from_v, 1, 4)::int % 100 <> 0
                                          OR substring(from_v, 1, 4)::int % 400 = 0))))
              THEN from_v::date END AS from_date,
         CASE WHEN to_v ~ '^\d{4}-\d{2}-\d{2}$'
               AND NOT (substring(to_v, 1, 4)::int NOT BETWEEN 1 AND 9999
                        OR substring(to_v, 6, 2)::int NOT BETWEEN 1 AND 12
                        OR substring(to_v, 9, 2)::int NOT BETWEEN 1 AND 31
                        OR (substring(to_v, 6, 2)::int = 2 AND substring(to_v, 9, 2)::int > 29)
                        OR (substring(to_v, 6, 2)::int IN (4, 6, 9, 11) AND substring(to_v, 9, 2)::int > 30)
                        OR (substring(to_v, 6, 2)::int = 2 AND substring(to_v, 9, 2)::int = 29
                            AND NOT (substring(to_v, 1, 4)::int % 4 = 0
                                     AND (substring(to_v, 1, 4)::int % 100 <> 0
                                          OR substring(to_v, 1, 4)::int % 400 = 0))))
              THEN to_v::date END AS to_date,
         CASE WHEN party_v ~ '^[0-9a-fA-F-]{36}$'
               AND party_v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              THEN party_v::uuid END AS party_id,
         CASE WHEN filing_v IS NOT NULL
               AND filing_v ~ '^[0-9a-fA-F-]{36}$'
               AND filing_v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              THEN filing_v::uuid END AS filing_id,
         (filing_v IS NULL
          OR (filing_v ~ '^[0-9a-fA-F-]{36}$'
              AND filing_v ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')) AS filing_ok
    FROM marked
),
scoped AS (
  SELECT * FROM sane
   WHERE from_date IS NOT NULL AND to_date IS NOT NULL AND party_id IS NOT NULL
     AND filing_ok
),
pack_default_vendor AS (
  -- 0296-era pack-declared vendor settings keys (non-null only), frozen:
  -- copied verbatim from the migration (126d6d89 after U5; PR6b is
  -- trigger-only and U5 lock-only, so the map is unchanged from a24896ea),
  -- parity-pinned there against engine/src/payroll/packs.ts statutoryRemittanceDeclaration.
  SELECT * FROM (VALUES
    ('AU', 'payg_withholding', 'atoRemittancePartyId'),
    ('CA', 'income_tax', 'craRemittancePartyId'),
    ('CA', 'cpp', 'craRemittancePartyId'),
    ('CA', 'cpp2', 'craRemittancePartyId'),
    ('CA', 'ei', 'craRemittancePartyId'),
    ('CA', 'qpip', 'craRemittancePartyId'),
    ('CA', 'hsf', 'craRemittancePartyId'),
    ('IE', 'ie_paye', 'revenueRemittancePartyId'),
    ('IE', 'prsi', 'revenueRemittancePartyId'),
    ('IE', 'usc', 'revenueRemittancePartyId')
  ) AS t(country, system_key, settings_key)
),
pack_regional_vendor AS (
  -- Copied verbatim from the migration (126d6d89; unchanged from a24896ea).
  SELECT * FROM (VALUES
    ('CA', 'cpp', 'QC', 'rqRemittancePartyId'),
    ('CA', 'cpp2', 'QC', 'rqRemittancePartyId'),
    ('CA', 'qpip', 'QC', 'rqRemittancePartyId'),
    ('CA', 'hsf', 'QC', 'rqRemittancePartyId')
  ) AS t(country, system_key, province, settings_key)
),
org_payroll_settings AS (
  SELECT o.id AS org_id, (o.settings -> 'payroll') AS payroll
    FROM public.orgs o
),
scoped_lines AS (
  -- Pack-aware line attribution (U4), all three branches in migration
  -- order: a region-scoped key first (an unconfigured region resolves NULL
  -- and never falls through), then the frozen snapshot, then the pack
  -- default. Only non-empty string settings values count. The snapshot
  -- branch reads the component's current vendor as proxy for the column
  -- 0296 adds (see header). The resolved text belongs iff it IS NOT
  -- DISTINCT FROM the marker party.
  SELECT s.org_id, s.id AS bill, l.id AS line, l.amount AS gross,
         l.liability_account_id AS acct,
         CASE WHEN l.kind = 'credit' THEN -l.amount ELSE l.amount END AS net
    FROM scoped s
    JOIN public.pay_stub_lines l ON l.org_id = s.org_id
    JOIN public.pay_components c ON c.org_id = l.org_id AND c.id = l.component_id
    JOIN public.pay_stubs st ON st.id = l.stub_id AND st.org_id = l.org_id
    JOIN public.pay_runs r ON r.document_id = st.pay_run_document_id AND r.org_id = st.org_id
    JOIN org_payroll_settings ops ON ops.org_id = s.org_id
    LEFT JOIN pack_regional_vendor rv
      ON rv.country = c.country AND rv.system_key = c.system_key AND rv.province = st.province
    LEFT JOIN pack_default_vendor dv
      ON dv.country = c.country AND dv.system_key = c.system_key
   WHERE r.run_status = 'committed'
     AND l.kind IN ('deduction', 'employer_contribution', 'credit')
     AND st.pay_date BETWEEN s.from_date AND s.to_date
     AND (CASE
            WHEN rv.settings_key IS NOT NULL THEN
              CASE WHEN jsonb_typeof(ops.payroll -> rv.settings_key) = 'string'
                   THEN NULLIF(ops.payroll ->> rv.settings_key, '') ELSE NULL END
            WHEN c.remittance_party_id IS NOT NULL THEN c.remittance_party_id::text
            WHEN dv.settings_key IS NOT NULL THEN
              CASE WHEN jsonb_typeof(ops.payroll -> dv.settings_key) = 'string'
                   THEN NULLIF(ops.payroll ->> dv.settings_key, '') ELSE NULL END
            ELSE NULL
          END) IS NOT DISTINCT FROM s.party_id::text
     AND st.filing_account_id IS NOT DISTINCT FROM s.filing_id
     AND EXISTS (
       SELECT 1 FROM public.documents d
        WHERE d.id = r.document_id AND d.org_id = r.org_id
          AND d.subsidiary_id IS NOT DISTINCT FROM s.subsidiary_id
     )
),
accrual_groups AS (
  SELECT org_id, bill, acct, sum(net) AS net
    FROM scoped_lines
   GROUP BY org_id, bill, acct
  HAVING sum(net) <> 0
),
bill_groups AS (
  SELECT s.org_id, s.id AS bill, dl.account_id AS acct, sum(dl.amount) AS net
    FROM scoped s
    JOIN public.document_lines dl ON dl.org_id = s.org_id AND dl.document_id = s.id
   WHERE dl.amount <> 0
   GROUP BY s.org_id, s.id, dl.account_id
),
line_bad AS (
  SELECT s.org_id, s.id AS bill FROM scoped s
   WHERE EXISTS (
     SELECT ag.acct, ag.net FROM accrual_groups ag WHERE ag.org_id = s.org_id AND ag.bill = s.id
     EXCEPT
     SELECT bg.acct, bg.net FROM bill_groups bg WHERE bg.org_id = s.org_id AND bg.bill = s.id
   ) OR EXISTS (
     SELECT bg.acct, bg.net FROM bill_groups bg WHERE bg.org_id = s.org_id AND bg.bill = s.id
     EXCEPT
     SELECT ag.acct, ag.net FROM accrual_groups ag WHERE ag.org_id = s.org_id AND ag.bill = s.id
   )
)
SELECT '0296.malformed_remittance_marker' AS code,
       'refuse' AS severity,
       format('vendor_bill %s (org %s)', document_number, org_id) AS subject,
       format('marker field from: %s (value %s)',
              CASE WHEN from_v IS NULL THEN 'missing required field'
                   WHEN from_v !~ '^\d{4}-\d{2}-\d{2}$' THEN 'shape-violating date, want YYYY-MM-DD'
                   ELSE 'impossible calendar date' END,
              left(coalesce(from_v, '(absent)'), 100)) AS detail,
       'Correct each marker (real calendar dates, vendor/account uuids), void the bill, or remove the payrollRemittance tag — then re-apply. Tag removal keeps the fail-closed overlap refusal until correctly re-marked; the mechanized remedy takes the tag-removal branch, see schema/migrations/preflight/remedies/0296.malformed_remittance_marker.sql.' AS remedy
  FROM marked
 WHERE from_v IS NULL
    OR from_v !~ '^\d{4}-\d{2}-\d{2}$'
    OR (CASE WHEN from_v ~ '^\d{4}-\d{2}-\d{2}$' THEN (
              substring(from_v, 1, 4)::int NOT BETWEEN 1 AND 9999
           OR substring(from_v, 6, 2)::int NOT BETWEEN 1 AND 12
           OR substring(from_v, 9, 2)::int NOT BETWEEN 1 AND 31
           OR (substring(from_v, 6, 2)::int = 2 AND substring(from_v, 9, 2)::int > 29)
           OR (substring(from_v, 6, 2)::int IN (4, 6, 9, 11) AND substring(from_v, 9, 2)::int > 30)
           OR (substring(from_v, 6, 2)::int = 2 AND substring(from_v, 9, 2)::int = 29
               AND NOT (substring(from_v, 1, 4)::int % 4 = 0
                        AND (substring(from_v, 1, 4)::int % 100 <> 0
                             OR substring(from_v, 1, 4)::int % 400 = 0))))
        ELSE false END)
UNION ALL
SELECT '0296.malformed_remittance_marker' AS code,
       'refuse' AS severity,
       format('vendor_bill %s (org %s)', document_number, org_id) AS subject,
       format('marker field to: %s (value %s)',
              CASE WHEN to_v IS NULL THEN 'missing required field'
                   WHEN to_v !~ '^\d{4}-\d{2}-\d{2}$' THEN 'shape-violating date, want YYYY-MM-DD'
                   ELSE 'impossible calendar date' END,
              left(coalesce(to_v, '(absent)'), 100)) AS detail,
       'Correct each marker (real calendar dates, vendor/account uuids), void the bill, or remove the payrollRemittance tag — then re-apply. Tag removal keeps the fail-closed overlap refusal until correctly re-marked; the mechanized remedy takes the tag-removal branch, see schema/migrations/preflight/remedies/0296.malformed_remittance_marker.sql.' AS remedy
  FROM marked
 WHERE to_v IS NULL
    OR to_v !~ '^\d{4}-\d{2}-\d{2}$'
    OR (CASE WHEN to_v ~ '^\d{4}-\d{2}-\d{2}$' THEN (
              substring(to_v, 1, 4)::int NOT BETWEEN 1 AND 9999
           OR substring(to_v, 6, 2)::int NOT BETWEEN 1 AND 12
           OR substring(to_v, 9, 2)::int NOT BETWEEN 1 AND 31
           OR (substring(to_v, 6, 2)::int = 2 AND substring(to_v, 9, 2)::int > 29)
           OR (substring(to_v, 6, 2)::int IN (4, 6, 9, 11) AND substring(to_v, 9, 2)::int > 30)
           OR (substring(to_v, 6, 2)::int = 2 AND substring(to_v, 9, 2)::int = 29
               AND NOT (substring(to_v, 1, 4)::int % 4 = 0
                        AND (substring(to_v, 1, 4)::int % 100 <> 0
                             OR substring(to_v, 1, 4)::int % 400 = 0))))
        ELSE false END)
UNION ALL
SELECT '0296.malformed_remittance_marker' AS code,
       'refuse' AS severity,
       format('vendor_bill %s (org %s)', document_number, org_id) AS subject,
       format('marker field partyId: %s (value %s)',
              CASE WHEN party_v IS NULL THEN 'missing required field'
                   WHEN party_v !~ '^[0-9a-fA-F-]{36}$' THEN 'shape-violating reference, want a 36-char uuid'
                   ELSE 'not a uuid (dashes misplaced or non-hex)' END,
              left(coalesce(party_v, '(absent)'), 100)) AS detail,
       'Correct each marker (real calendar dates, vendor/account uuids), void the bill, or remove the payrollRemittance tag — then re-apply. Tag removal keeps the fail-closed overlap refusal until correctly re-marked; the mechanized remedy takes the tag-removal branch, see schema/migrations/preflight/remedies/0296.malformed_remittance_marker.sql.' AS remedy
  FROM marked
 WHERE party_v IS NULL
    OR party_v !~ '^[0-9a-fA-F-]{36}$'
    OR party_v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
UNION ALL
SELECT '0296.malformed_remittance_marker' AS code,
       'refuse' AS severity,
       format('vendor_bill %s (org %s)', document_number, org_id) AS subject,
       format('marker field filingAccountId: %s (value %s)',
              CASE WHEN filing_v !~ '^[0-9a-fA-F-]{36}$' THEN 'shape-violating reference, want a 36-char uuid or null'
                   ELSE 'not a uuid (dashes misplaced or non-hex)' END,
              left(filing_v, 100)) AS detail,
       'Correct each marker (real calendar dates, vendor/account uuids), void the bill, or remove the payrollRemittance tag — then re-apply. Tag removal keeps the fail-closed overlap refusal until correctly re-marked; the mechanized remedy takes the tag-removal branch, see schema/migrations/preflight/remedies/0296.malformed_remittance_marker.sql.' AS remedy
  FROM marked
 WHERE filing_v IS NOT NULL
   AND (filing_v !~ '^[0-9a-fA-F-]{36}$'
        OR filing_v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
UNION ALL
SELECT '0296.uncovered_bill' AS code,
       'notice' AS severity,
       format('vendor_bill %s (org %s)', s.document_number, s.org_id) AS subject,
       format('recorded party %s differs from marker party %s; the bill gains no coverage rows',
              coalesce(s.bill_party::text, '(none)'), s.party_id) AS detail,
       'Reconcile the bill against its window, party, filing account and legal entity: correct the recorded party to the marker party, or void and recreate the bill so its lines match the accrual accounts exactly (credits netting, zero lines dropped). Bills that do not reconcile exactly gain no coverage rows and keep the fail-closed window-overlap refusal.' AS remedy
  FROM scoped s
 WHERE s.bill_party IS DISTINCT FROM s.party_id
UNION ALL
SELECT '0296.uncovered_bill' AS code,
       'notice' AS severity,
       format('vendor_bill %s (org %s)', s.document_number, s.org_id) AS subject,
       'bill lines per (account, net) differ in either direction from the committed window/party/filing/entity accrual groups per (liability, net); the bill gains no coverage rows' AS detail,
       'Reconcile the bill against its window, party, filing account and legal entity: correct the recorded party to the marker party, or void and recreate the bill so its lines match the accrual accounts exactly (credits netting, zero lines dropped). Bills that do not reconcile exactly gain no coverage rows and keep the fail-closed window-overlap refusal.' AS remedy
  FROM scoped s
  JOIN line_bad l ON l.org_id = s.org_id AND l.bill = s.id
 ORDER BY 3, 4
 LIMIT 50;
