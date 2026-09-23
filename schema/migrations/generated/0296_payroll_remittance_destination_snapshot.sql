-- OpenBooks forward migration 0296_payroll_remittance_destination_snapshot.
--
-- A historical remittance DESTINATION followed the CURRENT vendor: the summary
-- joined committed stub lines to live pay_components and routed every old row
-- to c.remittance_party_id, so editing a component's (or union agreement's)
-- vendor after commit re-pointed already-accrued payroll — and a posted bill
-- for the old vendor no longer matched the accruals, letting a SECOND full
-- bill for the same accruals post to the new vendor (a double payment).
--
-- The destination is therefore history, like the liability account since
-- 0094: new commits stamp the component's remittance_party_id on each stub
-- line, and every remittance read (summary, grouping, bill matching, overlap
-- and post checks) uses the snapshot, never the live component. A union
-- agreement needs no separate column: its destination reaches stub lines
-- only through its auto-provisioned component (union.ts copies the
-- agreement's vendor onto the component at fringe upsert), so freezing the
-- component value freezes agreement-sourced destinations too. Edits made
-- BEFORE this migration are backfilled from the component's CURRENT value —
-- exactly the figure every remittance summary reported until now, so no
-- historical figure changes; where a vendor was already changed, the operator
-- must reconcile the pre-change bills before relying on the snapshot (the
-- post freshness check still refuses a bill whose source moved).
--
-- This migration also creates payroll_remittance_coverage, the per-accrual
-- line coverage ledger the incremental-billing fix reads: bills created after
-- this migration record exactly which stub lines they consumed, so a later
-- same-period run can bill its unbilled remainder instead of being refused
-- as an overlap. Pre-existing bills are REPAIRED, not just backfilled: a
-- live bill is covered only when it reconciles exactly (recorded party
-- equals the marker party, lines per liability account equal the accrual
-- groups); anything else is left uncovered and NAMED by notice, keeping the
-- fail-closed window-overlap refusal until it is voided and recreated.
--
-- Legacy markers are unconstrained jsonb, so a marker precheck (below, first)
-- refuses the upgrade by name — document numbers and fields — when a live
-- bill's marker is missing a required field or carries a value the backfill
-- casts cannot parse (an impossible calendar date, a non-uuid vendor or
-- account reference). The shape regexes in the backfill are pre-filters, not
-- validators; the casts are safe only because this precheck runs first in
-- every application, including reapply.
--
-- Corrective-revision history: this file is reapplied, never edited blindly.
-- Every statement is idempotent against the revision it supersedes (IF NOT
-- EXISTS DDL, a guarded constraint add, DROP-then-CREATE trigger and policy,
-- an anti-joined backfill), and scripts/bootstrap.ts carries the reviewed
-- digest transition that authorises the re-run.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- Every live remittance marker must parse before the backfill casts below.
-- The backfill's regexes admit shape-valid values a cast still rejects
-- (2026-02-30, a 36-dash non-uuid), and a cast failure aborts the whole
-- upgrade with a bare conversion error naming nothing. Refuse first, naming
-- each bill and field, so the operator corrects the marker (or voids the
-- bill) and re-applies. Markers that are not objects, or objects naming none
-- of the four fields, predate structured bills: the backfill skips them as
-- before and they keep the fail-closed overlap refusal.
DO $remittance_marker_precheck$
DECLARE
  bad_count integer := 0;
  bad_detail text := '';
  rec record;
  complaint text;
BEGIN
  FOR rec IN
    SELECT b.document_number AS number, f.field AS field, f.value AS value, f.flavor AS flavor
      FROM public.documents b
      CROSS JOIN LATERAL (
        VALUES
          ('from', b.custom -> 'payrollRemittance' ->> 'from', 'date'),
          ('to', b.custom -> 'payrollRemittance' ->> 'to', 'date'),
          ('partyId', b.custom -> 'payrollRemittance' ->> 'partyId', 'uuid'),
          ('filingAccountId', b.custom -> 'payrollRemittance' ->> 'filingAccountId', 'uuid-or-null')
      ) AS f(field, value, flavor)
     WHERE b.kind = 'vendor_bill' AND b.status <> 'voided'
       AND jsonb_typeof(b.custom -> 'payrollRemittance') = 'object'
       AND (b.custom -> 'payrollRemittance') ?| array['from', 'to', 'partyId', 'filingAccountId']
     ORDER BY b.document_number, f.field
  LOOP
    complaint := NULL;
    IF rec.value IS NULL THEN
      IF rec.flavor <> 'uuid-or-null' THEN
        complaint := 'missing';
      END IF;
    ELSIF rec.flavor = 'date' AND rec.value !~ '^\d{4}-\d{2}-\d{2}$' THEN
      complaint := 'malformed date "' || rec.value || '"';
    ELSIF (rec.flavor = 'uuid' OR rec.flavor = 'uuid-or-null') AND rec.value !~ '^[0-9a-fA-F-]{36}$' THEN
      complaint := 'malformed reference "' || rec.value || '"';
    ELSIF rec.flavor = 'date' THEN
      BEGIN
        PERFORM rec.value::date;
      EXCEPTION
        -- 22007 (bad shape that slipped the regex) and 22008 (a real
        -- calendar miss like February 30th): both are unparseable markers.
        WHEN invalid_datetime_format OR datetime_field_overflow THEN
          complaint := 'impossible calendar date "' || rec.value || '"';
      END;
    ELSE
      BEGIN
        PERFORM rec.value::uuid;
      EXCEPTION
        WHEN invalid_text_representation THEN
          complaint := 'unparseable reference "' || rec.value || '"';
      END;
    END IF;
    IF complaint IS NOT NULL THEN
      bad_count := bad_count + 1;
      bad_detail := bad_detail || rec.number || ' ' || rec.field || ': ' || complaint || '; ';
    END IF;
  END LOOP;
  IF bad_count > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'payroll_remittance_marker_parseable',
      MESSAGE = 'payroll remittance bill(s) carry markers the coverage backfill cannot parse: '
        || bad_detail
        || 'correct each marker (real calendar dates, vendor/account uuids) or void the bill, then re-apply';
  END IF;
END
$remittance_marker_precheck$;

-- Every component vendor referenced by a committed accrual must still exist:
-- the snapshot FK below would otherwise fail with a bare violation, and a
-- dangling vendor can never become a bill (bill creation requires an active
-- vendor role). Repoint the named components, then re-apply; nothing is
-- auto-rewritten.
DO $precheck$
DECLARE
  violation_count integer;
  offending text;
BEGIN
  SELECT count(*), string_agg(DISTINCT c.code, ', ' ORDER BY c.code)
    INTO violation_count, offending
    FROM public.pay_components c
   WHERE c.remittance_party_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.parties p
        WHERE p.org_id = c.org_id AND p.id = c.remittance_party_id
     )
     AND EXISTS (
       SELECT 1 FROM public.pay_stub_lines l
         JOIN public.pay_stubs s ON s.id = l.stub_id AND s.org_id = l.org_id
         JOIN public.pay_runs r ON r.document_id = s.pay_run_document_id AND r.org_id = s.org_id
        WHERE l.org_id = c.org_id AND l.component_id = c.id
          AND r.run_status = 'committed'
          AND l.kind IN ('deduction', 'employer_contribution', 'credit')
     );
  IF violation_count > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'pay_stub_line_remittance_snapshot_dangling_vendor',
      MESSAGE = 'pay component(s) ' || offending || ' remit to a vendor that no longer exists — repoint them in Payroll setup, then re-apply';
  END IF;
