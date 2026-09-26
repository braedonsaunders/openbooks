-- OpenBooks forward migration 0413_ns_remembrance_alternate_day_bank.
--
-- Nova Scotia's Remembrance Day Act grants an employee who
-- works November 11 (and was entitled to wages for 15 of the prior 30 days,
-- for a non-exempt business) another day off WITH PAY — taken on the next
-- working day after vacation or on an agreed date — instead of immediate
-- cash. The grant lives in the entitlement bank as an hours-denominated,
-- employee-specific movement, so the bank needs two things it does not have:
-- an engine binding for the alternate-day plan, and a source-holiday
-- reference plus the take-on date on each movement.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Precheck: the widened system_key set below must already contain every value
-- in use. Only 'vacation' can exist under the current CHECK, so any other
-- value is a hand edit past the constraint, and the migration stops naming
-- it rather than silently legitimising it.
DO $precheck$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(DISTINCT system_key, ', ') INTO offending
    FROM public.entitlement_plans
   WHERE system_key IS NOT NULL AND system_key NOT IN ('vacation');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'entitlement plan(s) carry unknown engine binding(s) %; resolve them before applying 0413', offending;
  END IF;
END;
$precheck$;

-- Dropped first so a runner retry after a lock-timeout does not fail on an
-- already-installed constraint.
ALTER TABLE public.entitlement_plans
  DROP CONSTRAINT IF EXISTS entitlement_plans_system_key;
ALTER TABLE public.entitlement_plans
  ADD CONSTRAINT entitlement_plans_system_key
  CHECK (system_key IS NULL OR system_key IN ('vacation', 'stat_holiday_alternate'));

-- The bound alternate-day plan is hours, manual, and accrue-only: the holiday
-- rule grants it (bank_in) and the operator pays it out (payout) or adjusts
-- it with a note. Any other shape on the binding is a misconfiguration the
-- engine would silently honour, so storage refuses it.
ALTER TABLE public.entitlement_plans
  DROP CONSTRAINT IF EXISTS entitlement_plans_alternate_shape;
ALTER TABLE public.entitlement_plans
  ADD CONSTRAINT entitlement_plans_alternate_shape
  CHECK (system_key IS DISTINCT FROM 'stat_holiday_alternate'
         OR (unit = 'hours' AND accrual_method = 'manual' AND direction = 'accrue'));

ALTER TABLE public.entitlement_ledger
  ADD COLUMN source_holiday_key text,
  ADD COLUMN source_holiday_date date,
  ADD COLUMN take_on date;

-- A source reference is a pair: a key without the date it fired on (or a
-- date without the key) cannot trace a grant back to its statute.
ALTER TABLE public.entitlement_ledger
  DROP CONSTRAINT IF EXISTS entitlement_ledger_source_pair;
ALTER TABLE public.entitlement_ledger
  ADD CONSTRAINT entitlement_ledger_source_pair
  CHECK ((source_holiday_key IS NULL) = (source_holiday_date IS NULL));

-- The alternate day is always AFTER the holiday that earned it: a take-on
-- before the movement date is a backdated agreement, never a valid one.
ALTER TABLE public.entitlement_ledger
  DROP CONSTRAINT IF EXISTS entitlement_ledger_take_on_order;
ALTER TABLE public.entitlement_ledger
  ADD CONSTRAINT entitlement_ledger_take_on_order
  CHECK (take_on IS NULL OR take_on >= movement_date);

COMMENT ON CONSTRAINT entitlement_plans_system_key ON public.entitlement_plans IS
  'Engine bindings a plan may claim: vacation, or the statutory alternate-day-off bank granted by work-triggered holiday rules (0413).';
COMMENT ON CONSTRAINT entitlement_plans_alternate_shape ON public.entitlement_plans IS
  'The alternate-day binding is hours-denominated, manual (granted by the holiday rule, never accrued), and accrue-direction (0413).';
COMMENT ON COLUMN public.entitlement_ledger.source_holiday_key IS
  'Statutory holiday that granted this movement (e.g. remembrance_day), with source_holiday_date (0413).';
COMMENT ON COLUMN public.entitlement_ledger.source_holiday_date IS
  'Date of the statutory holiday that granted this movement; pairs with source_holiday_key (0413).';
COMMENT ON COLUMN public.entitlement_ledger.take_on IS
  'Day the alternate-day entitlement must be taken: the next scheduled workday default, or the audited agreed date (0413).';
