-- Effective-dated financial preferences and named exchange-rate series.
-- Existing rates and posted transactions keep their values and identities.
-- Backfill: register the existing rate-type keys and built-in series only.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Tenant-coherent references add only redundant identity indexes; existing UUID primary keys are preserved.
CREATE UNIQUE INDEX fiscal_calendars_org_id_id_unique ON public.fiscal_calendars(org_id,id);
CREATE UNIQUE INDEX form_layouts_org_id_id_unique ON public.form_layouts(org_id,id);
CREATE TABLE public.fx_rate_types (id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  UNIQUE (org_id,id),
 key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'), name text NOT NULL CHECK (length(btrim(name))>0),
 is_active boolean NOT NULL DEFAULT true, UNIQUE(org_id,key));
INSERT INTO public.fx_rate_types(org_id,key,name)
 SELECT id,'spot','Spot' FROM public.orgs UNION ALL SELECT id,'average','Average' FROM public.orgs UNION ALL SELECT id,'historical','Historical' FROM public.orgs;
INSERT INTO public.fx_rate_types(org_id,key,name)
 SELECT DISTINCT f.org_id,f.rate_type,f.rate_type FROM public.fx_rates f
 WHERE f.rate_type NOT IN ('spot','average','historical');
CREATE FUNCTION public.seed_financial_rate_types() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 INSERT INTO public.fx_rate_types(org_id,key,name) VALUES(NEW.id,'spot','Spot'),(NEW.id,'average','Average'),(NEW.id,'historical','Historical');
 RETURN NEW;
END $$;
CREATE TRIGGER seed_financial_rate_types AFTER INSERT ON public.orgs FOR EACH ROW EXECUTE FUNCTION public.seed_financial_rate_types();
ALTER TABLE public.fx_rates ADD CONSTRAINT fx_rates_named_type_fkey FOREIGN KEY(org_id,rate_type) REFERENCES public.fx_rate_types(org_id,key);
CREATE TABLE public.account_translation_policies (id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  UNIQUE (org_id,id),
 account_id uuid NOT NULL, effective_from date NOT NULL,
 general_rate_type text NOT NULL CHECK (general_rate_type IN ('current','average','historical')),
 cash_flow_rate_type text NOT NULL CHECK (cash_flow_rate_type IN ('current','average','historical')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 2000), UNIQUE(org_id,account_id,effective_from),
 FOREIGN KEY(org_id,account_id) REFERENCES public.accounts(org_id,id));
CREATE TABLE public.subsidiary_accounting_preferences (id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
  UNIQUE (org_id,id),
 subsidiary_id uuid NOT NULL, effective_from date NOT NULL, fiscal_calendar_id uuid,
 posting_rate_type text NOT NULL DEFAULT 'spot', require_journal_approval boolean NOT NULL DEFAULT false,
 allow_backdated_posting boolean NOT NULL DEFAULT true, allow_future_posting boolean NOT NULL DEFAULT true,
 default_journal_form_id uuid, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 2000),
 UNIQUE(org_id,subsidiary_id,effective_from),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,fiscal_calendar_id) REFERENCES public.fiscal_calendars(org_id,id),
 FOREIGN KEY(org_id,posting_rate_type) REFERENCES public.fx_rate_types(org_id,key),
 FOREIGN KEY(org_id,default_journal_form_id) REFERENCES public.form_layouts(org_id,id));