END
$precheck$;

ALTER TABLE public.pay_stub_lines ADD COLUMN IF NOT EXISTS remittance_party_id uuid;
DO $remittance_snapshot_fkey$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pay_stub_lines_remittance_party_tenant_fkey'
  ) THEN
    ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_remittance_party_tenant_fkey
      FOREIGN KEY (org_id, remittance_party_id) REFERENCES public.parties(org_id, id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END
$remittance_snapshot_fkey$;
CREATE INDEX IF NOT EXISTS pay_stub_lines_remittance_party ON public.pay_stub_lines(org_id, remittance_party_id);

UPDATE public.pay_stub_lines l
   SET remittance_party_id = c.remittance_party_id
  FROM public.pay_stubs s
  JOIN public.pay_runs r ON r.document_id = s.pay_run_document_id AND r.org_id = s.org_id
  JOIN public.pay_components c ON c.org_id = s.org_id
 WHERE s.id = l.stub_id AND s.org_id = l.org_id
   AND c.id = l.component_id
   AND r.run_status = 'committed'
   AND l.kind IN ('deduction', 'employer_contribution', 'credit')
   AND c.remittance_party_id IS NOT NULL
   AND l.remittance_party_id IS NULL;

CREATE OR REPLACE FUNCTION public.pay_stub_line_remittance_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_trusted_replay boolean;
BEGIN
  -- This is the same paired, transaction-local authority the document-line,
  -- posted-document and journal guards admit: a source-asserted party merge
  -- re-points frozen destinations to the survivor (absorbed and survivor are
  -- the same economic party, so history follows). Migration-only or
  -- amend-only callers remain blocked; no ordinary writer can turn either
  -- setting into an edit bypass by itself.
  v_trusted_replay :=
    coalesce(current_setting('openbooks.migration', true), 'off') = 'on'
    AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on';
  IF v_trusted_replay THEN
    RETURN NEW;
  END IF;
  IF OLD.remittance_party_id IS NOT NULL
     AND NEW.remittance_party_id IS DISTINCT FROM OLD.remittance_party_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'pay_stub_line_remittance_immutable',
      MESSAGE = 'The remittance destination a committed payroll line accrued to is immutable.';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS pay_stub_line_remittance_guard ON public.pay_stub_lines;
CREATE TRIGGER pay_stub_line_remittance_guard BEFORE UPDATE ON public.pay_stub_lines
FOR EACH ROW EXECUTE FUNCTION public.pay_stub_line_remittance_guard();
COMMENT ON COLUMN public.pay_stub_lines.remittance_party_id IS
  'Remittance destination this deduction/employer contribution/credit accrued to at commit. Remittances route by this, never the component''s current vendor.';

-- Per-accrual coverage: which committed stub lines a live remittance bill
-- consumed. A later same-window bill covers only lines no non-voided bill
-- has covered; voiding a bill frees its lines (only non-voided bills count).
CREATE TABLE IF NOT EXISTS public.payroll_remittance_coverage (
  org_id uuid NOT NULL,
  bill_document_id uuid NOT NULL,
  stub_line_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  CONSTRAINT payroll_remittance_coverage_pkey PRIMARY KEY (org_id, bill_document_id, stub_line_id),
  CONSTRAINT payroll_remittance_coverage_bill_tenant_fkey
    FOREIGN KEY (org_id, bill_document_id) REFERENCES public.documents(org_id, id),
  -- Single-column line reference, following the entitlement_ledger precedent:
  -- pay_stub_lines carries no (org_id, id) unique key, so the tenant pair
  -- cannot be a composite FK. The writer stamps all three columns from one
  -- org; org_id stays on the row for RLS.
  CONSTRAINT payroll_remittance_coverage_line_fkey
    FOREIGN KEY (stub_line_id) REFERENCES public.pay_stub_lines(id)
);
CREATE INDEX IF NOT EXISTS payroll_remittance_coverage_line ON public.payroll_remittance_coverage(org_id, stub_line_id);
ALTER TABLE public.payroll_remittance_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.payroll_remittance_coverage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.payroll_remittance_coverage;
CREATE POLICY org_isolation ON public.payroll_remittance_coverage USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));
COMMENT ON POLICY org_isolation ON public.payroll_remittance_coverage IS 'openbooks:org_isolation:v1';

