-- OpenBooks forward migration 0459_provision_obligations.
-- Bind independently approved provision assessments to immutable accounting
-- identities. Estimates and reviews remain in the financial-change evidence
-- ledger; liability balances are derived from posted journals.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.provision_obligations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE RESTRICT,
  subsidiary_id uuid NOT NULL,
  book_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  currency text NOT NULL REFERENCES public.currencies(code),
  expense_account_id uuid NOT NULL,
  liability_account_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, book_id) REFERENCES public.accounting_books(org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, expense_account_id) REFERENCES public.accounts(org_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (org_id, liability_account_id) REFERENCES public.accounts(org_id, id) ON DELETE RESTRICT,
  CHECK (expense_account_id <> liability_account_id)
);
ALTER TABLE public.provision_obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provision_obligations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.provision_obligations
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));

CREATE FUNCTION public.provision_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'provision accounting identity is immutable; release the old obligation through an approved assessment and create the corrected obligation';
END
$$;
CREATE TRIGGER provision_identity_immutable BEFORE UPDATE OR DELETE ON public.provision_obligations
  FOR EACH ROW EXECUTE FUNCTION public.provision_identity_guard();

DO $$
DECLARE domain_constraint text;
BEGIN
  SELECT conname INTO STRICT domain_constraint FROM pg_constraint
   WHERE conrelid='public.financial_changes'::regclass AND contype='c'
     AND pg_get_constraintdef(oid) LIKE '%lease%revenue%asset%consolidation%manufacturing%';
  EXECUTE format('ALTER TABLE public.financial_changes DROP CONSTRAINT %I', domain_constraint);
  EXECUTE format('ALTER TABLE public.financial_changes ADD CONSTRAINT %I CHECK(domain IN (''lease'',''revenue'',''asset'',''consolidation'',''manufacturing'',''provision''))', domain_constraint);
END
$$;

CREATE FUNCTION public.provision_change_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.domain='provision' AND NOT EXISTS (
    SELECT 1 FROM public.provision_obligations p WHERE p.org_id=NEW.org_id
      AND p.id=NEW.subject_id AND p.subsidiary_id=NEW.subsidiary_id
      AND NEW.operation='provision_assessment'
      AND NEW.payload->'requiredSubsidiaryIds'=jsonb_build_array(p.subsidiary_id::text)
  ) THEN
    RAISE EXCEPTION 'provision assessment must bind to its organization and legal entity';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER provision_change_binding BEFORE INSERT OR UPDATE ON public.financial_changes
  FOR EACH ROW EXECUTE FUNCTION public.provision_change_binding_guard();
SELECT public.openbooks_refresh_query_catalog();
