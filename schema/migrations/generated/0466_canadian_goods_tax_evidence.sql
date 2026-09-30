-- Preserve legal-entity registration ownership and native goods-tax evidence.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);
ALTER TABLE public.tax_registrations ADD COLUMN subsidiary_id uuid;
ALTER TABLE public.tax_registrations ADD CONSTRAINT tax_registration_entity FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id) ON DELETE RESTRICT;
-- Existing organization-wide declarations keep their identity and data. They
-- require an explicit legal-entity assignment before native automatic selection.
ALTER TABLE public.tax_registrations DROP CONSTRAINT tax_registrations_no_active_overlap;
ALTER TABLE public.tax_registrations ADD CONSTRAINT tax_registrations_no_active_overlap EXCLUDE USING gist (
  org_id WITH =,jurisdiction_id WITH =,(coalesce(subsidiary_id,'00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
  (coalesce(return_form_code,'')) WITH =,(daterange(coalesce(effective_from,'-infinity'::date),effective_to,'[]')) WITH &&
) WHERE(is_active);
CREATE OR REPLACE FUNCTION public.tax_registrations_no_overlap_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.subsidiary_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.subsidiaries s WHERE s.org_id=NEW.org_id AND s.id=NEW.subsidiary_id AND s.is_active AND NOT s.is_elimination)
    THEN RAISE EXCEPTION 'tax registration must belong to an active legal entity in this organization'; END IF;
  IF NOT NEW.is_active THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM public.tax_registrations r WHERE r.id<>NEW.id AND r.org_id=NEW.org_id AND r.is_active
    AND r.subsidiary_id IS NOT DISTINCT FROM NEW.subsidiary_id AND r.jurisdiction_id=NEW.jurisdiction_id
    AND coalesce(r.return_form_code,'')=coalesce(NEW.return_form_code,'')
    AND public.effective_date_ranges_overlap(coalesce(r.effective_from,'-infinity'::date),r.effective_to,coalesce(NEW.effective_from,'-infinity'::date),NEW.effective_to))
    THEN RAISE EXCEPTION 'tax registrations overlap for this legal entity, jurisdiction and return form' USING ERRCODE='23P01'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tax_registration_legal_entity_guard BEFORE INSERT OR UPDATE ON public.tax_registrations FOR EACH ROW EXECUTE FUNCTION public.tax_registrations_no_overlap_guard();
CREATE TABLE public.document_goods_tax_snapshots (
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE RESTRICT,
  document_line_id uuid NOT NULL,
  subsidiary_id uuid NOT NULL,
  registration_ids jsonb NOT NULL CHECK(jsonb_typeof(registration_ids)='array' AND jsonb_array_length(registration_ids)>0),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  PRIMARY KEY(org_id,document_line_id),
  FOREIGN KEY(org_id,document_line_id) REFERENCES public.document_lines(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id) ON DELETE RESTRICT
);
ALTER TABLE public.document_goods_tax_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_goods_tax_snapshots FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.document_goods_tax_snapshots
  USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
  WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
CREATE FUNCTION public.goods_tax_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document_state text; owner uuid; current_org uuid;
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'goods tax calculation evidence is immutable; replace the draft line through its native document editor'; END IF;
  IF TG_OP='DELETE' THEN
    SELECT d.status INTO document_state FROM public.document_lines l JOIN public.documents d ON d.org_id=l.org_id AND d.id=l.document_id
      WHERE l.org_id=OLD.org_id AND l.id=OLD.document_line_id;
    IF document_state='draft' OR document_state IS NULL THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'posted goods tax evidence cannot be deleted; use the controlled document reversal workflow';
  END IF;
  SELECT d.status,d.subsidiary_id,d.org_id INTO document_state,owner,current_org FROM public.document_lines l JOIN public.documents d ON d.org_id=l.org_id AND d.id=l.document_id
    WHERE l.org_id=NEW.org_id AND l.id=NEW.document_line_id;
  IF document_state<>'draft' OR owner IS DISTINCT FROM NEW.subsidiary_id OR current_org IS DISTINCT FROM NEW.org_id
    OR NEW.snapshot->>'subsidiaryId'<>NEW.subsidiary_id::text OR NEW.snapshot->>'fingerprint'<>NEW.fingerprint
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(NEW.registration_ids) wanted(id) WHERE NOT EXISTS(SELECT 1 FROM public.tax_registrations r
      WHERE r.org_id=NEW.org_id AND r.id=wanted.id::uuid AND r.subsidiary_id=NEW.subsidiary_id))
    THEN RAISE EXCEPTION 'native goods tax evidence must bind to its draft invoice, selling entity and registrations'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goods_tax_snapshot_guard BEFORE INSERT OR UPDATE OR DELETE ON public.document_goods_tax_snapshots FOR EACH ROW EXECUTE FUNCTION public.goods_tax_snapshot_guard();
CREATE FUNCTION public.goods_tax_registration_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM public.document_goods_tax_snapshots proof JOIN public.document_lines l ON l.org_id=proof.org_id AND l.id=proof.document_line_id
    JOIN public.documents d ON d.org_id=l.org_id AND d.id=l.document_id
    WHERE proof.org_id=OLD.org_id AND proof.registration_ids ? OLD.id::text AND d.status IN('posted','voided')
      AND (TG_OP='DELETE' OR (NEW.org_id,NEW.subsidiary_id,NEW.jurisdiction_id,NEW.registration_number,NEW.effective_from)
        IS DISTINCT FROM (OLD.org_id,OLD.subsidiary_id,OLD.jurisdiction_id,OLD.registration_number,OLD.effective_from)
        OR (NEW.effective_to IS NOT NULL AND NEW.effective_to<d.document_date)))
    THEN RAISE EXCEPTION 'used tax registration identity and coverage are immutable; close its future effective window and create a new dated registration'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER goods_tax_registration_history_guard BEFORE UPDATE OR DELETE ON public.tax_registrations FOR EACH ROW EXECUTE FUNCTION public.goods_tax_registration_history_guard();
SELECT public.openbooks_refresh_query_catalog();