-- Repair coverage for pre-existing bills. A live bill is covered ONLY when
-- it reconciles EXACTLY: its recorded party equals the marker party, and
-- its lines per liability account equal the committed accrual groups per
-- liability account (credits netting as the summary nets them; zero-amount
-- lines and zero-net groups dropped on both sides), with each line attributed
-- through the pack-aware resolution below. Anything else — a
-- hand-edited wrong-account bill, a re-pointed party, a window that gained
-- a later run — gets NO rows and is NAMED by the notice below; it keeps the
-- fail-closed window-overlap refusal until it is voided and recreated (void
-- and recreate: a corrected draft records no coverage, so correcting and
-- posting would leave payable lines that look unbilled). Only bills with no
-- app-recorded coverage are in scope: post-0296 bills carry the creator's
-- own rows (created_by IS NOT NULL) and are never rewritten here. Backfill
-- rows for voided bills are deleted (voiding frees the lines); app rows are
-- never touched. The casts below are safe only because the marker precheck
-- at the top of this file runs first in every application. Re-apply safe:
-- fills are anti-joined, empties only remove backfill rows, the notice is
-- side-effect free.
WITH sane_bills AS (
  SELECT b.org_id, b.id, b.total, b.subsidiary_id,
         CASE WHEN (b.custom -> 'payrollRemittance' ->> 'from') ~ '^\d{4}-\d{2}-\d{2}$'
              THEN (b.custom -> 'payrollRemittance' ->> 'from')::date END AS from_date,
         CASE WHEN (b.custom -> 'payrollRemittance' ->> 'to') ~ '^\d{4}-\d{2}-\d{2}$'
              THEN (b.custom -> 'payrollRemittance' ->> 'to')::date END AS to_date,
         CASE WHEN (b.custom -> 'payrollRemittance' ->> 'partyId') ~ '^[0-9a-fA-F-]{36}$'
              THEN (b.custom -> 'payrollRemittance' ->> 'partyId')::uuid END AS party_id,
         CASE WHEN (b.custom -> 'payrollRemittance' ->> 'filingAccountId') IS NULL
                OR (b.custom -> 'payrollRemittance' ->> 'filingAccountId') ~ '^[0-9a-fA-F-]{36}$'
              THEN (b.custom -> 'payrollRemittance' ->> 'filingAccountId')::uuid END AS filing_id,
         ((b.custom -> 'payrollRemittance' ->> 'filingAccountId') IS NULL
          OR (b.custom -> 'payrollRemittance' ->> 'filingAccountId') ~ '^[0-9a-fA-F-]{36}$') AS filing_ok
    FROM public.documents b
   WHERE b.kind = 'vendor_bill' AND b.status <> 'voided'
     AND (b.custom -> 'payrollRemittance') IS NOT NULL
)
, scoped AS (
  -- Repair scope: live structured bills with no app-recorded coverage.
  -- Post-0296 bills carry the creator's own rows (created_by IS NOT NULL)
  -- and are never rewritten here.
  SELECT s.* FROM sane_bills s
  JOIN public.documents b ON b.org_id = s.org_id AND b.id = s.id
 WHERE b.status <> 'voided'
   AND NOT EXISTS (
     SELECT 1 FROM public.payroll_remittance_coverage c
      WHERE c.org_id = s.org_id AND c.bill_document_id = s.id AND c.created_by IS NOT NULL
   )
),
pack_default_vendor AS (
  -- 0296-era pack-declared vendor settings keys (non-null only), frozen.
  -- A pre-0296 line can only carry a key its pack declared when the line
  -- committed; engine/src/payroll/packs.ts statutoryRemittanceDeclaration is
  -- parity-pinned against this list by the 0296 upgrade test.
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
  -- Line attribution resolves each line's destination through the same order
  -- the bill-creation path uses: a region-scoped key first (an unconfigured
  -- region stays regional and never falls through to the snapshot), then the
  -- frozen snapshot, then the pack default. Only non-empty string settings
  -- values count, matching the TypeScript resolver exactly.
  SELECT s.org_id, s.id AS bill, l.id AS line, l.amount AS gross,
         l.liability_account_id AS acct,
         CASE WHEN l.kind = 'credit' THEN -l.amount ELSE l.amount END AS net
    FROM scoped s
    JOIN public.pay_stub_lines l ON l.org_id = s.org_id
    JOIN public.pay_stubs st ON st.id = l.stub_id AND st.org_id = l.org_id
    JOIN public.pay_runs r ON r.document_id = st.pay_run_document_id AND r.org_id = st.org_id
    JOIN public.pay_components c ON c.org_id = l.org_id AND c.id = l.component_id
    JOIN org_payroll_settings ops ON ops.org_id = s.org_id
    LEFT JOIN pack_regional_vendor rv
      ON rv.country = c.country AND rv.system_key = c.system_key AND rv.province = st.province
    LEFT JOIN pack_default_vendor dv
      ON dv.country = c.country AND dv.system_key = c.system_key
   WHERE s.from_date IS NOT NULL AND s.to_date IS NOT NULL AND s.party_id IS NOT NULL
     AND s.filing_ok
     AND r.run_status = 'committed'
     AND l.kind IN ('deduction', 'employer_contribution', 'credit')
     AND st.pay_date BETWEEN s.from_date AND s.to_date
     AND (
       CASE
         WHEN rv.settings_key IS NOT NULL THEN
           CASE WHEN jsonb_typeof(ops.payroll -> rv.settings_key) = 'string'
                THEN NULLIF(ops.payroll ->> rv.settings_key, '') ELSE NULL END
         WHEN l.remittance_party_id IS NOT NULL THEN l.remittance_party_id::text
         WHEN dv.settings_key IS NOT NULL THEN
           CASE WHEN jsonb_typeof(ops.payroll -> dv.settings_key) = 'string'
                THEN NULLIF(ops.payroll ->> dv.settings_key, '') ELSE NULL END
         ELSE NULL
       END
     ) IS NOT DISTINCT FROM s.party_id::text
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
party_bad AS (
  SELECT s.org_id, s.id AS bill FROM scoped s
  JOIN public.documents b ON b.org_id = s.org_id AND b.id = s.id
 WHERE b.party_id IS DISTINCT FROM s.party_id
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
),
reconciled AS (
  SELECT org_id, id AS bill FROM scoped
  EXCEPT
  SELECT org_id, bill FROM party_bad
  EXCEPT
  SELECT org_id, bill FROM line_bad
)
INSERT INTO public.payroll_remittance_coverage (org_id, bill_document_id, stub_line_id, amount)
SELECT sl.org_id, sl.bill, sl.line, sl.gross
  FROM scoped_lines sl
  JOIN reconciled r ON r.org_id = sl.org_id AND r.bill = sl.bill
 WHERE NOT EXISTS (
   SELECT 1 FROM public.payroll_remittance_coverage cov
    WHERE cov.org_id = sl.org_id
      AND cov.bill_document_id = sl.bill
      AND cov.stub_line_id = sl.line
 );

-- Live bills that do not reconcile keep no backfill rows: their lines stay
-- outside line coverage and the bill keeps the fail-closed window-overlap
-- refusal until it is voided and recreated. App rows are never removed.
-- (The reconciliation chain is restated — one statement cannot share
-- another's WITH, and a temp staging table would not survive the
-- statement-by-statement no-transaction application.)
DELETE FROM public.payroll_remittance_coverage cov
 USING (
   WITH sane_bills AS (
     SELECT b.org_id, b.id, b.total, b.subsidiary_id,
            CASE WHEN (b.custom -> 'payrollRemittance' ->> 'from') ~ '^\d{4}-\d{2}-\d{2}$'
                 THEN (b.custom -> 'payrollRemittance' ->> 'from')::date END AS from_date,
            CASE WHEN (b.custom -> 'payrollRemittance' ->> 'to') ~ '^\d{4}-\d{2}-\d{2}$'
                 THEN (b.custom -> 'payrollRemittance' ->> 'to')::date END AS to_date,
            CASE WHEN (b.custom -> 'payrollRemittance' ->> 'partyId') ~ '^[0-9a-fA-F-]{36}$'
                 THEN (b.custom -> 'payrollRemittance' ->> 'partyId')::uuid END AS party_id,
            CASE WHEN (b.custom -> 'payrollRemittance' ->> 'filingAccountId') IS NULL
                   OR (b.custom -> 'payrollRemittance' ->> 'filingAccountId') ~ '^[0-9a-fA-F-]{36}$'
                 THEN (b.custom -> 'payrollRemittance' ->> 'filingAccountId')::uuid END AS filing_id,
            ((b.custom -> 'payrollRemittance' ->> 'filingAccountId') IS NULL
             OR (b.custom -> 'payrollRemittance' ->> 'filingAccountId') ~ '^[0-9a-fA-F-]{36}$') AS filing_ok
       FROM public.documents b
      WHERE b.kind = 'vendor_bill' AND b.status <> 'voided'
        AND (b.custom -> 'payrollRemittance') IS NOT NULL
   ),
   scoped AS (
     SELECT s.* FROM sane_bills s
     JOIN public.documents b ON b.org_id = s.org_id AND b.id = s.id
    WHERE b.status <> 'voided'
      AND NOT EXISTS (
        SELECT 1 FROM public.payroll_remittance_coverage c
         WHERE c.org_id = s.org_id AND c.bill_document_id = s.id AND c.created_by IS NOT NULL
      )
   ),
   pack_default_vendor AS (
     -- 0296-era pack-declared vendor settings keys (non-null only), frozen.
     -- A pre-0296 line can only carry a key its pack declared when the line
     -- committed; engine/src/payroll/packs.ts statutoryRemittanceDeclaration is
     -- parity-pinned against this list by the 0296 upgrade test.
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
     -- Line attribution resolves each line's destination through the same order
     -- the bill-creation path uses: a region-scoped key first (an unconfigured
     -- region stays regional and never falls through to the snapshot), then the
     -- frozen snapshot, then the pack default. Only non-empty string settings
     -- values count, matching the TypeScript resolver exactly.
     SELECT s.org_id, s.id AS bill, l.id AS line, l.amount AS gross,
            l.liability_account_id AS acct,
            CASE WHEN l.kind = 'credit' THEN -l.amount ELSE l.amount END AS net
       FROM scoped s
       JOIN public.pay_stub_lines l ON l.org_id = s.org_id
       JOIN public.pay_stubs st ON st.id = l.stub_id AND st.org_id = l.org_id
       JOIN public.pay_runs r ON r.document_id = st.pay_run_document_id AND r.org_id = st.org_id
       JOIN public.pay_components c ON c.org_id = l.org_id AND c.id = l.component_id
       JOIN org_payroll_settings ops ON ops.org_id = s.org_id
       LEFT JOIN pack_regional_vendor rv
         ON rv.country = c.country AND rv.system_key = c.system_key AND rv.province = st.province
       LEFT JOIN pack_default_vendor dv
         ON dv.country = c.country AND dv.system_key = c.system_key
      WHERE s.from_date IS NOT NULL AND s.to_date IS NOT NULL AND s.party_id IS NOT NULL
        AND s.filing_ok
        AND r.run_status = 'committed'
        AND l.kind IN ('deduction', 'employer_contribution', 'credit')
        AND st.pay_date BETWEEN s.from_date AND s.to_date
        AND (
          CASE
            WHEN rv.settings_key IS NOT NULL THEN
              CASE WHEN jsonb_typeof(ops.payroll -> rv.settings_key) = 'string'
                   THEN NULLIF(ops.payroll ->> rv.settings_key, '') ELSE NULL END
            WHEN l.remittance_party_id IS NOT NULL THEN l.remittance_party_id::text
            WHEN dv.settings_key IS NOT NULL THEN
              CASE WHEN jsonb_typeof(ops.payroll -> dv.settings_key) = 'string'
                   THEN NULLIF(ops.payroll ->> dv.settings_key, '') ELSE NULL END
            ELSE NULL
          END
        ) IS NOT DISTINCT FROM s.party_id::text
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
   party_bad AS (
     SELECT s.org_id, s.id AS bill FROM scoped s
     JOIN public.documents b ON b.org_id = s.org_id AND b.id = s.id
    WHERE b.party_id IS DISTINCT FROM s.party_id
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
   -- Scoped bills minus the reconciling ones below: only the dead empty.
   SELECT org_id, id AS bill FROM scoped
   EXCEPT
   SELECT org_id, bill FROM (
     SELECT org_id, id AS bill FROM scoped
     EXCEPT
     SELECT org_id, bill FROM party_bad
     EXCEPT
     SELECT org_id, bill FROM line_bad
   ) reconciled_keep
 ) dead
 WHERE cov.created_by IS NULL
   AND cov.org_id = dead.org_id AND cov.bill_document_id = dead.bill;

-- Voiding frees the lines: backfill rows for voided bills go, app rows stay
-- with their writer (the void path owns them).
DELETE FROM public.payroll_remittance_coverage cov
 WHERE cov.created_by IS NULL
   AND EXISTS (
     SELECT 1 FROM public.documents b
      WHERE b.org_id = cov.org_id AND b.id = cov.bill_document_id AND b.status = 'voided'
   );

-- Bills that keep the fail-closed overlap refusal are named, never silent.
-- (The reconciliation chain is restated for the same reason as above.)
DO $remittance_coverage_repair_notice$
DECLARE
  named_count integer := 0;
  named_list text := '';
  rec record;
BEGIN
  FOR rec IN
  WITH sane_bills AS (
    SELECT b.org_id, b.id, b.total, b.subsidiary_id,
           CASE WHEN (b.custom -> 'payrollRemittance' ->> 'from') ~ '^\d{4}-\d{2}-\d{2}$'
                THEN (b.custom -> 'payrollRemittance' ->> 'from')::date END AS from_date,
           CASE WHEN (b.custom -> 'payrollRemittance' ->> 'to') ~ '^\d{4}-\d{2}-\d{2}$'
                THEN (b.custom -> 'payrollRemittance' ->> 'to')::date END AS to_date,
           CASE WHEN (b.custom -> 'payrollRemittance' ->> 'partyId') ~ '^[0-9a-fA-F-]{36}$'
                THEN (b.custom -> 'payrollRemittance' ->> 'partyId')::uuid END AS party_id,
           CASE WHEN (b.custom -> 'payrollRemittance' ->> 'filingAccountId') IS NULL
                  OR (b.custom -> 'payrollRemittance' ->> 'filingAccountId') ~ '^[0-9a-fA-F-]{36}$'
                THEN (b.custom -> 'payrollRemittance' ->> 'filingAccountId')::uuid END AS filing_id,
           ((b.custom -> 'payrollRemittance' ->> 'filingAccountId') IS NULL
            OR (b.custom -> 'payrollRemittance' ->> 'filingAccountId') ~ '^[0-9a-fA-F-]{36}$') AS filing_ok
      FROM public.documents b
     WHERE b.kind = 'vendor_bill' AND b.status <> 'voided'
       AND (b.custom -> 'payrollRemittance') IS NOT NULL
  ),
  scoped AS (
    SELECT s.* FROM sane_bills s
    JOIN public.documents b ON b.org_id = s.org_id AND b.id = s.id
   WHERE b.status <> 'voided'
     AND NOT EXISTS (
       SELECT 1 FROM public.payroll_remittance_coverage c
        WHERE c.org_id = s.org_id AND c.bill_document_id = s.id AND c.created_by IS NOT NULL
     )
  ),
  pack_default_vendor AS (
    -- 0296-era pack-declared vendor settings keys (non-null only), frozen.
    -- A pre-0296 line can only carry a key its pack declared when the line
    -- committed; engine/src/payroll/packs.ts statutoryRemittanceDeclaration is
    -- parity-pinned against this list by the 0296 upgrade test.
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
    -- Line attribution resolves each line's destination through the same order
    -- the bill-creation path uses: a region-scoped key first (an unconfigured
    -- region stays regional and never falls through to the snapshot), then the
    -- frozen snapshot, then the pack default. Only non-empty string settings
    -- values count, matching the TypeScript resolver exactly.
    SELECT s.org_id, s.id AS bill, l.id AS line, l.amount AS gross,
           l.liability_account_id AS acct,
           CASE WHEN l.kind = 'credit' THEN -l.amount ELSE l.amount END AS net
      FROM scoped s
      JOIN public.pay_stub_lines l ON l.org_id = s.org_id
      JOIN public.pay_stubs st ON st.id = l.stub_id AND st.org_id = l.org_id
      JOIN public.pay_runs r ON r.document_id = st.pay_run_document_id AND r.org_id = st.org_id
      JOIN public.pay_components c ON c.org_id = l.org_id AND c.id = l.component_id
      JOIN org_payroll_settings ops ON ops.org_id = s.org_id
      LEFT JOIN pack_regional_vendor rv
        ON rv.country = c.country AND rv.system_key = c.system_key AND rv.province = st.province
      LEFT JOIN pack_default_vendor dv
        ON dv.country = c.country AND dv.system_key = c.system_key
     WHERE s.from_date IS NOT NULL AND s.to_date IS NOT NULL AND s.party_id IS NOT NULL
       AND s.filing_ok
       AND r.run_status = 'committed'
       AND l.kind IN ('deduction', 'employer_contribution', 'credit')
       AND st.pay_date BETWEEN s.from_date AND s.to_date
       AND (
         CASE
           WHEN rv.settings_key IS NOT NULL THEN
             CASE WHEN jsonb_typeof(ops.payroll -> rv.settings_key) = 'string'
                  THEN NULLIF(ops.payroll ->> rv.settings_key, '') ELSE NULL END
           WHEN l.remittance_party_id IS NOT NULL THEN l.remittance_party_id::text
           WHEN dv.settings_key IS NOT NULL THEN
             CASE WHEN jsonb_typeof(ops.payroll -> dv.settings_key) = 'string'
                  THEN NULLIF(ops.payroll ->> dv.settings_key, '') ELSE NULL END
           ELSE NULL
         END
       ) IS NOT DISTINCT FROM s.party_id::text
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
  flagged AS (
    SELECT b.document_number AS number,
           (b.party_id IS DISTINCT FROM s.party_id) AS party_bad,
           (EXISTS (
              SELECT ag.acct, ag.net FROM accrual_groups ag WHERE ag.org_id = s.org_id AND ag.bill = s.id
              EXCEPT
              SELECT bg.acct, bg.net FROM bill_groups bg WHERE bg.org_id = s.org_id AND bg.bill = s.id
            ) OR EXISTS (
              SELECT bg.acct, bg.net FROM bill_groups bg WHERE bg.org_id = s.org_id AND bg.bill = s.id
              EXCEPT
              SELECT ag.acct, ag.net FROM accrual_groups ag WHERE ag.org_id = s.org_id AND ag.bill = s.id
            )) AS line_bad
      FROM scoped s
      JOIN public.documents b ON b.org_id = s.org_id AND b.id = s.id
  )
    SELECT number,
           concat_ws(',', CASE WHEN party_bad THEN 'party-mismatch' END,
                        CASE WHEN line_bad THEN 'line-mismatch' END) AS reasons
      FROM flagged
     WHERE party_bad OR line_bad
     ORDER BY number
  LOOP
    named_count := named_count + 1;
    IF named_count <= 50 THEN
      named_list := named_list || rec.number || ' (' || rec.reasons || '), ';
    END IF;
  END LOOP;
  IF named_count > 0 THEN
    named_list := rtrim(named_list, ', ');
    IF named_count > 50 THEN
      named_list := named_list || ' (+' || (named_count - 50) || ' more)';
    END IF;
    RAISE NOTICE 'payroll remittance coverage repair: % live bill(s) do not reconcile and keep the fail-closed overlap refusal — void and recreate them (do not correct-and-post): %',
      named_count, named_list;
  ELSE
    RAISE NOTICE 'payroll remittance coverage repair: every in-scope live bill reconciles';
  END IF;
END
$remittance_coverage_repair_notice$;

SELECT public.openbooks_refresh_query_catalog();
