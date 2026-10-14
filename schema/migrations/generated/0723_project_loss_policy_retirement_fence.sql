-- Fence project loss policy versions with the tenant retirement guard every tenant table carries,
-- so a retiring organization's policy history cannot change while its retirement is in progress.
-- Backfill: none. No row is read or rewritten.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.project_loss_policies FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
