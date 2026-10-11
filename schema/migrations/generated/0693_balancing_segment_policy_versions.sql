-- Generic segment balancing policies are effective-dated and retain their account history.
-- Backfill: none. Existing specialized balancing providers keep their policies.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.segment_balancing_policies(id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid, UNIQUE(org_id,id),
 segment_key text NOT NULL,effective_from date NOT NULL,clearing_account_id uuid NOT NULL,
 priority integer NOT NULL DEFAULT 100,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 2000),
 UNIQUE(org_id,segment_key,effective_from),
 FOREIGN KEY(org_id,segment_key) REFERENCES public.segment_definitions(org_id,key),
 FOREIGN KEY(org_id,clearing_account_id) REFERENCES public.accounts(org_id,id));
CREATE FUNCTION public.segment_balancing_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:ledger-setup:'||NEW.org_id,0));
 IF NOT EXISTS(SELECT 1 FROM segment_definitions WHERE org_id=NEW.org_id AND key=NEW.segment_key AND is_active AND is_balancing) THEN
  RAISE EXCEPTION 'Choose an active balancing segment.' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM accounts WHERE org_id=NEW.org_id AND id=NEW.clearing_account_id AND is_active AND NOT is_summary
   AND currency_restriction IS NULL AND type IN('asset_current_other','asset_other','liability_current_other','liability_long_term')) THEN
  RAISE EXCEPTION 'Choose an unrestricted active balance-sheet clearing account.' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM journal_entries WHERE org_id=NEW.org_id AND status IN('posted','reversed') AND posting_date>=NEW.effective_from) THEN
  RAISE EXCEPTION 'Start the balancing policy after the latest posting date; posted entries retain their original balancing policy.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER segment_balancing_policy_guard BEFORE INSERT ON public.segment_balancing_policies FOR EACH ROW EXECUTE FUNCTION public.segment_balancing_policy_guard();
ALTER TABLE public.segment_balancing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.segment_balancing_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.segment_balancing_policies
 USING(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.segment_balancing_policies IS 'openbooks:org_isolation:v1';
CREATE TRIGGER segment_balancing_policies_immutable BEFORE UPDATE OR DELETE ON public.segment_balancing_policies FOR EACH ROW EXECUTE FUNCTION public.financial_policy_version_immutable();
INSERT INTO public.openbooks_query_catalog_relations(relation,added_in) VALUES('segment_balancing_policies','0693_balancing_segment_policy_versions');
SELECT public.openbooks_refresh_query_catalog();

CREATE FUNCTION public.journal_generic_segment_balance_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE bad record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM journal_entries WHERE org_id=NEW.org_id AND id=NEW.id AND status IN('posted','reversed')) THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('openbooks:ledger-setup:'||NEW.org_id,0));
 SELECT d.key,l.subsidiary_id,sum(l.amount) AS total INTO bad FROM journal_lines l
 JOIN segment_definitions d ON d.org_id=l.org_id AND d.is_active AND d.is_balancing
 WHERE l.org_id=NEW.org_id AND l.entry_id=NEW.id
 GROUP BY d.key,l.subsidiary_id,CASE d.storage_column WHEN 'subsidiary_id' THEN l.subsidiary_id::text
  WHEN 'department_id' THEN l.department_id::text WHEN 'project_id' THEN l.project_id::text
  WHEN 'location_id' THEN l.location_id::text WHEN 'class_id' THEN l.class_id::text ELSE l.extra_dims->>d.key END
 HAVING sum(l.amount)<>0 LIMIT 1;
 IF FOUND THEN RAISE EXCEPTION 'The journal must balance per entity and value of balancing segment %.',bad.key USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_generic_segment_balance_guard AFTER INSERT OR UPDATE ON public.journal_entries
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.journal_generic_segment_balance_guard();
CREATE FUNCTION public.segment_balancing_activation_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:ledger-setup:'||NEW.org_id,0));
 IF TG_OP='UPDATE' AND (NEW.key IS DISTINCT FROM OLD.key OR NEW.storage_column IS DISTINCT FROM OLD.storage_column) AND EXISTS(
   SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.org_id=l.org_id AND e.id=l.entry_id
   WHERE l.org_id=NEW.org_id AND e.status IN('posted','reversed')) THEN
  RAISE EXCEPTION 'A segment with posted activity retains its identity and storage basis.' USING ERRCODE='23514'; END IF;
 IF NEW.is_balancing AND (TG_OP='INSERT' OR NOT OLD.is_balancing) AND EXISTS(
  SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.org_id=l.org_id AND e.id=l.entry_id
  WHERE l.org_id=NEW.org_id AND e.status IN('posted','reversed')
  GROUP BY e.id,l.subsidiary_id,CASE NEW.storage_column WHEN 'subsidiary_id' THEN l.subsidiary_id::text
   WHEN 'department_id' THEN l.department_id::text WHEN 'project_id' THEN l.project_id::text
   WHEN 'location_id' THEN l.location_id::text WHEN 'class_id' THEN l.class_id::text ELSE l.extra_dims->>NEW.key END
  HAVING sum(l.amount)<>0) THEN
  RAISE EXCEPTION 'A balancing segment must be configured before unbalanced historical value assignments exist. Use a new segment with its clearing policy before posting.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER segment_balancing_activation_guard BEFORE INSERT OR UPDATE ON public.segment_definitions FOR EACH ROW EXECUTE FUNCTION public.segment_balancing_activation_guard();
