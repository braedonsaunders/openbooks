-- OpenBooks forward migration 0484_pay_components_unit_of_measure.
--
-- A component's units are either HOURS or a QUANTITY (trips, meals, units of
-- incentive). Every existing component reads as hours, which is exactly the
-- behaviour it has today: only hours-unit lines feed an hours basis
-- (per-hour rates, benefit contribution hours bases, insurable-hours and
-- wage-hour reports), and quantity lines never do. A per-hour basis pays its
-- rate against the run's hours, so it cannot count quantities — the check
-- below refuses that combination for every writer.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.pay_components
  ADD COLUMN unit_of_measure text NOT NULL DEFAULT 'hours';

ALTER TABLE public.pay_components
  ADD CONSTRAINT pay_components_unit_of_measure
  CHECK (unit_of_measure = ANY (ARRAY['hours'::text, 'quantity'::text]));

ALTER TABLE public.pay_components
  ADD CONSTRAINT pay_components_per_hour_hours
  CHECK (basis <> 'per_hour' OR unit_of_measure = 'hours');
