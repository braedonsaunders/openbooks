-- OpenBooks forward migration 0256_recognition_schedule_transaction_rate.
--
-- Foreign-currency invoices recognized revenue at FX rate 1. A schedule
-- never amended has change_basis null, so posting converted its plan at
-- rate 1 in the functional currency — while the invoice credited deferred
-- revenue at the invoice's own rate. EUR 1,000 @ 1.10 in a USD entity
-- deferred USD 1,100 but recognized only USD 1,000, stranding USD 100 in
-- deferred revenue forever. The correct model is the historical rate:
-- deferred revenue is a non-monetary liability (ASC 606 / IFRS 15), so it
-- is recognized out at the rate it was deferred at, with no revaluation.
-- These columns stamp the schedule's transaction currency and historical
-- rate at creation; the posting reader prefers an amendment's bookRates
-- (change_basis) and otherwise converts at the stamped rate.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.recognition_schedules
  ADD COLUMN IF NOT EXISTS transaction_currency text,
  ADD COLUMN IF NOT EXISTS transaction_fx_rate numeric(19,10);

COMMENT ON COLUMN public.recognition_schedules.transaction_currency IS
  'Plan-line currency of the originating transaction (invoice currency; owner functional currency for project obligations) (0256). Deferred revenue is recognized out in this currency.';
COMMENT ON COLUMN public.recognition_schedules.transaction_fx_rate IS
  'Historical FX rate the originating transaction deferred at; recognition converts plan lines at this rate, never revalued (0256). Amendment bookRates (change_basis) take precedence when present.';

-- Backfill, re-runnable (fills only unstamped schedules):
-- invoice schedules take the rate their invoice''s deferred-revenue journal
-- stamped (one rate per document; latest posted entry wins
-- deterministically), falling back to the invoice row when nothing posted;
-- project (document-less) schedules take the contract currency at par.
UPDATE public.recognition_schedules s
   SET transaction_currency = COALESCE(j.currency, d.currency),
       transaction_fx_rate = COALESCE(j.fx_rate, d.fx_rate)
FROM performance_obligations o
JOIN document_lines dl ON dl.id = o.document_line_id AND dl.org_id = o.org_id
JOIN documents d ON d.id = dl.document_id AND d.org_id = dl.org_id
LEFT JOIN LATERAL (
  SELECT jl.currency, jl.fx_rate
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id AND je.org_id = jl.org_id
   WHERE je.org_id = d.org_id AND je.source_document_id = d.id
     AND je.status IN ('posted', 'reversed')
   ORDER BY je.posting_date DESC, jl.line_number
   LIMIT 1
) j ON true
WHERE s.org_id = o.org_id AND s.obligation_id = o.id
  AND s.transaction_currency IS NULL;

UPDATE public.recognition_schedules s
   SET transaction_currency = c.currency,
       transaction_fx_rate = 1
FROM performance_obligations o
JOIN revenue_contracts c ON c.id = o.contract_id AND c.org_id = o.org_id
WHERE s.org_id = o.org_id AND s.obligation_id = o.id
  AND o.document_line_id IS NULL
  AND s.transaction_currency IS NULL;
