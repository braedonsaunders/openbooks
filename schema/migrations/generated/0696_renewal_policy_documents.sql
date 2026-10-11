-- Dated renewal terms, reminders and native commercial document provenance.
CREATE TABLE public.subscription_renewal_policies (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
  subscription_id uuid NOT NULL, subsidiary_id uuid NOT NULL,
  effective_from date NOT NULL, effective_to date NOT NULL,
  owner_id uuid NOT NULL REFERENCES public.users(id),
  reminder_days jsonb NOT NULL DEFAULT '[{"days":30},{"days":7}]', generation_lead_days integer NOT NULL CHECK (generation_lead_days BETWEEN 0 AND 3660),
  document_kind text NOT NULL CHECK (document_kind IN ('quote','sales_order')),
  uplift_percent numeric(19,4) NOT NULL CHECK (uplift_percent >= 0), term_months integer NOT NULL CHECK (term_months BETWEEN 1 AND 1200),
  reason text NOT NULL CHECK (length(btrim(reason)) >= 8),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid REFERENCES public.users(id),
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES public.users(id),
  UNIQUE(org_id,id), FOREIGN KEY(org_id,subscription_id) REFERENCES public.subscriptions(org_id,id),
  FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
  CHECK (effective_to >= effective_from), CHECK (jsonb_typeof(reminder_days)='array'),
  EXCLUDE USING gist (org_id WITH =, subscription_id WITH =, daterange(effective_from,effective_to,'[]') WITH &&)
);
ALTER TABLE public.notifications ADD CONSTRAINT notifications_renewal_org_id_id UNIQUE(org_id,id);
CREATE TABLE public.subscription_renewal_occurrences (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
  policy_id uuid NOT NULL, subscription_id uuid NOT NULL, term_ends_on date NOT NULL,
  occurrence text NOT NULL, document_id uuid, notification_id uuid,
  snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), actor_id uuid NOT NULL REFERENCES public.users(id),
  UNIQUE(org_id,subscription_id,term_ends_on,occurrence),
  FOREIGN KEY(org_id,policy_id) REFERENCES public.subscription_renewal_policies(org_id,id),
  FOREIGN KEY(org_id,subscription_id) REFERENCES public.subscriptions(org_id,id),
  FOREIGN KEY(org_id,document_id) REFERENCES public.documents(org_id,id),
  FOREIGN KEY(org_id,notification_id) REFERENCES public.notifications(org_id,id)
);
CREATE FUNCTION public.renewal_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE day jsonb;
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Renewal policy and occurrence evidence is immutable; create a new dated policy'; END IF;
 IF TG_TABLE_NAME='subscription_renewal_policies' THEN
  IF jsonb_array_length(NEW.reminder_days)>20 THEN RAISE EXCEPTION 'At most twenty renewal reminder offsets are allowed'; END IF;
  FOR day IN SELECT value FROM jsonb_array_elements(NEW.reminder_days) LOOP
   IF jsonb_typeof(day)<>'object' OR jsonb_typeof(day->'days') IS DISTINCT FROM 'number' OR (day->>'days') !~ '^[0-9]+$' OR (day->>'days')::numeric>3660 THEN
    RAISE EXCEPTION 'Renewal reminder days must be whole numbers from zero through 3660';
   END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.subscriptions s JOIN public.parties p ON p.org_id=s.org_id AND p.id=s.customer_id
    JOIN public.subsidiaries sub ON sub.org_id=p.org_id AND sub.id=NEW.subsidiary_id
    WHERE s.org_id=NEW.org_id AND s.id=NEW.subscription_id AND coalesce(p.subsidiary_id,(SELECT id FROM public.subsidiaries WHERE org_id=NEW.org_id AND parent_id IS NULL))=NEW.subsidiary_id)
   THEN RAISE EXCEPTION 'Renewal policy must use the subscription customer legal entity'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER renewal_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON public.subscription_renewal_policies FOR EACH ROW EXECUTE FUNCTION public.renewal_policy_guard();
CREATE TRIGGER renewal_occurrence_guard BEFORE UPDATE OR DELETE ON public.subscription_renewal_occurrences FOR EACH ROW EXECUTE FUNCTION public.renewal_policy_guard();
ALTER TABLE public.subscription_renewal_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_renewal_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.subscription_renewal_policies USING (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
ALTER TABLE public.subscription_renewal_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_renewal_occurrences FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.subscription_renewal_occurrences USING (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.subscription_renewal_policies FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.subscription_renewal_occurrences FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
