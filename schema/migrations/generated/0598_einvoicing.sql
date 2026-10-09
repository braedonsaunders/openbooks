-- EN 16931 electronic invoicing: seller identity per legal entity, buyer routing on customers, VAT category declarations on tax codes, and an immutable archive of issued e-invoices.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path','public, pg_catalog',false);

ALTER TABLE public.tax_codes ADD COLUMN einvoice_effective_from date;
ALTER TABLE public.tax_codes ADD COLUMN einvoice_category text CHECK(einvoice_category IN('S','Z','E','AE','K','G','O','L','M','SR','SRCA-S','SRCA-C','ZR','ES33','ESN33','DS','OS','NA','NG','SRRC','SROVR-RS','SROVR-LVG','SRLVG'));
ALTER TABLE public.tax_codes ADD COLUMN einvoice_exemption_reason_code text CHECK(einvoice_exemption_reason_code ~ '^VATEX-[A-Z0-9-]{1,40}$');
ALTER TABLE public.tax_codes ADD COLUMN einvoice_exemption_reason text CHECK(length(btrim(einvoice_exemption_reason)) BETWEEN 1 AND 1000);
ALTER TABLE public.tax_codes ADD CONSTRAINT tax_codes_einvoice_exemption_category CHECK(
 (einvoice_exemption_reason_code IS NULL AND einvoice_exemption_reason IS NULL) OR einvoice_category IN('E','AE','K','G','O','ES33','ESN33','OS','NA','NG','SRRC'));
ALTER TABLE public.tax_codes ADD CONSTRAINT tax_codes_einvoice_effective_date CHECK(einvoice_category IS NULL OR einvoice_effective_from IS NOT NULL);
COMMENT ON COLUMN public.tax_codes.einvoice_category IS 'EN 16931 VAT category (UNTDID 5305) an e-invoice states for lines carrying this code; unset codes refuse e-invoicing rather than being guessed.';
COMMENT ON COLUMN public.tax_codes.einvoice_exemption_reason_code IS 'VATEX exemption reason code (BT-121) for exempting categories.';
COMMENT ON COLUMN public.tax_codes.einvoice_exemption_reason IS 'Statutory exemption or reverse-charge wording (BT-120) printed on invoices using this code.';

ALTER TABLE public.customer_roles ADD COLUMN einvoice_profile text CHECK(einvoice_profile IN('en16931-cii','en16931-ubl','xrechnung-cii','xrechnung-ubl','facturx','peppol-bis','nlcius','ehf','peppol-aunz','peppol-sg','pint-aunz','pint-sg'));
ALTER TABLE public.customer_roles ADD COLUMN einvoice_address text CHECK(length(btrim(einvoice_address)) BETWEEN 1 AND 200);
ALTER TABLE public.customer_roles ADD COLUMN einvoice_address_scheme text CHECK(einvoice_address_scheme ~ '^([0-9]{4}|[A-Z]{2})$');
ALTER TABLE public.customer_roles ADD COLUMN einvoice_buyer_reference text CHECK(length(btrim(einvoice_buyer_reference)) BETWEEN 1 AND 200);
ALTER TABLE public.customer_roles ADD COLUMN einvoice_legal_registration_id text CHECK(length(btrim(einvoice_legal_registration_id)) BETWEEN 1 AND 100);
ALTER TABLE public.customer_roles ADD COLUMN einvoice_legal_registration_scheme text CHECK(einvoice_legal_registration_scheme ~ '^[0-9]{4}$');
ALTER TABLE public.customer_roles ADD CONSTRAINT customer_roles_einvoice_address_pair CHECK((einvoice_address IS NULL) = (einvoice_address_scheme IS NULL));
ALTER TABLE public.customer_roles ADD CONSTRAINT customer_roles_einvoice_registration_scheme CHECK(einvoice_legal_registration_scheme IS NULL OR einvoice_legal_registration_id IS NOT NULL);
COMMENT ON COLUMN public.customer_roles.einvoice_profile IS 'E-invoice format the customer receives; null means the customer is invoiced without a structured e-invoice.';
COMMENT ON COLUMN public.customer_roles.einvoice_address IS 'Buyer electronic address (BT-49), such as a Peppol participant identifier, under einvoice_address_scheme (EAS).';
COMMENT ON COLUMN public.customer_roles.einvoice_buyer_reference IS 'Default buyer reference (BT-10), such as a German Leitweg-ID; an issued invoice may state its own.';

