-- OpenBooks forward migration 0509_cross_border_tax.
-- Place-of-supply evidence, validated business tax IDs and OSS registrations
-- for cross-border B2C/B2B sales and the OSS/IOSS returns filed on them.
-- New tables start empty; no existing row is read, rewritten or deleted.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- One-Stop-Shop registrations: the member state of identification, scheme and
-- number the org files under. One active registration per scheme; a
-- re-registration closes the old window and opens a new row, so a filed
-- period always resolves to the registration that covered it.
CREATE TABLE public.tax_oss_registrations (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  subsidiary_id uuid,
  scheme text NOT NULL,
  identification_state text NOT NULL,
  registration_number text NOT NULL,
  effective_from date,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT tax_oss_registrations_pkey PRIMARY KEY (id),
  CONSTRAINT tax_oss_registrations_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT tax_oss_registrations_scheme_valid
    CHECK (scheme IN ('union', 'non_union', 'ioss')),
  CONSTRAINT tax_oss_registrations_state_valid
    CHECK (identification_state ~ '^[A-Z]{2}$'),
  CONSTRAINT tax_oss_registrations_number_nonblank
    CHECK (length(btrim(registration_number)) > 0),
  CONSTRAINT tax_oss_registrations_window_valid
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX tax_oss_registrations_one_active_scheme
  ON public.tax_oss_registrations (org_id, scheme) WHERE is_active;
CREATE INDEX tax_oss_registrations_org_scheme ON public.tax_oss_registrations (org_id, scheme);
ALTER TABLE public.tax_oss_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_oss_registrations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.tax_oss_registrations
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.tax_oss_registrations IS 'openbooks:org_isolation:v1';

-- Validated business tax IDs per customer: the normalized number, which
-- authority checked it (VIES, HMRC, ABN lookup or a GST registry), the
-- verdict, when it was checked, the authority's consultation reference and a
-- bounded excerpt of the authority response. History is kept per value: a
-- re-check updates the row, a changed number is a new row. A failed authority
-- call leaves the previous verdict with status unverified, never a silent pass.
CREATE TABLE public.party_tax_ids (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  scheme text NOT NULL,
  value text NOT NULL,
  status text NOT NULL DEFAULT 'unverified',
  checked_at timestamp with time zone,
  checked_by uuid,
  consultation_number text,
  response_excerpt jsonb,
  revalidate_after date,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT party_tax_ids_pkey PRIMARY KEY (id),
  CONSTRAINT party_tax_ids_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT party_tax_ids_identity_unique UNIQUE (org_id, party_id, scheme, value),
  CONSTRAINT party_tax_ids_scheme_valid
    CHECK (scheme IN ('vies', 'hmrc', 'abn', 'gst')),
  CONSTRAINT party_tax_ids_value_nonblank
    CHECK (length(btrim(value)) > 0),
  CONSTRAINT party_tax_ids_status_valid
    CHECK (status IN ('valid', 'invalid', 'unverified')),
  CONSTRAINT party_tax_ids_excerpt_object
    CHECK (response_excerpt IS NULL OR jsonb_typeof(response_excerpt) = 'object')
);
CREATE INDEX party_tax_ids_org_party ON public.party_tax_ids (org_id, party_id);
CREATE INDEX party_tax_ids_revalidation_due ON public.party_tax_ids (org_id, revalidate_after)
  WHERE status = 'valid' AND is_active;
ALTER TABLE public.party_tax_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.party_tax_ids FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.party_tax_ids
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.party_tax_ids IS 'openbooks:org_isolation:v1';

-- Place-of-supply evidence per sales document: each independently collected
-- location signal (billing address, card country, IP country, bank country,
-- SIM country, ship-to destination) with the country it asserts and the
-- system that observed it. Only derived country codes are stored — never raw
-- IPs, PANs or BINs — so every column is non-personal. The posting boundary
-- requires two non-conflicting pieces before a B2C digital supply prices.
CREATE TABLE public.document_supply_evidence (
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  document_id uuid NOT NULL,
  kind text NOT NULL,
  country_code text NOT NULL,
  source text NOT NULL,
  observed_on date,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  CONSTRAINT document_supply_evidence_pkey PRIMARY KEY (org_id, document_id, kind, source),
  CONSTRAINT document_supply_evidence_kind_valid
    CHECK (kind IN ('billing_address', 'ip_country', 'card_bin_country', 'bank_country', 'sim_country', 'ship_to')),
  CONSTRAINT document_supply_evidence_country_valid
    CHECK (country_code ~ '^[A-Z]{2}$'),
  CONSTRAINT document_supply_evidence_source_bounded
    CHECK (length(btrim(source)) > 0 AND length(source) <= 40),
  FOREIGN KEY (org_id, document_id) REFERENCES public.documents(org_id, id) ON DELETE CASCADE
);
CREATE INDEX document_supply_evidence_org_document ON public.document_supply_evidence (org_id, document_id);
ALTER TABLE public.document_supply_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_supply_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.document_supply_evidence
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.document_supply_evidence IS 'openbooks:org_isolation:v1';

-- Posted supply evidence is immutable: it is collected while the document is
-- a draft and frozen by posting. Changing the asserted place of supply on a
-- posted document means returning it to draft and recollecting, never editing
-- the row in place.
CREATE FUNCTION public.document_supply_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE document_state text;
BEGIN
  SELECT d.status INTO document_state FROM public.documents d
    WHERE d.org_id = COALESCE(NEW.org_id, OLD.org_id)
      AND d.id = COALESCE(NEW.document_id, OLD.document_id);
  IF TG_OP = 'INSERT' THEN
    IF document_state IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'supply evidence is collected while the document is a draft; return the document to draft before recording evidence';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'posted supply evidence is immutable; return the document to draft and recollect its evidence';
END $$;
CREATE TRIGGER document_supply_evidence_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.document_supply_evidence
  FOR EACH ROW EXECUTE FUNCTION public.document_supply_evidence_guard();

insert into public.openbooks_query_catalog_relations (relation, added_in)
 values ('tax_oss_registrations', '0509_cross_border_tax'),
        ('party_tax_ids', '0509_cross_border_tax'),
        ('document_supply_evidence', '0509_cross_border_tax')
 on conflict (relation) do nothing; -- expected on replay
select public.openbooks_refresh_query_catalog();
