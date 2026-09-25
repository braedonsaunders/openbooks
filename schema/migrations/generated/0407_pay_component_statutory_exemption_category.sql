-- OpenBooks forward migration 0407_pay_component_statutory_exemption_category.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- A second independent dimension on the 0359 one-to-one earning
-- classification record: the federally exempt compensation class of the
-- earning, when the component pays one. NULL means unclassified (ordinary
-- taxable compensation), never a silent default: states whose publications
-- exempt a class refuse an unclassified line by name instead of guessing.
--
-- The enumerated classes are federal preemptions/deductions only, each with
-- its statute; state-specific service classes (Oklahoma 68 O.S. §2385.1,
-- North Dakota agricultural labor) are modeled in their state packs, never
-- here:
-- - military_pay: U.S. Armed Forces pay excluded from nonresident state
--   withholding (Servicemembers Civil Relief Act as amended by the Military
--   Spouses Residency Relief Act, 50 U.S.C. §4001; e.g. WV Code §11-21-71,
--   Oklahoma Form OK-W-4 Line 9 military income deduction, ND military-pay
--   deduction with voluntary withholding).
-- - rail_carrier: multistate railroad-employee compensation exempt from
--   nonresident state withholding (49 U.S.C. §11502; e.g. Colorado 2026 Wage
--   Withholding Tax Guide, Part 2).
-- - motor_carrier: multistate motor-carrier-employee compensation exempt
--   from nonresident state withholding (49 U.S.C. §14503; e.g. Colorado 2026
--   Wage Withholding Tax Guide, Part 2; ND withholding guideline p. 2).
-- - air_carrier: air-carrier-employee compensation exempt where no more than
--   50% is earned in the state (49 U.S.C. §40116(f); e.g. Colorado 2026 Wage
--   Withholding Tax Guide, Part 2).
-- - seafarer: qualifying crew wages on vessels in foreign, coastwise,
--   intercoastal, interstate, or noncontiguous trade, on which state
--   withholding may not be required (46 U.S.C. §11108(a); WV Code of State
--   Rules §110-21-71.1.2).
ALTER TABLE public.pay_component_earning_classifications
  ADD COLUMN statutory_exemption_category text;

ALTER TABLE public.pay_component_earning_classifications
  ADD CONSTRAINT pay_component_earning_classifications_exemption_category
  CHECK (statutory_exemption_category IS NULL
    OR statutory_exemption_category IN (
      'military_pay', 'rail_carrier', 'motor_carrier', 'air_carrier', 'seafarer'
    ));

COMMENT ON COLUMN public.pay_component_earning_classifications.statutory_exemption_category IS
  'Federally exempt U.S. compensation class of the earning component (military_pay, rail_carrier, motor_carrier, air_carrier, seafarer); NULL is unclassified ordinary pay, which states requiring a classification refuse by name.';