CREATE TABLE public.einvoice_settings (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),subsidiary_id uuid NOT NULL,
 default_profile text NOT NULL CHECK(default_profile IN('en16931-cii','en16931-ubl','xrechnung-cii','xrechnung-ubl','facturx','peppol-bis','nlcius','ehf','peppol-aunz','peppol-sg','pint-aunz','pint-sg')),
 address_line1 text CHECK(length(btrim(address_line1)) BETWEEN 1 AND 200),address_line2 text CHECK(length(btrim(address_line2)) BETWEEN 1 AND 200),
 city text CHECK(length(btrim(city)) BETWEEN 1 AND 100),postcode text CHECK(length(btrim(postcode)) BETWEEN 1 AND 20),
 subdivision text CHECK(length(btrim(subdivision)) BETWEEN 1 AND 100),trading_name text CHECK(length(btrim(trading_name)) BETWEEN 1 AND 200),
 legal_registration_id text CHECK(length(btrim(legal_registration_id)) BETWEEN 1 AND 100),legal_registration_scheme text CHECK(legal_registration_scheme ~ '^[0-9]{4}$'),
 tax_number text CHECK(length(btrim(tax_number)) BETWEEN 1 AND 50),
 contact_name text CHECK(length(btrim(contact_name)) BETWEEN 1 AND 200),contact_phone text CHECK(length(btrim(contact_phone)) BETWEEN 1 AND 50),
 contact_email text CHECK(length(btrim(contact_email)) BETWEEN 3 AND 320),
 electronic_address text CHECK(length(btrim(electronic_address)) BETWEEN 1 AND 200),electronic_address_scheme text CHECK(electronic_address_scheme ~ '^([0-9]{4}|[A-Z]{2})$'),
 payment_means_code text NOT NULL DEFAULT '30' CHECK(payment_means_code ~ '^([0-9]{1,2}|ZZZ)$'),
 payee_account_id text CHECK(length(btrim(payee_account_id)) BETWEEN 1 AND 64),payee_account_name text CHECK(length(btrim(payee_account_name)) BETWEEN 1 AND 200),
 payee_bic text CHECK(regexp_replace(payee_bic, '[[:space:]-]', '', 'g') ~ '^[A-Za-z0-9]{4,35}$'),
 untaxed_line_category text CHECK(untaxed_line_category IN('Z','E','O')),
 untaxed_exemption_reason_code text CHECK(untaxed_exemption_reason_code ~ '^VATEX-[A-Z0-9-]{1,40}$'),
 untaxed_exemption_reason text CHECK(length(btrim(untaxed_exemption_reason)) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL,updated_by uuid NOT NULL,
 UNIQUE(org_id,id),UNIQUE(org_id,subsidiary_id),
 CHECK((electronic_address IS NULL) = (electronic_address_scheme IS NULL)),
 CHECK(legal_registration_scheme IS NULL OR legal_registration_id IS NOT NULL),
 CHECK(untaxed_line_category IS NOT NULL OR (untaxed_exemption_reason_code IS NULL AND untaxed_exemption_reason IS NULL)),
 CHECK(untaxed_line_category IS DISTINCT FROM 'Z' OR (untaxed_exemption_reason_code IS NULL AND untaxed_exemption_reason IS NULL)),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id)
);
COMMENT ON TABLE public.einvoice_settings IS 'Seller identity, payment instructions and VAT treatment of untaxed lines that one legal entity states on its EN 16931 e-invoices.';
COMMENT ON COLUMN public.einvoice_settings.untaxed_line_category IS 'VAT category for invoice lines without a tax code; when unset such invoices refuse e-invoicing.';

CREATE TABLE public.einvoice_documents (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),document_id uuid NOT NULL,
 profile text NOT NULL CHECK(profile IN('en16931-cii','en16931-ubl','xrechnung-cii','xrechnung-ubl','facturx','peppol-bis','nlcius','ehf','peppol-aunz','peppol-sg','pint-aunz','pint-sg')),
 type_code text NOT NULL CHECK(type_code ~ '^[0-9]{2,3}$'),buyer_reference text CHECK(length(btrim(buyer_reference)) BETWEEN 1 AND 200),
 file_name text NOT NULL CHECK(length(file_name) BETWEEN 5 AND 200),media_type text NOT NULL CHECK(media_type IN('application/xml','application/pdf')),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 20971520),content_sha256 text NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
 xml_sha256 text NOT NULL CHECK(xml_sha256 ~ '^[0-9a-f]{64}$'),document_revision bigint NOT NULL,
 findings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(findings)='array'),
 issued_at timestamptz NOT NULL DEFAULT now(),issued_by uuid NOT NULL,
 UNIQUE(org_id,id),CONSTRAINT einvoice_documents_xml_key UNIQUE(org_id,document_id,profile,xml_sha256),
 FOREIGN KEY(org_id,document_id) REFERENCES public.documents(org_id,id),
 FOREIGN KEY(org_id,issued_by) REFERENCES public.users(org_id,id)
);
CREATE INDEX einvoice_documents_document ON public.einvoice_documents(org_id,document_id,issued_at DESC);
COMMENT ON TABLE public.einvoice_documents IS 'Each e-invoice exactly as issued, kept byte for byte with its digest; regenerating an unchanged invoice returns the archived file.';

CREATE FUNCTION public.einvoice_documents_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Issued e-invoices are retained unchanged; issue a corrected invoice or credit note instead.' USING ERRCODE='23514';
END $function$;
CREATE TRIGGER einvoice_documents_immutable BEFORE UPDATE OR DELETE ON public.einvoice_documents FOR EACH ROW EXECUTE FUNCTION public.einvoice_documents_immutable();

ALTER TABLE public.einvoice_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.einvoice_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.einvoice_settings USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.einvoice_settings IS 'openbooks:org_isolation:v1';
ALTER TABLE public.einvoice_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.einvoice_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.einvoice_documents USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.einvoice_documents IS 'openbooks:org_isolation:v1';

INSERT INTO public.openbooks_query_catalog_relations(relation,added_in) VALUES('einvoice_settings','0598_einvoicing') ON CONFLICT(relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
