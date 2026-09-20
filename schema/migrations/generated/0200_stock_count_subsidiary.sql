-- OpenBooks forward migration 0200_stock_count_subsidiary.
--
-- WHY THIS COLUMN EXISTS. A stock count is a claim about ONE legal entity's
-- stock at a moment: its snapshot (expected_quantity) is read per subsidiary
-- from the cost layers, its variances post per subsidiary through
-- adjustInventory into that subsidiary's books, and the closed-period fence
-- is evaluated per subsidiary and book. The stock_counts row is the evidence
-- joining those three acts, so the owning subsidiary belongs ON THE ROW, not
-- inferred from whoever happens to post it. A snapshot whose subject is
-- whoever is logged in is not evidence.
--
-- WHY COUNT-AND-RAISE INSTEAD OF A BACKFILL. No code in this repository has
-- ever written stock_counts — that is exactly why the cycle-count workflow
-- is being built on it now — so the table SHOULD be empty everywhere. But
-- that cannot be proved from every vantage (production is not always
-- reachable), and a backfilled subsidiary would be a GUESS about whose stock
-- a row describes: the one case a guess does not catch is the case where the
-- numbers happen to match, and a zero variance posted against the wrong
-- subsidiary is a silent wrong answer, not a caught error. So the migration
-- proves emptiness instead of assuming it: any row at all refuses the
-- upgrade with the row count and the human decision required, leaving the
-- table untouched. When the world is as expected (empty), the column lands
-- NOT NULL — the strong constraint the lifecycle wants — with no backfill
-- because there is nothing truthful to write.
--
-- SAFETY ARGUMENT: THE HAPPY PATH TOUCHES NO DATA. The guard runs first and
-- selects only; on an empty table the migration adds one NOT NULL column
-- (instant on zero rows), one deferrable FK in the house shape
-- (subsidiary_id → subsidiaries(id), matching every other subsidiary edge),
-- and a column comment. No existing row can gain a value, no reader selects
-- by position, and the openbooks_query projection is untouched (a governed
-- read surface gains columns only through its own view migrations, exactly
-- as 0191 left its new profile columns unprojected).

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- A snapshot is a claim about a legal entity's stock, and a claim whose
-- subject would have to be guessed is not evidence. Refuse the upgrade
-- rather than inventing a subsidiary for rows no code path could have
-- scoped; the operator must attribute each row to its owning subsidiary
-- (or confirm the rows are stray and remove them) before this constraint
-- can be installed.
DO $preflight$
DECLARE
  unexpected bigint;
BEGIN
  SELECT count(*) INTO unexpected FROM public.stock_counts;
  IF unexpected > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = '0200 refused: public.stock_counts holds ' || unexpected ||
        ' row(s) with no owning subsidiary',
      DETAIL = jsonb_build_object(
        'table', 'stock_counts',
        'row_count', unexpected
      )::text,
      HINT = 'Attribute every stock_counts row to its owning subsidiary (or confirm the rows are stray and remove them), then retry the upgrade. This migration will not guess a legal entity for existing rows.';
  END IF;
END
$preflight$;

ALTER TABLE public.stock_counts
  ADD COLUMN subsidiary_id uuid NOT NULL;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_counts_subsidiary_id_fkey') THEN
  ALTER TABLE ONLY public.stock_counts ADD CONSTRAINT stock_counts_subsidiary_id_fkey
    FOREIGN KEY (subsidiary_id) REFERENCES public.subsidiaries(id) DEFERRABLE; END IF; END $$;

COMMENT ON COLUMN public.stock_counts.subsidiary_id IS
  'Owning legal entity whose stock the count snapshots and whose books receive its variances (0200): the snapshot, the drift check, and every adjustment movement are scoped to this subsidiary, never inferred from the posting session.';
