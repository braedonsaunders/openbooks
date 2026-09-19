-- OpenBooks forward migration 0187_pay_component_treatment_shape.
--
-- WHY THE ENUMERATION IS GOING AWAY. `pension_f` is T4127 factor F,
-- `union_dues` is U1, `alimony` is F2 — every permitted value is CANADIAN.
-- The CHECK below is the storage-layer version of the hardcoded treatment
-- list the component dialog used to offer every country: adding one
-- treatment (AU salary sacrifice) would move the wall one value further out,
-- the next pack would need another migration, and a pack-declared
-- vocabulary cannot live in a CHECK constraint at all. The precedent is
-- 0175 on the sibling `country` column of this same table (and 0176 on
-- `system_key`): the enumeration becomes a SHAPE, and the vocabulary moves
-- into the pack declarations.
--
-- WHAT THE SHAPE ADMITS AND WHAT IT STILL REFUSES. The new CHECK admits any
-- non-empty lower-snake identifier (`^[a-z][a-z0-9_]{0,63}$`): every value
-- the old enumeration admitted ('none', 'pension_f', 'union_dues',
-- 'alimony') matches, so it validates cleanly with no backfill and no data
-- change, and any future pack-declared treatment ('salary_sacrifice' today)
-- sails through. It still refuses the typo class at the storage layer:
-- uppercase ('Pension_F'), spaces ('salary sacrifice'), punctuation
-- ('sacrifice!'), empties, leading digits ('2nd_half') and non-ASCII. An
-- operator who mistypes a treatment still gets a constraint violation; an
-- operator who picks a legitimate pack-declared treatment does not.
--
-- THE PACK DECLARATION IS NOW THE AUTHORITY. The database no longer knows
-- which treatments exist — each pack's `deductionTreatments`
-- (engine/src/payroll/packs.ts, computed in
-- engine/src/payroll/treatment-bases.ts) is the membership list, and the
-- setup write path (`payComponentTreatmentProblem`, asked at the API
-- boundary for creates and edits alike) refuses an undeclared treatment BY
-- NAME, naming the treatments the scope declares. A bare regex where an
-- enumeration used to be is deliberate: membership is a pack fact, shape is
-- a storage fact, and neither layer answers the other's question.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.pay_components DROP CONSTRAINT IF EXISTS pay_components_tax_treatment;
ALTER TABLE public.pay_components ADD CONSTRAINT pay_components_tax_treatment
  CHECK (tax_treatment ~ '^[a-z][a-z0-9_]{0,63}$');

COMMENT ON CONSTRAINT pay_components_tax_treatment ON public.pay_components IS
  'Treatment shape check (0187): non-empty lower-snake identifier. Deliberately NOT an enumeration — packs declare which treatments exist (PayrollCountryPack.deductionTreatments, enforced at the API boundary by payComponentTreatmentProblem); the database only rejects malformed values.';
