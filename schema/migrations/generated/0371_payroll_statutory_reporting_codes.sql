-- OpenBooks forward migration 0371_payroll_statutory_reporting_codes.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.pay_component_earning_classifications
  ADD COLUMN statutory_reporting_category text,
  ADD CONSTRAINT pay_component_earning_classifications_reporting_category
    CHECK (statutory_reporting_category IS NULL
      OR statutory_reporting_category ~ '^[a-z][a-z0-9_]{0,63}$');

ALTER TABLE public.pay_stub_lines
  ADD COLUMN statutory_reporting_code jsonb,
  ADD CONSTRAINT pay_stub_lines_statutory_reporting_code_shape
    CHECK (statutory_reporting_code IS NULL OR (
      jsonb_typeof(statutory_reporting_code) = 'object'
      AND statutory_reporting_code ?& ARRAY['formCode', 'boxCode', 'code', 'label']
      AND jsonb_typeof(statutory_reporting_code->'formCode') = 'string'
      AND jsonb_typeof(statutory_reporting_code->'boxCode') = 'string'
      AND jsonb_typeof(statutory_reporting_code->'code') = 'string'
      AND jsonb_typeof(statutory_reporting_code->'label') = 'string'
    ));

COMMENT ON COLUMN public.pay_component_earning_classifications.statutory_reporting_category IS
  'Pack-declared semantic reporting category; resolved against the earning date and snapshotted on each calculated stub line.';
COMMENT ON COLUMN public.pay_stub_lines.statutory_reporting_code IS
  'Tax form reporting code resolved by the country pack at payroll calculation; immutable stub history must not follow later component setup edits.';
