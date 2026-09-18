-- OpenBooks forward migration 0179_pay_component_credit_kind.
--
-- WHY BOTH KIND CHECKS ARE WIDENING. The generic `credit` line kind landed
-- with the F-reg-003 architecture work (engine/src/payroll/packs.ts types the
-- slot as `kind: "deduction" | "employer_contribution" | "credit"`): a pack
-- can declare a component the employer PAYS the employee and reclaims from
-- the tax authority — Italy's trattamento integrativo and c. 4 somma
-- (ti_payout/somma_payout, engine/src/payroll/it/pack.ts). The code is
-- unit-proven end to end, but the storage layer still enumerates only the
-- three pre-credit kinds, so no Italian org can seed those components or
-- write their stub lines: seeding dies on pay_components_kind and paying
-- dies on pay_stub_lines_kind. Widening one without the other leaves a stub
-- line that cannot be written for a component that can, so both go together.
--
-- IDENTICAL BEHAVIOUR FOR EXISTING ROWS. Both columns only ever hold
-- 'earning', 'deduction' or 'employer_contribution' today (the old CHECKs
-- enforced it), and the new CHECKs admit every one of those values plus
-- 'credit': no backfill, no data rewrite, no payroll number moves. A credit
-- is earnings-assessed and reclaimed via the tax-authority remittance — it
-- changes which kinds are storable, not what any existing kind means.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.pay_components DROP CONSTRAINT IF EXISTS pay_components_kind;
ALTER TABLE public.pay_components ADD CONSTRAINT pay_components_kind
  CHECK (kind = ANY (ARRAY['earning'::text, 'deduction'::text, 'employer_contribution'::text, 'credit'::text]));

ALTER TABLE public.pay_stub_lines DROP CONSTRAINT IF EXISTS pay_stub_lines_kind;
ALTER TABLE public.pay_stub_lines ADD CONSTRAINT pay_stub_lines_kind
  CHECK (kind = ANY (ARRAY['earning'::text, 'deduction'::text, 'employer_contribution'::text, 'credit'::text]));

COMMENT ON CONSTRAINT pay_components_kind ON public.pay_components IS
  'Component kinds (0179): earning, deduction, employer_contribution, credit. Credit pays a refundable employment credit the employer reclaims from the tax authority (engine/src/payroll/packs.ts).';
COMMENT ON CONSTRAINT pay_stub_lines_kind ON public.pay_stub_lines IS
  'Stub line kinds (0179): mirrors pay_components_kind so every seedable component kind is payable.';
