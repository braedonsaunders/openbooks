-- OpenBooks forward migration 0461_project_loss_provision_binding.
-- Bind a governed construction forecast to its existing project accounting identity.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);
ALTER TABLE public.provision_obligations ADD COLUMN project_id uuid;
ALTER TABLE public.provision_obligations ADD CONSTRAINT provision_project_owner_fk
  FOREIGN KEY(org_id,project_id) REFERENCES public.projects(org_id,id);
CREATE UNIQUE INDEX provision_one_project_book ON public.provision_obligations(org_id,project_id,book_id) WHERE project_id IS NOT NULL;
CREATE FUNCTION public.provision_project_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.projects p WHERE p.org_id=NEW.org_id
    AND p.id=NEW.project_id AND p.subsidiary_id=NEW.subsidiary_id) THEN
    RAISE EXCEPTION 'construction loss provision must bind to the project legal entity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER provision_project_binding BEFORE INSERT OR UPDATE ON public.provision_obligations
  FOR EACH ROW EXECUTE FUNCTION public.provision_project_binding();
SELECT public.openbooks_refresh_query_catalog();
