-- Contractor withholding schemes (UK CIS, German Bauabzugsteuer, Irish RCT): legal-entity enrollments, subcontractor standings, payment-time deductions and periodic returns.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path','public, pg_catalog',false);

ALTER TABLE public.document_lines ADD COLUMN withholding_treatment text CHECK(withholding_treatment IN('labour','materials','excluded'));
ALTER TABLE public.document_lines ADD COLUMN withholding_materials_cost numeric(19,4) CHECK (withholding_materials_cost >= 0 AND withholding_materials_cost <= amount);
COMMENT ON COLUMN public.document_lines.withholding_materials_cost IS 'Subcontractor direct materials cost in document currency, entered explicitly for CIS; selling-price markup remains subject to withholding.';
COMMENT ON COLUMN public.document_lines.withholding_treatment IS 'How a bill line counts toward contractor withholding: labour, materials the subcontractor supplied, or a supply outside the scheme. Unset lines are classified from the item.';
ALTER TABLE public.vendor_retainage_releases ADD COLUMN source_bill_allocations jsonb CHECK (source_bill_allocations IS NULL OR (jsonb_typeof(source_bill_allocations) = 'array' AND jsonb_array_length(source_bill_allocations) > 0));
COMMENT ON COLUMN public.vendor_retainage_releases.source_bill_allocations IS 'Immutable original posted bill IDs, held amounts and cumulative release coordinates; source work and direct materials costs determine withholding on retained payments.';
CREATE FUNCTION public.preserve_vendor_retainage_source_allocations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_bill_allocations IS DISTINCT FROM OLD.source_bill_allocations THEN
  RAISE EXCEPTION 'Retainage source allocations are immutable; cancel the release through its native workflow and create a replacement';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER vendor_retainage_source_allocations_immutable BEFORE UPDATE OF source_bill_allocations ON public.vendor_retainage_releases
 FOR EACH ROW EXECUTE FUNCTION public.preserve_vendor_retainage_source_allocations();

ALTER TABLE public.payment_run_items ADD COLUMN withholding_amount numeric(19,4) NOT NULL DEFAULT 0 CHECK(withholding_amount >= 0);
COMMENT ON COLUMN public.payment_run_items.withholding_amount IS 'Contractor withholding deducted from this item at payment; part of the approved run plan.';

CREATE TABLE public.withholding_enrollments (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),subsidiary_id uuid NOT NULL,
 scheme_code text NOT NULL CHECK(scheme_code ~ '^[A-Z]{2}_[A-Z0-9_]{1,40}$'),
 contractor_reference text NOT NULL CHECK(length(btrim(contractor_reference)) BETWEEN 1 AND 64),
 liability_account_id uuid NOT NULL,authority_party_id uuid,return_frequency text CHECK(return_frequency IN('monthly','quarterly','annual')),payer_scope text CHECK(payer_scope IN('condominium')),remittance_schedule_code text CHECK(remittance_schedule_code ~ '^[A-Z0-9_]{1,40}$'),remittance_policy jsonb CHECK(remittance_policy IS NULL OR jsonb_typeof(remittance_policy)='object'),threshold_basis text CHECK(threshold_basis ~ '^[a-z_]{1,40}$'),
 effective_from date NOT NULL,effective_to date,is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL,updated_by uuid NOT NULL,
 UNIQUE(org_id,id),CHECK(effective_to IS NULL OR effective_to >= effective_from),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,liability_account_id) REFERENCES public.accounts(org_id,id),
 FOREIGN KEY(org_id,authority_party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 CONSTRAINT withholding_enrollments_no_overlap EXCLUDE USING gist(
  org_id WITH =,subsidiary_id WITH =,scheme_code WITH =,daterange(effective_from,effective_to,'[]') WITH &&) WHERE(is_active)
);
COMMENT ON TABLE public.withholding_enrollments IS 'A legal entity registered as a contractor under a withholding scheme, with the liability account its deductions credit, for an effective period.';

