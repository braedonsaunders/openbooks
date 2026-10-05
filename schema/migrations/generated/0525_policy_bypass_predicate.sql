-- OpenBooks forward migration 0525_policy_bypass_predicate.
-- Re-create the two tenant isolation policies that still read the raw
-- bypass GUC, delegating the bypass test to the privileged predicate.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DROP POLICY IF EXISTS tenant_isolation ON public.pay_component_department_expenses;
CREATE POLICY tenant_isolation ON public.pay_component_department_expenses
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

DROP POLICY IF EXISTS org_isolation ON public.payment_disputes;
CREATE POLICY org_isolation ON public.payment_disputes
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));
