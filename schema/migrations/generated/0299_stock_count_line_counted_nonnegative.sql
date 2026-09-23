-- OpenBooks forward migration 0299_stock_count_line_counted_nonnegative.
--
-- A physical count is never negative, but stock_count_lines.counted_quantity
-- carried no CHECK and recordCountedQuantity checked width and scale only.
-- A count of -1 was accepted, reviewed, and posted as a negative variance,
-- and with allow_negative_inventory the position itself could rest at -1
-- while the count read posted — a negative observation with no physical
-- meaning. Negatives are never meaningful here: an empty bin counts 0, and
-- a correction re-records the observation (or opens a new count once
-- posted), it does not go below zero.
--
-- Storage now refuses a negative counted_quantity (NULL stays legal: an
-- uncounted line). The engine preflights the same gate at record and at
-- variance math with a remedy-naming refusal; only storage can arbitrate a
-- writer that bypasses the engine, which is why the guard lives here as
-- well as there.
--
-- No existing row is expected to violate the CHECK (every writer paths
-- through recordCountedQuantity, which refuses); the pre-check below
-- refuses by name, listing the offending counts and lines, rather than
-- letting ADD CONSTRAINT fail with a bare check violation. Nothing is
-- auto-zeroed: re-record the true physical count before applying 0299.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

DO $precheck$
DECLARE
  violation_count integer;
  offending text;
BEGIN
  SELECT count(*) INTO violation_count
    FROM public.stock_count_lines
   WHERE counted_quantity IS NOT NULL AND counted_quantity < 0;
  IF violation_count > 0 THEN
    SELECT string_agg(entry, E'\n') INTO offending FROM (
      SELECT format('count %s line %s (item %s at stock location %s) counted %s',
               stock_count_id, id, item_id, stock_location_id, counted_quantity) AS entry
        FROM public.stock_count_lines
       WHERE counted_quantity IS NOT NULL AND counted_quantity < 0
       ORDER BY stock_count_id, id
       LIMIT 5
    ) listed;
    RAISE EXCEPTION E'stock_count_lines holds % line(s) with a negative counted_quantity; re-record the true physical count (zero or more) on each before applying 0299. First lines:\n%', violation_count, offending;
  END IF;
END;
$precheck$;

ALTER TABLE public.stock_count_lines
  ADD CONSTRAINT stock_count_lines_counted_nonnegative
  CHECK (counted_quantity IS NULL OR counted_quantity >= 0);

COMMENT ON CONSTRAINT stock_count_lines_counted_nonnegative ON public.stock_count_lines IS
  'A physical count is never negative: an empty bin counts 0. Negatives accepted before 0299 posted phantom negative variances (0299).';
