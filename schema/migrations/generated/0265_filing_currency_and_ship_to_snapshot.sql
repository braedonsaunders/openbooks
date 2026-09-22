-- OpenBooks forward migration 0265_filing_currency_and_ship_to_snapshot.
--
-- Two frozen-evidence gaps, one file (both are "the reprint must say what the
-- filing said when it was prepared", and both backfill from the same rule:
-- use what the source ledger still proves, leave NULL where it proves
-- nothing, and let every reader fail closed on NULL rather than substitute
-- today's configuration).
--
-- TAX FILING CURRENCY AND IDENTITY (D2/D3).
--
-- A saved tax return's boxes are denominated in the return's functional
-- currency — the filing entity's currency, or a declared presentation
-- currency for a translated consolidated view — but tax_filings stored no
-- frozen currency at all. The export reprint relabelled the frozen boxes
-- with the org's CURRENT base_currency, so a base-currency change (or a
-- filing prepared for a foreign subsidiary) reprinted a government form in
-- a currency its numbers were never computed in. Likewise the filing
-- snapshot hash covered form/period/channel/boxes/adjustments only: a
-- registration change or a currency/scope posture change passed the
-- mark-filed staleness check whenever the box values still matched, and the
-- 'sourceVerified' audit evidence certified a posture that was never
-- compared.
--
-- This migration adds the frozen posture columns. New prepares (snapshot
-- version 2) store every identity field the recompute verifies; the backfill
-- below restores functional_currency for pre-snapshot filings whose entity
-- posture is still unambiguous, and leaves every other column NULL so old
-- rows keep their exact v1 semantics (boxes-only verification, no invented
-- registration, export in the backfilled currency or refused).
--
-- Backfill rule: an org whose active, non-elimination subsidiaries share one
-- functional currency backfills that currency (that IS the currency every
-- past return in the org was measured in); an org with no active legal filer
-- backfills the org base. Anything else is genuinely ambiguous — the filing
-- entity was never recorded — and stays NULL: the export refuses a NULL
-- currency with a named remedy (prepare a new version) instead of printing
-- today's base on yesterday's numbers.
--
-- SHIP-TO DESTINATION SNAPSHOT (documents half; the kernel stamp and the
-- ledger rewrite land with the D1 commit — this file only carries the DDL so
-- the shard's schema ships in one ordinal).
--
-- SHIP-TO DESTINATION SNAPSHOT (documents half lands with the D1 commit in
-- this same file: ship_to_country / ship_to_region DDL, comments and the
-- evidence-only backfill — the shard's schema ships in one ordinal).

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- -- tax_filings frozen identity/posture (D2/D3) ---------------------------

ALTER TABLE public.tax_filings
  ADD COLUMN IF NOT EXISTS functional_currency text,
  ADD COLUMN IF NOT EXISTS presentation_currency text,
  ADD COLUMN IF NOT EXISTS translation jsonb,
  ADD COLUMN IF NOT EXISTS subsidiary_ids uuid[],
  ADD COLUMN IF NOT EXISTS registration_id uuid,
  ADD COLUMN IF NOT EXISTS registration_number text,
  ADD COLUMN IF NOT EXISTS snapshot_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.tax_filings.functional_currency IS
  'Frozen denomination of the stored boxes (0265): the filing entity functional currency, or the presentation currency for a translated view. Backfilled where the org posture is unambiguous; NULL means pre-snapshot and ambiguous — readers must refuse, never substitute the current org base.';
COMMENT ON COLUMN public.tax_filings.presentation_currency IS
  'Declared presentation currency of a translated consolidated view (0265); NULL for single-currency returns.';
COMMENT ON COLUMN public.tax_filings.translation IS
  'Translation evidence for a translated consolidated view (0265): rate source, rate date and per-entity applied rates. NULL for single-currency returns.';
COMMENT ON COLUMN public.tax_filings.subsidiary_ids IS
  'Frozen filing-entity scope (0265): the subsidiary set the return summed. NULL means pre-snapshot (unknown scope — v1 semantics); an empty array is the legacy degenerate org-wide return.';
COMMENT ON COLUMN public.tax_filings.registration_id IS
  'Frozen filing identity (0265): the tax_registrations row whose number travels on the return. NULL means pre-snapshot or unregistered.';
COMMENT ON COLUMN public.tax_filings.registration_number IS
  'Frozen filing identity (0265): the government registration number printed on the return. NULL means pre-snapshot or unregistered.';
COMMENT ON COLUMN public.tax_filings.snapshot_version IS
  'Snapshot schema version (0265): 1 hashed form/period/channel/boxes/adjustments only; 2 additionally hashes registration, currency and scope posture. Existing rows stay 1 so they verify exactly as prepared.';

WITH filer_ccy AS (
  SELECT s.org_id, min(s.base_currency) AS ccy
    FROM public.subsidiaries s
   WHERE s.is_active AND NOT s.is_elimination
   GROUP BY s.org_id
  HAVING count(DISTINCT s.base_currency) = 1
),
root_ccy AS (
  SELECT o.id AS org_id, o.base_currency AS ccy
    FROM public.orgs o
   WHERE NOT EXISTS (
     SELECT 1 FROM public.subsidiaries s
      WHERE s.org_id = o.id AND s.is_active AND NOT s.is_elimination
   )
)
UPDATE public.tax_filings f
   SET functional_currency = src.ccy
  FROM (
    SELECT org_id, ccy FROM filer_ccy
    UNION ALL
    SELECT org_id, ccy FROM root_ccy
  ) src
 WHERE f.org_id = src.org_id
   AND f.functional_currency IS NULL;
