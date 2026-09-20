-- OpenBooks forward migration 0199_drop_form_response_steps.
--
-- WHY THE TABLE GOES. form_response_steps was declared in the 0001 baseline
-- as a per-step actor/action breadcrumb under each form_responses row, but
-- the Forms submission runner was built to record whole submissions into
-- form_responses and the breadcrumb was never wired in: no insert, no
-- select, no reference anywhere in engine/, web/, docs/, scripts/,
-- packages/, or e2e/. An unwritten audit trail is worse than no audit
-- trail — its presence in the schema promises per-step evidence the product
-- cannot produce, and a future reader would either trust the empty table or
-- build on a writer contract nothing honours. Reviewed decision: drop it;
-- the sibling unused tables are being built, this one is not.
--
-- WHY THE MIGRATION REFUSES ON ROWS. "Unused" is a claim about code, and
-- code is not the only writer — an operator with SQL access could have
-- stored rows directly. A drop that destroys tenant history on an
-- assumption is the destructive-toggle shape this repository refuses, so
-- the migration counts first and raises loudly on any row found instead of
-- dropping. An unused table WITH data is a different decision and belongs
-- to a reviewer holding that evidence, not to this migration.
--
-- SAFETY ARGUMENT: NOTHING CAN OBSERVE THE DROP. No published migration
-- after 0001 names the table, no governed view projects it, and no code
-- path reads or writes it, so removing it moves no stored value any caller
-- can see. DROP TABLE carries the dependent objects with it — the
-- form_response_steps_response index, the org_isolation RLS policy, and the
-- primary-key constraint — so there is no orphaned policy or index left
-- behind, and no separate DROP POLICY / DROP INDEX statements that could
-- drift from the table's fate. The definer (schema/src/forms.ts) is updated
-- in the same change so no prose claims a table that no longer exists.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $$
DECLARE
  n bigint;
BEGIN
  IF to_regclass('public.form_response_steps') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE 'SELECT count(*) FROM public.form_response_steps' INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'form_response_steps holds % rows; refusing to drop a table carrying history — an unused table with data is a reviewer decision, not a migration', n;
  END IF;
  EXECUTE 'DROP TABLE public.form_response_steps';
END $$;