CREATE FUNCTION public.financial_policy_version_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Financial policy versions are retained history. Record a new version from its effective date.' USING ERRCODE='23514';
END $$;
CREATE FUNCTION public.financial_preferences_version_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:ledger-setup:'||NEW.org_id,0));
 IF TG_TABLE_NAME='account_translation_policies' THEN
  IF NOT EXISTS(SELECT 1 FROM accounts WHERE org_id=NEW.org_id AND id=NEW.account_id AND is_active AND NOT is_summary AND type<>'statistical') THEN
   RAISE EXCEPTION 'Choose an active monetary posting account for a translation policy.' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.org_id=l.org_id AND e.id=l.entry_id
    WHERE l.org_id=NEW.org_id AND l.account_id=NEW.account_id AND e.status IN('posted','reversed') AND e.posting_date>=NEW.effective_from) THEN
   RAISE EXCEPTION 'A translation policy cannot reinterpret posted activity. Start after the latest posting on this account.' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.fiscal_calendar_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fiscal_calendars WHERE org_id=NEW.org_id AND id=NEW.fiscal_calendar_id AND is_active) THEN
   RAISE EXCEPTION 'Choose an active fiscal calendar of this organization.' USING ERRCODE='23514'; END IF;
  IF coalesce(NEW.fiscal_calendar_id,(SELECT id FROM fiscal_calendars WHERE org_id=NEW.org_id AND is_default AND is_active)) IS DISTINCT FROM public.subsidiary_posting_calendar(NEW.org_id,NEW.subsidiary_id,NEW.effective_from-1) AND (
    NOT EXISTS(SELECT 1 FROM accounting_periods p WHERE p.org_id=NEW.org_id AND p.fiscal_calendar_id=coalesce(NEW.fiscal_calendar_id,(SELECT id FROM fiscal_calendars WHERE org_id=NEW.org_id AND is_default AND is_active)) AND NOT p.is_adjustment AND p.starts_on=NEW.effective_from)
    OR EXISTS(SELECT 1 FROM accounting_periods p WHERE p.org_id=NEW.org_id AND p.fiscal_calendar_id=public.subsidiary_posting_calendar(NEW.org_id,NEW.subsidiary_id,NEW.effective_from-1)
      AND NOT p.is_adjustment AND p.starts_on<NEW.effective_from AND p.ends_on>=NEW.effective_from)) THEN
   RAISE EXCEPTION 'Change fiscal calendars at a shared regular-period boundary. Generate the new calendar periods and choose the first day after the old period ends.' USING ERRCODE='23514'; END IF;
  IF NEW.default_journal_form_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM form_layouts WHERE org_id=NEW.org_id AND id=NEW.default_journal_form_id AND record_type='journal' AND is_active) THEN
   RAISE EXCEPTION 'Choose an active journal form of this organization.' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM fx_rate_types WHERE org_id=NEW.org_id AND key=NEW.posting_rate_type AND is_active) THEN
   RAISE EXCEPTION 'Choose an active posting exchange-rate type.' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.org_id=l.org_id AND e.id=l.entry_id
    WHERE l.org_id=NEW.org_id AND l.subsidiary_id=NEW.subsidiary_id AND e.status IN('posted','reversed') AND e.posting_date>=NEW.effective_from) THEN
   RAISE EXCEPTION 'An entity preference cannot reinterpret posted activity. Start after the latest posting for this entity.' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_translation_policy_guard BEFORE INSERT ON public.account_translation_policies FOR EACH ROW EXECUTE FUNCTION public.financial_preferences_version_guard();
CREATE TRIGGER subsidiary_accounting_preference_guard BEFORE INSERT ON public.subsidiary_accounting_preferences FOR EACH ROW EXECUTE FUNCTION public.financial_preferences_version_guard();
CREATE FUNCTION public.account_translation_rate_type(p_org uuid,p_account uuid,p_date date,p_cash_flow boolean DEFAULT false) RETURNS text
 LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT CASE WHEN p_cash_flow THEN cash_flow_rate_type ELSE general_rate_type END FROM account_translation_policies
 WHERE org_id=p_org AND account_id=p_account AND effective_from<=p_date ORDER BY effective_from DESC LIMIT 1 $$;
CREATE FUNCTION public.subsidiary_posting_calendar(p_org uuid,p_subsidiary uuid,p_date date) RETURNS uuid
 LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $$
 SELECT coalesce((SELECT fiscal_calendar_id FROM subsidiary_accounting_preferences WHERE org_id=p_org AND subsidiary_id=p_subsidiary
   AND effective_from<=p_date ORDER BY effective_from DESC LIMIT 1),
   (SELECT id FROM fiscal_calendars WHERE org_id=p_org AND is_default AND is_active ORDER BY id LIMIT 1)) WHERE p_subsidiary IS NULL OR EXISTS(SELECT 1 FROM subsidiaries WHERE org_id=p_org AND id=p_subsidiary) $$;
