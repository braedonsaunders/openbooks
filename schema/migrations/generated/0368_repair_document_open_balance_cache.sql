-- OpenBooks forward migration 0368_repair_document_open_balance_cache.
-- Recompute the locked, deterministic document projection after the 0358
-- trigger correction so pre-existing non-NULL drift is repaired as well.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $$
DECLARE
  v_org uuid;
BEGIN
  FOR v_org IN SELECT id FROM public.orgs ORDER BY id LOOP
    PERFORM public.recompute_document_open_balances(v_org);
  END LOOP;
END;
$$;
