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
-- as an overlap. Pre-existing non-voided bills are backfilled ONLY when
-- their window's snapshot lines sum EXACTLY to the bill total (credits
-- netting as in the summary); anything else keeps the fail-closed
-- window-overlap refusal until it is voided and recreated.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

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

ALTER TABLE public.pay_stub_lines ADD COLUMN remittance_party_id uuid;
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_remittance_party_tenant_fkey
  FOREIGN KEY (org_id, remittance_party_id) REFERENCES public.parties(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX pay_stub_lines_remittance_party ON public.pay_stub_lines(org_id, remittance_party_id);

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
BEGIN
  IF OLD.remittance_party_id IS NOT NULL
     AND NEW.remittance_party_id IS DISTINCT FROM OLD.remittance_party_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'pay_stub_line_remittance_immutable',
      MESSAGE = 'The remittance destination a committed payroll line accrued to is immutable.';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pay_stub_line_remittance_guard BEFORE UPDATE ON public.pay_stub_lines
FOR EACH ROW EXECUTE FUNCTION public.pay_stub_line_remittance_guard();
COMMENT ON COLUMN public.pay_stub_lines.remittance_party_id IS
  'Remittance destination this deduction/employer contribution/credit accrued to at commit. Remittances route by this, never the component''s current vendor.';

-- Per-accrual coverage: which committed stub lines a live remittance bill
-- consumed. A later same-window bill covers only lines no non-voided bill
-- has covered; voiding a bill frees its lines (only non-voided bills count).
CREATE TABLE public.payroll_remittance_coverage (
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
CREATE INDEX payroll_remittance_coverage_line ON public.payroll_remittance_coverage(org_id, stub_line_id);
ALTER TABLE public.payroll_remittance_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.payroll_remittance_coverage FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.payroll_remittance_coverage;
CREATE POLICY org_isolation ON public.payroll_remittance_coverage USING (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true)))) WITH CHECK (((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR ((org_id)::text = current_setting('app.current_org'::text, true))));
COMMENT ON POLICY org_isolation ON public.payroll_remittance_coverage IS 'openbooks:org_isolation:v1';

-- Backfill coverage for pre-existing live bills whose window is unambiguous:
-- the snapshot lines in the bill's own window, party, filing account and
-- entity sum EXACTLY to the bill total (credits netting, as the summary nets
-- them). A bill that fails the exact-total match — a later run added lines,
-- the vendor changed mid-window, or the bill was hand-edited — gets no rows
-- and keeps the fail-closed window-overlap refusal: void and recreate it to
-- move it onto line coverage.
INSERT INTO public.payroll_remittance_coverage (org_id, bill_document_id, stub_line_id, amount)
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
SELECT sane.org_id, sane.id, l.id, l.amount
  FROM sane_bills sane
  JOIN public.pay_stub_lines l ON l.org_id = sane.org_id
  JOIN public.pay_stubs s ON s.id = l.stub_id AND s.org_id = l.org_id
  JOIN public.pay_runs r ON r.document_id = s.pay_run_document_id AND r.org_id = s.org_id
 WHERE sane.from_date IS NOT NULL AND sane.to_date IS NOT NULL AND sane.party_id IS NOT NULL
   AND sane.filing_ok
   AND r.run_status = 'committed'
   AND l.kind IN ('deduction', 'employer_contribution', 'credit')
   AND s.pay_date BETWEEN sane.from_date AND sane.to_date
   AND l.remittance_party_id IS NOT DISTINCT FROM sane.party_id
   AND s.filing_account_id IS NOT DISTINCT FROM sane.filing_id
   AND EXISTS (
     SELECT 1 FROM public.documents d
      WHERE d.id = r.document_id AND d.org_id = r.org_id
        AND d.subsidiary_id IS NOT DISTINCT FROM sane.subsidiary_id
   )
   AND (
     SELECT coalesce(sum(
       CASE WHEN grp.kind = 'credit' THEN -grp.gross ELSE grp.gross END
     ), 0)
       FROM (
         SELECT l2.component_id, l2.kind, l2.liability_account_id, sum(l2.amount) AS gross
           FROM public.pay_stub_lines l2
           JOIN public.pay_stubs s2 ON s2.id = l2.stub_id AND s2.org_id = l2.org_id
           JOIN public.pay_runs r2 ON r2.document_id = s2.pay_run_document_id AND r2.org_id = s2.org_id
          WHERE l2.org_id = sane.org_id
            AND r2.run_status = 'committed'
            AND l2.kind IN ('deduction', 'employer_contribution', 'credit')
            AND s2.pay_date BETWEEN sane.from_date AND sane.to_date
            AND l2.remittance_party_id IS NOT DISTINCT FROM sane.party_id
            AND s2.filing_account_id IS NOT DISTINCT FROM sane.filing_id
            AND EXISTS (
              SELECT 1 FROM public.documents d2
               WHERE d2.id = r2.document_id AND d2.org_id = r2.org_id
                 AND d2.subsidiary_id IS NOT DISTINCT FROM sane.subsidiary_id
            )
          GROUP BY l2.component_id, l2.kind, l2.liability_account_id
       ) grp
      WHERE grp.gross <> 0
   ) = sane.total;

SELECT public.openbooks_refresh_query_catalog();
