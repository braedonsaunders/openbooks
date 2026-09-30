-- Preserve source-line attribution for independently approved net-investment
-- FX reclassifications. Standalone journals remain unchanged.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);
CREATE TABLE public.net_investment_entries (
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE RESTRICT,
  change_id uuid NOT NULL,
  interest_id uuid NOT NULL REFERENCES public.subsidiary_ownership_interests(id) ON DELETE RESTRICT,
  journal_entry_id uuid,
  book_id uuid NOT NULL REFERENCES public.accounting_books(id) ON DELETE RESTRICT,
  period_id uuid NOT NULL REFERENCES public.accounting_periods(id) ON DELETE RESTRICT,
  elimination_subsidiary_id uuid NOT NULL REFERENCES public.subsidiaries(id) ON DELETE RESTRICT,
  reversed_by_change_id uuid REFERENCES public.financial_changes(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,change_id),
  UNIQUE(org_id,journal_entry_id),
  FOREIGN KEY(org_id,change_id) REFERENCES public.financial_changes(org_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,journal_entry_id) REFERENCES public.journal_entries(org_id,id) ON DELETE RESTRICT
);
CREATE TABLE public.net_investment_sources (
  org_id uuid NOT NULL,
  source_line_id uuid NOT NULL,
  change_id uuid NOT NULL,
  amount numeric(20,4) NOT NULL,
  translated_amount numeric(20,4) NOT NULL,
  average_rate numeric(19,10) NOT NULL CHECK(average_rate>0),
  reversed_by_change_id uuid REFERENCES public.financial_changes(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(org_id,change_id,source_line_id),
  FOREIGN KEY(org_id,change_id) REFERENCES public.net_investment_entries(org_id,change_id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,source_line_id) REFERENCES public.journal_lines(org_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX net_investment_source_active ON public.net_investment_sources(org_id,source_line_id) WHERE reversed_by_change_id IS NULL;
ALTER TABLE public.net_investment_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.net_investment_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.net_investment_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.net_investment_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.net_investment_entries
  USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
  WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
CREATE POLICY org_isolation ON public.net_investment_sources
  USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
  WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
CREATE FUNCTION public.net_investment_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
      IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
    END IF;
    IF TG_OP='UPDATE' AND OLD.reversed_by_change_id IS NULL AND NEW.reversed_by_change_id IS NOT NULL
      AND (to_jsonb(NEW)-'reversed_by_change_id') IS NOT DISTINCT FROM (to_jsonb(OLD)-'reversed_by_change_id')
      AND EXISTS(SELECT 1 FROM public.financial_changes f WHERE f.org_id=OLD.org_id AND f.id=NEW.reversed_by_change_id
        AND f.domain='consolidation' AND f.operation='net_investment_oci_reversal' AND f.status='approved'
        AND f.payload->>'sourceChangeId'=OLD.change_id::text) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'net-investment evidence is immutable; use its independently approved correction in Accounting changes';
  END IF;
  IF TG_TABLE_NAME='net_investment_entries' THEN
    IF NOT EXISTS(SELECT 1 FROM public.financial_changes f JOIN public.subsidiary_ownership_interests i ON i.org_id=f.org_id AND i.id=f.subject_id
      JOIN public.accounting_books b ON b.org_id=f.org_id AND b.id=NEW.book_id
      JOIN public.accounting_periods p ON p.org_id=b.org_id AND p.id=NEW.period_id
      JOIN public.subsidiaries e ON e.org_id=f.org_id AND e.id=NEW.elimination_subsidiary_id AND e.is_elimination
      WHERE f.org_id=NEW.org_id AND f.id=NEW.change_id AND f.domain='consolidation' AND f.operation='net_investment_oci' AND f.status='approved'
        AND f.subject_id=NEW.interest_id AND f.subsidiary_id=e.id AND f.payload->>'bookId'=b.id::text
        AND f.effective_on BETWEEN p.starts_on AND p.ends_on)
      OR (NEW.journal_entry_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.journal_entries e
        WHERE e.org_id=NEW.org_id AND e.id=NEW.journal_entry_id AND e.book_id=NEW.book_id AND e.period_id=NEW.period_id
          AND e.subsidiary_id=NEW.elimination_subsidiary_id AND e.status='posted' AND e.origin='net_investment_oci'))
      THEN RAISE EXCEPTION 'net-investment journal must bind to its approved ownership, book, period and elimination entity'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.net_investment_entries c JOIN public.financial_changes f ON f.org_id=c.org_id AND f.id=c.change_id
      JOIN public.journal_lines l ON l.org_id=c.org_id AND l.id=NEW.source_line_id
      JOIN public.journal_entries e ON e.org_id=l.org_id AND e.id=l.entry_id
      WHERE c.org_id=NEW.org_id AND c.change_id=NEW.change_id AND f.status='approved' AND e.origin='fx_revaluation'
        AND e.book_id=c.book_id AND e.period_id=c.period_id AND e.status IN('posted','reversed') AND l.amount=NEW.amount
        AND EXISTS(SELECT 1 FROM jsonb_array_elements(f.before_state->'sources') proof
          WHERE proof->>'id'=NEW.source_line_id::text AND (proof->>'translated')::numeric=NEW.translated_amount
            AND (proof->>'averageRate')::numeric=NEW.average_rate))
      THEN RAISE EXCEPTION 'net-investment source must match the independently approved native FX evidence'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER net_investment_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.net_investment_entries FOR EACH ROW EXECUTE FUNCTION public.net_investment_evidence_guard();
CREATE TRIGGER net_investment_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON public.net_investment_sources FOR EACH ROW EXECUTE FUNCTION public.net_investment_evidence_guard();
SELECT public.openbooks_refresh_query_catalog();

-- Used ownership and paired-loan identities remain historical evidence.
-- The existing controlled disposal may close and restore its reporting window.
CREATE FUNCTION public.net_investment_configuration_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='subsidiary_ownership_interests' THEN
    IF EXISTS(SELECT 1 FROM public.net_investment_entries c WHERE c.org_id=OLD.org_id AND c.interest_id=OLD.id) AND
      (TG_OP='DELETE' OR (NEW.subsidiary_id,NEW.parent_subsidiary_id,NEW.method,NEW.ownership_percent,NEW.effective_from)
        IS DISTINCT FROM (OLD.subsidiary_id,OLD.parent_subsidiary_id,OLD.method,OLD.ownership_percent,OLD.effective_from)
       OR (NEW.effective_to IS DISTINCT FROM OLD.effective_to AND NOT EXISTS(SELECT 1 FROM public.financial_changes f
         WHERE f.org_id=OLD.org_id AND f.id=NEW.last_change_id AND f.subject_id=OLD.id AND f.domain='consolidation'
           AND f.status='approved' AND f.operation IN('loss_of_control','reversal'))))
      THEN RAISE EXCEPTION 'used net-investment ownership identity is immutable; use the controlled loss-of-control workflow to close its reporting window'; END IF;
  ELSIF TG_TABLE_NAME='intercompany_pairs' THEN
    IF EXISTS(SELECT 1 FROM public.net_investment_entries c JOIN public.financial_changes f ON f.org_id=c.org_id AND f.id=c.change_id
      WHERE c.org_id=OLD.org_id AND f.payload->>'pairId'=OLD.id::text) AND
      (TG_OP='DELETE' OR (NEW.from_subsidiary_id,NEW.to_subsidiary_id,NEW.due_from_account_id,NEW.due_to_account_id)
        IS DISTINCT FROM (OLD.from_subsidiary_id,OLD.to_subsidiary_id,OLD.due_from_account_id,OLD.due_to_account_id))
      THEN RAISE EXCEPTION 'used net-investment loan pairing is immutable; configure a new pair for a changed financing arrangement'; END IF;
  ELSIF TG_TABLE_NAME='consolidated_fx_rates' THEN
    IF (TG_OP='DELETE' OR NEW.average_rate IS DISTINCT FROM OLD.average_rate) AND EXISTS(
      SELECT 1 FROM public.net_investment_entries c JOIN public.financial_changes f ON f.org_id=c.org_id AND f.id=c.change_id,
        jsonb_array_elements(f.before_state->'sources') source,
        jsonb_array_elements(f.before_state->'entities') holder
      WHERE c.org_id=OLD.org_id AND c.period_id=OLD.period_id AND c.reversed_by_change_id IS NULL
        AND holder->>'id'=source->>'subsidiary_id' AND holder->>'base_currency'=OLD.from_currency
        AND f.before_state->'elimination'->>'base_currency'=OLD.to_currency)
      THEN RAISE EXCEPTION 'the average rate supports an approved net-investment OCI assessment; reverse that assessment through Accounting changes before correcting its translation rate'; END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER net_investment_configuration_guard BEFORE UPDATE OR DELETE ON public.subsidiary_ownership_interests FOR EACH ROW EXECUTE FUNCTION public.net_investment_configuration_guard();
CREATE TRIGGER net_investment_configuration_guard BEFORE UPDATE OR DELETE ON public.intercompany_pairs FOR EACH ROW EXECUTE FUNCTION public.net_investment_configuration_guard();
CREATE TRIGGER net_investment_configuration_guard BEFORE UPDATE OR DELETE ON public.consolidated_fx_rates FOR EACH ROW EXECUTE FUNCTION public.net_investment_configuration_guard();
