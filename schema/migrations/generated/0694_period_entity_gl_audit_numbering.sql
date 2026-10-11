-- Retained audit numbering policies and append-only numbers for physical GL entries by book, entity and period.
-- Backfill: none. Posted headers and lines are not rewritten.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.gl_audit_number_policies(id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid, UNIQUE(org_id,id),subsidiary_id uuid NOT NULL,effective_from date NOT NULL,
 reset_rule text NOT NULL DEFAULT 'period' CHECK(reset_rule IN('period','fiscal_year','never')),
 prefix text NOT NULL DEFAULT 'GL' CHECK(length(btrim(prefix)) BETWEEN 1 AND 32),reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 2000),
 UNIQUE(org_id,subsidiary_id,effective_from), FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id));
CREATE TABLE public.gl_audit_number_assignments(id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid,updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid, UNIQUE(org_id,id),book_id uuid NOT NULL,subsidiary_id uuid NOT NULL,period_id uuid NOT NULL,
 entry_id uuid NOT NULL,policy_id uuid NOT NULL,scope_key text NOT NULL,ordinal integer NOT NULL CHECK(ordinal>0),audit_number text NOT NULL,
 UNIQUE(org_id,book_id,subsidiary_id,entry_id), UNIQUE(org_id,book_id,subsidiary_id,scope_key,ordinal),
 FOREIGN KEY(org_id,book_id) REFERENCES public.accounting_books(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,period_id) REFERENCES public.accounting_periods(org_id,id),
 FOREIGN KEY(org_id,entry_id) REFERENCES public.journal_entries(org_id,id),
 FOREIGN KEY(org_id,policy_id) REFERENCES public.gl_audit_number_policies(org_id,id));
CREATE FUNCTION public.gl_audit_number_assignment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
DECLARE policy gl_audit_number_policies%ROWTYPE; period accounting_periods%ROWTYPE; expected_scope text;
BEGIN
 PERFORM period_posting_fence(NEW.org_id,NEW.period_id,NEW.book_id);
 IF NOT public.period_module_blocks_write(NEW.org_id,NEW.period_id,NEW.book_id,NEW.subsidiary_id,'gl',false) THEN
  RAISE EXCEPTION 'GL audit numbers require a closed entity accounting period.' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT period FROM accounting_periods WHERE org_id=NEW.org_id AND id=NEW.period_id;
 SELECT * INTO policy FROM gl_audit_number_policies WHERE org_id=NEW.org_id AND subsidiary_id=NEW.subsidiary_id AND effective_from<=period.ends_on ORDER BY effective_from DESC LIMIT 1;
 expected_scope:=CASE policy.reset_rule WHEN 'period' THEN 'period:'||period.id WHEN 'fiscal_year' THEN 'year:'||period.fiscal_calendar_id||':'||period.fiscal_year ELSE 'all' END;
 IF policy.id IS NULL OR NEW.policy_id<>policy.id OR NEW.scope_key<>expected_scope OR
    NEW.audit_number<>policy.prefix||'-'||replace(expected_scope,':','-')||'-'||lpad(NEW.ordinal::text,greatest(6,length(NEW.ordinal::text)),'0') THEN
  RAISE EXCEPTION 'GL audit numbers retain the effective entity policy and canonical sequence format.' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('gl-audit:'||NEW.org_id||':'||NEW.book_id||':'||NEW.subsidiary_id||':'||expected_scope,0));
 IF NOT EXISTS(SELECT 1 FROM journal_entries e JOIN journal_lines l ON l.org_id=e.org_id AND l.entry_id=e.id
   WHERE e.org_id=NEW.org_id AND e.id=NEW.entry_id AND e.book_id=NEW.book_id AND e.status IN('posted','reversed')
    AND l.subsidiary_id=NEW.subsidiary_id AND coalesce(l.period_id,e.period_id)=NEW.period_id) THEN
  RAISE EXCEPTION 'An audit number must identify a posted entry in its own entity, period and book.' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM gl_audit_number_assignments WHERE org_id=NEW.org_id AND book_id=NEW.book_id
  AND subsidiary_id=NEW.subsidiary_id AND scope_key=NEW.scope_key AND ordinal>=NEW.ordinal) OR
  NEW.ordinal<>(SELECT coalesce(max(ordinal),0)+1 FROM gl_audit_number_assignments WHERE org_id=NEW.org_id AND book_id=NEW.book_id
   AND subsidiary_id=NEW.subsidiary_id AND scope_key=NEW.scope_key) THEN
  RAISE EXCEPTION 'GL audit numbers are allocated without gaps in their native sequence.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gl_audit_number_assignment_guard BEFORE INSERT ON public.gl_audit_number_assignments FOR EACH ROW EXECUTE FUNCTION public.gl_audit_number_assignment_guard();
ALTER TABLE public.gl_audit_number_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gl_audit_number_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.gl_audit_number_policies
 USING(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.gl_audit_number_policies IS 'openbooks:org_isolation:v1';
CREATE TRIGGER gl_audit_number_policies_immutable BEFORE UPDATE OR DELETE ON public.gl_audit_number_policies FOR EACH ROW EXECUTE FUNCTION public.financial_policy_version_immutable();
ALTER TABLE public.gl_audit_number_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gl_audit_number_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.gl_audit_number_assignments
 USING(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(current_setting('app.bypass_rls',true)='on' OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.gl_audit_number_assignments IS 'openbooks:org_isolation:v1';
CREATE TRIGGER gl_audit_number_assignments_immutable BEFORE UPDATE OR DELETE ON public.gl_audit_number_assignments FOR EACH ROW EXECUTE FUNCTION public.financial_policy_version_immutable();
INSERT INTO public.openbooks_query_catalog_relations(relation,added_in) VALUES
 ('gl_audit_number_policies','0694_period_entity_gl_audit_numbering'),('gl_audit_number_assignments','0694_period_entity_gl_audit_numbering');
SELECT public.openbooks_refresh_query_catalog();

CREATE FUNCTION public.gl_audit_number_policy_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('openbooks:ledger-setup:'||NEW.org_id,0));
 IF EXISTS(SELECT 1 FROM gl_audit_number_assignments n JOIN accounting_periods p ON p.org_id=n.org_id AND p.id=n.period_id
   WHERE n.org_id=NEW.org_id AND n.subsidiary_id=NEW.subsidiary_id AND p.ends_on>=NEW.effective_from) THEN
  RAISE EXCEPTION 'Audit numbering policy changes start after the latest numbered period.' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER gl_audit_number_policy_guard BEFORE INSERT ON public.gl_audit_number_policies FOR EACH ROW EXECUTE FUNCTION public.gl_audit_number_policy_guard();
-- Existing custom slugs are retained; installing an already named report is a benign conflict.
INSERT INTO public.report_definitions(org_id,kind,slug,name,description,report_type,statement,system)
 SELECT id,'built_in','gl-audit-numbers','GL Audit Numbers','Retained audit numbers by accounting book, legal entity and closed period.','statement','{"kind":"gl-audit-numbers"}'::jsonb,true FROM public.orgs
 ON CONFLICT(org_id,slug) DO NOTHING;
