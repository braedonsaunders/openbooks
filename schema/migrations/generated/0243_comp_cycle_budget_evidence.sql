-- OpenBooks forward migration 0243_comp_cycle_budget_evidence.
--
-- Frozen budget evidence for comp-cycle pacing (F02/F03).
--
-- cyclePacing prices every decided line as an annual increase in the
-- cycle's envelope currency. Before this migration pacing summed raw
-- native-currency, native-basis deltas against the envelope — an hourly
-- $1/hr raise paced as $1 against an annual envelope, foreign amounts
-- crossed currencies unconverted — and a zero envelope read as absent.
-- The line already froze its rate/currency/basis at open; this
-- migration freezes the remaining pricing inputs beside them, plus
-- copies of the three cycle-header inputs pacing consumes, and pins all
-- of them with forward guards:
--
--   hrm_comp_cycle_lines gains eight nullable columns, written once by
--   openCycle inside the open transaction, read by pacing, never
--   refilled or repriced afterwards:
--     budget_pricing_date   copy of the cycle effective_on
--     budget_cycle_currency copy of the cycle currency (the envelope ccy)
--     budget_envelope       copy of budget_total (null = null envelope)
--     budget_annual_hours   wage-row annual-hours, hourly lines only
--     budget_fx_rate        oriented line→cycle spot factor (laborFxQuote
--                           at the pricing date), cross-currency lines only
--     budget_fx_asof        winning quote's as-of date (evidence)
--     budget_fx_source      winning quote's source, verbatim (evidence)
--     budget_fx_inverse     winning leg direction (provenance only)
--   Annual same-currency lines need no frozen inputs: their factor is
--   the identity and their NULLs are complete evidence, not gaps.
--   Null-envelope cycles store NULLs they never use (pacing returns
--   early on a null envelope). New non-null-envelope cycles fail the
--   open atomically while a required input is missing, so a decided
--   line on a new cycle always carries its evidence.
--
-- Upgrade behavior (explicit, no invented backfill): pre-0243 rows keep
-- their NULLs. Pacing a decided legacy hourly or cross-currency line
-- without frozen evidence refuses by name (missing historical budget
-- evidence — carry the adjustment into a new cycle; restoring a current
-- wage row cannot recreate the old evidence). Annual same-currency
-- legacy lines pace unchanged. Nothing is backfilled, fabricated, or
-- deleted by this migration.
--
-- Guards: hrm_comp_cycle_lines rows cannot change their cycle,
-- employment, rate, currency, basis or frozen inputs on any path, so a
-- decided line can never be reparented onto a differently priced round
-- (proposals, decisions, reopens and pushes write other columns and
-- keep working); a reopen never reprices: it carries the frozen inputs
-- forward untouched. hrm_comp_cycles rows can correct their header
-- while the round is still a draft with no lines, but once opened the
-- effective_on, currency, budget_total and budget_basis the lines
-- copied at open never move — and the lifecycle never rewinds to
-- draft, so a two-step status reset plus header edit cannot regain
-- draft-edit privileges or disable pacing.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Frozen evidence columns (nullable: legacy rows and identity/null-envelope
-- cases carry NULLs by design, never fabricated values).
-- ---------------------------------------------------------------------------

ALTER TABLE public.hrm_comp_cycle_lines
  ADD COLUMN IF NOT EXISTS budget_pricing_date date,
  ADD COLUMN IF NOT EXISTS budget_cycle_currency char(3),
  ADD COLUMN IF NOT EXISTS budget_envelope numeric(19,4),
  ADD COLUMN IF NOT EXISTS budget_annual_hours numeric(19,4),
  ADD COLUMN IF NOT EXISTS budget_fx_rate numeric(19,10),
  ADD COLUMN IF NOT EXISTS budget_fx_asof date,
  ADD COLUMN IF NOT EXISTS budget_fx_source text,
  ADD COLUMN IF NOT EXISTS budget_fx_inverse boolean;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_budget_hours_positive') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_budget_hours_positive
    CHECK (budget_annual_hours IS NULL OR budget_annual_hours > 0); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_budget_fx_positive') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_budget_fx_positive
    CHECK (budget_fx_rate IS NULL OR budget_fx_rate > 0); END IF; END $$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hrm_comp_cycle_lines_budget_envelope_nonneg') THEN
  ALTER TABLE ONLY public.hrm_comp_cycle_lines ADD CONSTRAINT hrm_comp_cycle_lines_budget_envelope_nonneg
    CHECK (budget_envelope IS NULL OR budget_envelope >= 0); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Freeze guard: the pricing inputs travel with the line and never change.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hrm_comp_cycle_lines_budget_freeze_guard()
RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN
  IF NEW.cycle_id IS DISTINCT FROM OLD.cycle_id
     OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
     OR NEW.current_rate IS DISTINCT FROM OLD.current_rate
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.basis IS DISTINCT FROM OLD.basis
     OR NEW.budget_pricing_date IS DISTINCT FROM OLD.budget_pricing_date
     OR NEW.budget_cycle_currency IS DISTINCT FROM OLD.budget_cycle_currency
     OR NEW.budget_envelope IS DISTINCT FROM OLD.budget_envelope
     OR NEW.budget_annual_hours IS DISTINCT FROM OLD.budget_annual_hours
     OR NEW.budget_fx_rate IS DISTINCT FROM OLD.budget_fx_rate
     OR NEW.budget_fx_asof IS DISTINCT FROM OLD.budget_fx_asof
     OR NEW.budget_fx_source IS DISTINCT FROM OLD.budget_fx_source
     OR NEW.budget_fx_inverse IS DISTINCT FROM OLD.budget_fx_inverse THEN
    RAISE EXCEPTION
      'hrm_comp_cycle_lines budget evidence is frozen at open: cycle_id, employment_id, current_rate, currency, basis and the budget_* inputs of line % cannot be changed — carry the adjustment into a new cycle',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$func$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hrm_comp_cycle_lines_budget_freeze') THEN
  CREATE TRIGGER hrm_comp_cycle_lines_budget_freeze
    BEFORE UPDATE ON public.hrm_comp_cycle_lines
    FOR EACH ROW EXECUTE FUNCTION public.hrm_comp_cycle_lines_budget_freeze_guard(); END IF; END $$;

-- ---------------------------------------------------------------------------
-- Header guard: the cycle inputs pacing copies at open never move either.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hrm_comp_cycles_budget_header_guard()
RETURNS trigger LANGUAGE plpgsql AS $func$
BEGIN
  -- The lifecycle never rewinds to draft: no service path moves a live
  -- round back, so a status reset cannot regain draft-edit privileges.
  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION
      'hrm_comp_cycles lifecycle moves forward only: cycle % left draft and cannot return — open a new round instead',
      OLD.id;
  END IF;
  -- Drafts with no lines correct freely; once the round opens — or any
  -- line exists to carry its copies — the header stays put in every
  -- later state (open, in_review, approved, pushed, closed, cancelled).
  IF (OLD.status <> 'draft'
      OR EXISTS (SELECT 1 FROM public.hrm_comp_cycle_lines l WHERE l.cycle_id = OLD.id))
     AND (NEW.effective_on IS DISTINCT FROM OLD.effective_on
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.budget_total IS DISTINCT FROM OLD.budget_total
       OR NEW.budget_basis IS DISTINCT FROM OLD.budget_basis) THEN
    RAISE EXCEPTION
      'hrm_comp_cycles budget header is frozen at open: effective_on, currency, budget_total and budget_basis of cycle % cannot be changed — open a new round instead',
      OLD.id;
  END IF;
  RETURN NEW;
END;
$func$;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'hrm_comp_cycles_budget_header') THEN
  CREATE TRIGGER hrm_comp_cycles_budget_header
    BEFORE UPDATE ON public.hrm_comp_cycles
    FOR EACH ROW EXECUTE FUNCTION public.hrm_comp_cycles_budget_header_guard(); END IF; END $$;
