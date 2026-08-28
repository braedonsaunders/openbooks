-- OpenBooks forward migration 0064_order_quantity_progress_precision.
--
-- Order-line quantities are numeric(28,8) commercial values. The fulfillment
-- and billing progress columns used the ledger money type (numeric(19,4)),
-- which made a valid line such as 1.00000001 impossible to advance exactly.
-- Widen the progress columns without changing existing four-decimal values.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.document_lines
  ALTER COLUMN quantity_fulfilled TYPE numeric(28,8)
    USING quantity_fulfilled::numeric(28,8),
  ALTER COLUMN quantity_billed TYPE numeric(28,8)
    USING quantity_billed::numeric(28,8);

ALTER TABLE public.document_lines
  ALTER COLUMN quantity_fulfilled SET DEFAULT '0'::numeric,
  ALTER COLUMN quantity_billed SET DEFAULT '0'::numeric;

COMMENT ON COLUMN public.document_lines.quantity_fulfilled IS
  'Commercial quantity fulfilled against this order line, preserved to eight decimal places.';

COMMENT ON COLUMN public.document_lines.quantity_billed IS
  'Commercial quantity billed or converted from this order line, preserved to eight decimal places.';