ALTER TABLE public.fx_rate_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_rate_types FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.fx_rate_types
 USING (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.fx_rate_types IS 'openbooks:org_isolation:v1';
ALTER TABLE public.account_translation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_translation_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.account_translation_policies
 USING (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.account_translation_policies IS 'openbooks:org_isolation:v1';
ALTER TABLE public.subsidiary_accounting_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subsidiary_accounting_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.subsidiary_accounting_preferences
 USING (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK (current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.subsidiary_accounting_preferences IS 'openbooks:org_isolation:v1';
CREATE TRIGGER account_translation_policies_immutable BEFORE UPDATE OR DELETE ON public.account_translation_policies FOR EACH ROW EXECUTE FUNCTION public.financial_policy_version_immutable();
CREATE TRIGGER subsidiary_accounting_preferences_immutable BEFORE UPDATE OR DELETE ON public.subsidiary_accounting_preferences FOR EACH ROW EXECUTE FUNCTION public.financial_policy_version_immutable();
INSERT INTO public.openbooks_query_catalog_relations(relation,added_in) VALUES
 ('fx_rate_types','0691_financial_rate_preferences_versions'),('account_translation_policies','0691_financial_rate_preferences_versions'),
 ('subsidiary_accounting_preferences','0691_financial_rate_preferences_versions');

SELECT public.openbooks_refresh_query_catalog();

-- An adjustment-only reporting basis is the primary ledger plus its adjustments.
CREATE FUNCTION public.reporting_book_ids(p_org uuid,p_book uuid) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SET search_path=public,pg_catalog AS $$
DECLARE selected accounting_books%ROWTYPE;
BEGIN
 SELECT * INTO selected FROM accounting_books WHERE org_id=p_org AND id=p_book AND is_active;
 IF NOT FOUND THEN RAISE EXCEPTION 'The selected reporting book is unavailable.' USING ERRCODE='23514'; END IF;
 IF NOT selected.is_primary AND selected.posts_gl AND selected.replication_mode='adjustment_only' THEN
  IF EXISTS(SELECT 1 FROM subsidiaries s WHERE s.org_id=p_org AND s.is_active
    AND public.accounting_book_currency(p_org,p_book,s.id)<>s.base_currency) THEN
   RAISE EXCEPTION 'Primary plus adjustments requires the same measurement currency in both books. Use a full translated book for another currency.' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM accounting_books WHERE org_id=p_org AND is_primary AND is_active AND posts_gl) THEN
   RAISE EXCEPTION 'Primary plus adjustments requires an active primary posting book.' USING ERRCODE='23514'; END IF;
  RETURN QUERY SELECT id FROM accounting_books WHERE org_id=p_org AND is_primary AND is_active AND posts_gl;
 END IF;
 RETURN NEXT selected.id;
END $$;

CREATE FUNCTION public.financial_rate_type_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:ledger-setup:'||NEW.org_id,0));
 IF TG_OP='UPDATE' AND (NEW.org_id<>OLD.org_id OR NEW.key<>OLD.key) THEN
  RAISE EXCEPTION 'A named exchange-rate series retains its organization and key.' USING ERRCODE='23514'; END IF;
 IF NOT NEW.is_active AND (NEW.key IN('spot','average','historical') OR EXISTS(
  SELECT 1 FROM subsidiary_accounting_preferences p WHERE p.org_id=NEW.org_id AND p.posting_rate_type=NEW.key
   AND NOT EXISTS(SELECT 1 FROM subsidiary_accounting_preferences next WHERE next.org_id=p.org_id AND next.subsidiary_id=p.subsidiary_id
     AND next.effective_from>p.effective_from AND next.effective_from<=current_date))) THEN
  RAISE EXCEPTION 'An authoritative exchange-rate series cannot be deactivated. Record and activate successor entity preferences first.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_rate_type_guard BEFORE INSERT OR UPDATE ON public.fx_rate_types FOR EACH ROW EXECUTE FUNCTION public.financial_rate_type_guard();
CREATE FUNCTION public.financial_rate_quote_type_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM fx_rate_types WHERE org_id=NEW.org_id AND key=NEW.rate_type AND is_active) THEN
  RAISE EXCEPTION 'Choose an active registered exchange-rate type in Setup.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER financial_rate_quote_type_guard BEFORE INSERT OR UPDATE OF rate_type ON public.fx_rates FOR EACH ROW EXECUTE FUNCTION public.financial_rate_quote_type_guard();