CREATE TABLE public.withholding_standings (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),subsidiary_id uuid,party_id uuid NOT NULL,
 scheme_code text NOT NULL CHECK(scheme_code ~ '^[A-Z]{2}_[A-Z0-9_]{1,40}$'),band_code text NOT NULL CHECK(band_code ~ '^[A-Z0-9_]{1,32}$'),
 verification_reference text CHECK(length(btrim(verification_reference)) BETWEEN 1 AND 100),verified_on date,
 valid_from date NOT NULL,valid_to date,payee_reference text CHECK(length(btrim(payee_reference)) BETWEEN 1 AND 64),
 payee_tax_office text CHECK(length(btrim(payee_tax_office)) BETWEEN 1 AND 200),
 apply_from_first_payment boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'active' CHECK(status IN('active','revoked')),revoked_reason text CHECK(length(btrim(revoked_reason)) BETWEEN 1 AND 2000),
 notes text CHECK(length(notes) <= 4000),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by uuid NOT NULL,updated_by uuid NOT NULL,
 UNIQUE(org_id,id),CHECK(valid_to IS NULL OR valid_to >= valid_from),
 CHECK((status='revoked') = (revoked_reason IS NOT NULL)),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),FOREIGN KEY(org_id,updated_by) REFERENCES public.users(org_id,id),
 CONSTRAINT withholding_standings_no_overlap EXCLUDE USING gist(
  org_id WITH =,(coalesce(subsidiary_id,'00000000-0000-0000-0000-000000000000'::uuid)) WITH =,party_id WITH =,scheme_code WITH =,daterange(valid_from,valid_to,'[]') WITH &&) WHERE(status='active')
);
CREATE INDEX withholding_standings_party ON public.withholding_standings(org_id,subsidiary_id,party_id,scheme_code,valid_from DESC);
COMMENT ON TABLE public.withholding_standings IS 'A subcontractor''s standing for one paying legal entity under a withholding scheme, with supporting verification and a validity window.';
COMMENT ON COLUMN public.withholding_standings.subsidiary_id IS 'Paying legal entity that owns the verification. Legacy unassigned standings are usable only while exactly one active legal entity is enrolled in the scheme on the payment date.';

CREATE TABLE public.withholding_returns (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),subsidiary_id uuid NOT NULL,
 enrollment_id uuid NOT NULL,scheme_code text NOT NULL CHECK(scheme_code ~ '^[A-Z]{2}_[A-Z0-9_]{1,40}$'),
 period_start date NOT NULL,period_end date NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision >= 1),
 status text NOT NULL DEFAULT 'prepared' CHECK(status IN('prepared','filed','superseded')),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 totals jsonb NOT NULL CHECK(jsonb_typeof(totals)='object'),lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array'),
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),
 prepared_at timestamptz NOT NULL DEFAULT now(),prepared_by uuid NOT NULL,
 filed_at timestamptz,filed_by uuid,filing_reference text CHECK(length(btrim(filing_reference)) BETWEEN 1 AND 100),
 remittance_document_id uuid,
 UNIQUE(org_id,id),CONSTRAINT withholding_returns_period_revision_key UNIQUE(org_id,enrollment_id,period_start,revision),CHECK(period_end >= period_start),
 CHECK((status='filed') <= (filed_at IS NOT NULL AND filed_by IS NOT NULL)),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,enrollment_id) REFERENCES public.withholding_enrollments(org_id,id),
 FOREIGN KEY(org_id,remittance_document_id) REFERENCES public.documents(org_id,id),
 FOREIGN KEY(org_id,prepared_by) REFERENCES public.users(org_id,id),FOREIGN KEY(org_id,filed_by) REFERENCES public.users(org_id,id)
);
CREATE UNIQUE INDEX withholding_returns_open_revision ON public.withholding_returns(org_id,enrollment_id,period_start) WHERE status='prepared';
COMMENT ON TABLE public.withholding_returns IS 'A periodic contractor withholding return frozen from posted deductions; a change after filing is reported as a new revision.';

