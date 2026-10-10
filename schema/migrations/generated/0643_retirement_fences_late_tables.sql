-- OpenBooks forward migration 0643_retirement_fences_late_tables.
--
-- Tables introduced after the production retirement contracts carry tenant
-- rows but missed the retirement fence: hrm_job_descriptions (0634) was
-- classified without a fence, and warehouse_defaults (0642) arrived with
-- neither classification nor fence. Either gap blocks the native tenant
-- retirement plan's guard contract, so a retirement refuses with
-- retirement_guard_contract_changed and tenant_catalog_source_mismatch.
--
-- Attach the standard tenant_retirement_fence trigger to both tables,
-- create-if-absent so the migration reapplies cleanly. No data or backfill:
-- the fence only governs future writes, and both tables are empty on the
-- coordinated lane outside tenant fixtures.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $fences$
DECLARE target record;
BEGIN
 FOR target IN SELECT * FROM (VALUES
('hrm_job_descriptions'),
('warehouse_defaults')
 ) AS expected(table_name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=target.table_name AND t.tgname='tenant_retirement_fence') THEN
   EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()',target.table_name);
  END IF;
 END LOOP;
END $fences$;
