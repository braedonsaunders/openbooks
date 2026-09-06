-- OpenBooks forward migration 0093_pay_stub_filing_account_snapshot.
-- No backfill from mutable employee/default settings: they do not establish
-- the original filing identity. Legacy rows need evidence-backed reconciliation.
ALTER TABLE public.pay_stubs ADD COLUMN filing_account_id uuid;
ALTER TABLE public.pay_stubs ADD COLUMN filing_account_source text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.pay_stubs ADD COLUMN filing_account_evidence jsonb;
CREATE UNIQUE INDEX payroll_filing_accounts_org_id_id_unique
  ON public.payroll_filing_accounts(org_id, id);
ALTER TABLE public.pay_stubs ADD CONSTRAINT pay_stubs_filing_account_tenant_fkey
  FOREIGN KEY (org_id, filing_account_id) REFERENCES public.payroll_filing_accounts(org_id, id)
  DEFERRABLE INITIALLY IMMEDIATE;
CREATE INDEX pay_stubs_filing_account ON public.pay_stubs(org_id, filing_account_id);
ALTER TABLE public.pay_stubs ADD CONSTRAINT pay_stubs_filing_account_evidence CHECK (
  (filing_account_source = 'unknown' AND filing_account_id IS NULL AND filing_account_evidence IS NULL) OR
  (filing_account_source IN ('calculation', 'insertion') AND filing_account_evidence IS NULL) OR
  (filing_account_source = 'reconciled' AND filing_account_evidence IS NOT NULL
    AND jsonb_typeof(filing_account_evidence) = 'object'
    AND coalesce(jsonb_typeof(filing_account_evidence->'reason') = 'string', false)
    AND coalesce(jsonb_typeof(filing_account_evidence->'reference') = 'string', false)
    AND length(trim(filing_account_evidence->>'reason')) > 0
    AND length(trim(filing_account_evidence->>'reference')) > 0)
);

CREATE OR REPLACE FUNCTION public.pay_stub_filing_account_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.filing_account_source = 'unknown' THEN
      -- Old application writers still capture attribution at INSERT, before
      -- any subsequent profile/default edit. This is not a legacy backfill.
      SELECT coalesce(prof.filing_account_id,
        (SELECT fa.id FROM public.payroll_filing_accounts fa
          WHERE fa.org_id = NEW.org_id AND fa.country = NEW.country
            AND fa.is_active AND fa.is_default))
        INTO NEW.filing_account_id
        FROM public.employee_payroll_profiles prof
       WHERE prof.org_id = NEW.org_id AND prof.employee_party_id = NEW.employee_party_id;
      NEW.filing_account_source := 'insertion';
    END IF;
    IF NEW.filing_account_source NOT IN ('calculation', 'insertion') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'pay_stub_historical_filing_account',
        MESSAGE = 'New payroll must capture its filing account at calculation or insertion.';
    END IF;
  ELSE
    IF ROW(NEW.org_id, NEW.filing_account_id, NEW.filing_account_source, NEW.filing_account_evidence)
       IS NOT DISTINCT FROM
       ROW(OLD.org_id, OLD.filing_account_id, OLD.filing_account_source, OLD.filing_account_evidence) THEN
      RETURN NEW;
    END IF;
    IF OLD.filing_account_source <> 'unknown' OR NEW.filing_account_source <> 'reconciled'
       OR NEW.updated_by IS NULL
       OR (to_jsonb(NEW) - ARRAY['filing_account_id','filing_account_source','filing_account_evidence','updated_at','updated_by'])
          IS DISTINCT FROM
          (to_jsonb(OLD) - ARRAY['filing_account_id','filing_account_source','filing_account_evidence','updated_at','updated_by']) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'pay_stub_historical_filing_account',
        MESSAGE = 'Payroll filing attribution is immutable. Only unknown legacy attribution can be reconciled with original evidence, a reason, and an actor.';
    END IF;
    NEW.updated_at := clock_timestamp();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
    VALUES (NEW.org_id, 'pay_stubs', NEW.id, 'update',
      jsonb_build_object('operation', 'reconcile_filing_account', 'before', to_jsonb(OLD),
                        'after', to_jsonb(NEW), 'evidence', NEW.filing_account_evidence), NEW.updated_by);
  END IF;

  IF NEW.filing_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.payroll_filing_accounts fa
     WHERE fa.org_id = NEW.org_id AND fa.id = NEW.filing_account_id
       AND fa.country = NEW.country
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'pay_stub_filing_account_country',
      MESSAGE = 'Payroll filing account must belong to the stub organization and country.';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pay_stub_filing_account_guard BEFORE INSERT OR UPDATE ON public.pay_stubs
FOR EACH ROW EXECUTE FUNCTION public.pay_stub_filing_account_guard();
COMMENT ON COLUMN public.pay_stubs.filing_account_id IS
  'Filing identity captured for this payroll. A captured null is explicitly unassigned; never resolve it from a later profile/default.';
COMMENT ON COLUMN public.pay_stubs.filing_account_source IS
  'calculation = new engine; insertion = rolling old writer; unknown = legacy evidence required; reconciled = original evidence recorded with actor and immutable audit.';
COMMENT ON COLUMN public.pay_stubs.filing_account_evidence IS
  'Original payroll evidence reference and reconciliation reason; required only for a one-time resolution of unknown legacy attribution.';
SELECT public.openbooks_refresh_query_catalog();