CREATE TABLE public.withholding_deductions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),org_id uuid NOT NULL REFERENCES public.orgs(id),subsidiary_id uuid NOT NULL,
 enrollment_id uuid NOT NULL,standing_id uuid,payee_name text NOT NULL CHECK(length(btrim(payee_name)) BETWEEN 1 AND 500),payee_reference text,verification_reference text,scheme_code text NOT NULL CHECK(scheme_code ~ '^[A-Z]{2}_[A-Z0-9_]{1,40}$'),
 party_id uuid NOT NULL,payment_document_id uuid NOT NULL,bill_document_id uuid NOT NULL,bill_open_line_id uuid NOT NULL,journal_entry_id uuid NOT NULL,
 payment_date date NOT NULL,period_start date NOT NULL,period_end date NOT NULL,currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 band_code text NOT NULL,rate_percent numeric(9,4) NOT NULL CHECK(rate_percent >= 0 AND rate_percent <= 100),downgraded_from text,
 paid_amount numeric(19,4) NOT NULL,net_amount numeric(19,4) NOT NULL,materials_amount numeric(19,4) NOT NULL,vat_amount numeric(19,4) NOT NULL,
 consideration_amount numeric(19,4) NOT NULL,base_amount numeric(19,4) NOT NULL,catch_up_base numeric(19,4) NOT NULL DEFAULT 0,
 deducted_amount numeric(19,4) NOT NULL CHECK(deducted_amount >= 0),uncollected_amount numeric(19,4) NOT NULL DEFAULT 0 CHECK(uncollected_amount >= 0),
 transaction_currency text CHECK(transaction_currency ~ '^[A-Z]{3}$'),transaction_paid_amount numeric(19,4),transaction_deducted_amount numeric(19,4),
 reporting_fx_rate numeric(19,10),reporting_fx_evidence jsonb,
 below_threshold boolean NOT NULL DEFAULT false,authorisation_reference text CHECK(length(btrim(authorisation_reference)) BETWEEN 1 AND 100),
 reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(reasons)='array'),
 status text NOT NULL DEFAULT 'posted' CHECK(status IN('posted','voided')),voided_at timestamptz,voided_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),created_by uuid,
 UNIQUE(org_id,id),CONSTRAINT withholding_deductions_payment_line_key UNIQUE(org_id,payment_document_id,bill_open_line_id),
 CHECK(period_end >= period_start AND payment_date BETWEEN period_start AND period_end),
 CHECK((status='voided') = (voided_at IS NOT NULL)),
 CONSTRAINT withholding_deductions_fx_evidence_complete CHECK(num_nonnulls(transaction_currency,transaction_paid_amount,transaction_deducted_amount,reporting_fx_rate,reporting_fx_evidence) IN(0,5)),
 CONSTRAINT withholding_deductions_transaction_amounts CHECK(transaction_paid_amount >= 0 AND transaction_deducted_amount >= 0 AND transaction_deducted_amount <= transaction_paid_amount AND reporting_fx_rate > 0),
 CONSTRAINT withholding_deductions_fx_evidence_scope CHECK(reporting_fx_evidence IS NULL OR
  (jsonb_typeof(reporting_fx_evidence)='object' AND reporting_fx_evidence->>'kind'='as-of'
   AND reporting_fx_evidence->>'from'=transaction_currency AND reporting_fx_evidence->>'to'=currency
   AND reporting_fx_evidence->>'asOf'=payment_date::text AND reporting_fx_evidence->>'policy'='direct-or-inverse-spot'
   AND reporting_fx_evidence->>'table'='fx_rates' AND reporting_fx_evidence->>'digest' ~ '^[a-f0-9]{64}$'
   AND (reporting_fx_evidence->>'rate')::numeric=reporting_fx_rate
   AND jsonb_typeof(reporting_fx_evidence->'observations')='array'
   AND (reporting_fx_evidence->>'sameCurrencyPar')::boolean=(transaction_currency=currency)) IS TRUE),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,enrollment_id) REFERENCES public.withholding_enrollments(org_id,id),
 FOREIGN KEY(org_id,standing_id) REFERENCES public.withholding_standings(org_id,id),
 FOREIGN KEY(org_id,party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,payment_document_id) REFERENCES public.documents(org_id,id),
 FOREIGN KEY(org_id,bill_document_id) REFERENCES public.documents(org_id,id),
 FOREIGN KEY(org_id,bill_open_line_id) REFERENCES public.journal_lines(org_id,id),
 FOREIGN KEY(org_id,journal_entry_id) REFERENCES public.journal_entries(org_id,id),
 FOREIGN KEY(org_id,created_by) REFERENCES public.users(org_id,id),FOREIGN KEY(org_id,voided_by) REFERENCES public.users(org_id,id)
);
CREATE INDEX withholding_deductions_period ON public.withholding_deductions(org_id,enrollment_id,period_start) WHERE status='posted';
CREATE INDEX withholding_deductions_payee_year ON public.withholding_deductions(org_id,party_id,scheme_code,payment_date);
COMMENT ON TABLE public.withholding_deductions IS 'Tax a contractor deducted from one payment application to a subcontractor, with the base, band and rate it was computed on; voided with the payment, never edited.';
COMMENT ON COLUMN public.withholding_deductions.currency IS 'Statutory scheme currency for all reporting amount columns; payment cash retains its original transaction currency.';
COMMENT ON COLUMN public.withholding_deductions.reporting_fx_evidence IS 'Frozen native transaction-to-statutory spot quote, including source observations and digest; complete transaction evidence is paired or absent for legacy same-currency history.';

