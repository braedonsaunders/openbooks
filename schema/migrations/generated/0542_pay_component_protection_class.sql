-- OpenBooks forward migration 0542_pay_component_protection_class.
-- A protected deduction names the legal class of order it is (an ordinary
-- creditor garnishment, a support order), because the classes carry
-- different statutory limits: a creditor garnishment may not reach the
-- disposable earnings below an exempt floor, while a support order is
-- limited by its percentage alone. The vocabulary is declared by each
-- country payroll pack; the column stores the declared key and the payroll
-- run refuses a key the employee's pack does not declare. Null keeps the
-- existing behavior: the configured percentage alone.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.pay_components ADD COLUMN protection_class text;
-- A class only means something on a protected deduction, and its key has
-- the shape of a pack-declared machine identifier.
ALTER TABLE public.pay_components ADD CONSTRAINT pay_components_protection_class
  CHECK (protection_class IS NULL
    OR (protection_base <> 'none' AND protection_class ~ '^[a-z][a-z0-9_]{0,63}$'));

COMMENT ON COLUMN public.pay_components.protection_class IS
  'Country-pack-declared class of protected order (creditor garnishment, support order) selecting its statutory limit; null applies the configured percentage alone.';

SELECT public.openbooks_refresh_query_catalog();