CREATE FUNCTION public.withholding_deductions_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF public.openbooks_clone_authority() THEN RETURN COALESCE(NEW,OLD); END IF;
 IF TG_OP='UPDATE' AND OLD.status='posted' AND NEW.status='voided'
  AND (to_jsonb(OLD)-ARRAY['status','voided_at','voided_by'])=(to_jsonb(NEW)-ARRAY['status','voided_at','voided_by']) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'A recorded withholding deduction is evidence for a return; void the payment instead of editing it.' USING ERRCODE='23514';
END $function$;
CREATE TRIGGER withholding_deductions_guard BEFORE UPDATE OR DELETE ON public.withholding_deductions FOR EACH ROW EXECUTE FUNCTION public.withholding_deductions_guard();

CREATE FUNCTION public.withholding_returns_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
 IF TG_OP='DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
 IF public.openbooks_clone_authority() THEN RETURN COALESCE(NEW,OLD); END IF;
 IF TG_OP='DELETE' AND OLD.status='prepared' THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['status','filed_at','filed_by','filing_reference','remittance_document_id'])=(to_jsonb(NEW)-ARRAY['status','filed_at','filed_by','filing_reference','remittance_document_id'])
  AND ((OLD.status='prepared' AND NEW.status IN('prepared','filed')) OR (OLD.status='filed' AND NEW.status IN('filed','superseded') AND (OLD.filed_at,OLD.filed_by,OLD.filing_reference) IS NOT DISTINCT FROM (NEW.filed_at,NEW.filed_by,NEW.filing_reference))) THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'A filed withholding return is frozen; prepare a new revision for the period instead.' USING ERRCODE='23514';
END $function$;
CREATE TRIGGER withholding_returns_guard BEFORE UPDATE OR DELETE ON public.withholding_returns FOR EACH ROW EXECUTE FUNCTION public.withholding_returns_guard();

ALTER TABLE public.withholding_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withholding_enrollments FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.withholding_enrollments USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.withholding_enrollments IS 'openbooks:org_isolation:v1';
ALTER TABLE public.withholding_standings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withholding_standings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.withholding_standings USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.withholding_standings IS 'openbooks:org_isolation:v1';
ALTER TABLE public.withholding_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withholding_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.withholding_returns USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.withholding_returns IS 'openbooks:org_isolation:v1';
ALTER TABLE public.withholding_deductions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withholding_deductions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.withholding_deductions USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.withholding_deductions IS 'openbooks:org_isolation:v1';

INSERT INTO public.openbooks_query_catalog_relations(relation,added_in) VALUES
 ('withholding_enrollments','0599_contractor_withholding'),('withholding_standings','0599_contractor_withholding'),
 ('withholding_deductions','0599_contractor_withholding'),('withholding_returns','0599_contractor_withholding')
 ON CONFLICT(relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
