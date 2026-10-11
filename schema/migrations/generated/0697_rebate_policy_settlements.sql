-- Governed retrospective rebate agreements, accrued facts and settlement claims.
CREATE TABLE public.rebate_agreements (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 code text NOT NULL, name text NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved')),
 subsidiary_id uuid NOT NULL, side text NOT NULL CHECK(side IN ('customer','vendor')),
 activity text NOT NULL CHECK(activity IN ('sale','purchase','downstream_sale')),
 party_id uuid, class_id uuid, item_id uuid, currency text NOT NULL REFERENCES public.currencies(code),
 effective_from date NOT NULL, effective_to date NOT NULL CHECK(effective_to>=effective_from),
 method text NOT NULL CHECK(method IN ('percent','per_unit','fixed_cost','guaranteed_margin')),
 tier_basis text NOT NULL CHECK(tier_basis IN ('amount','quantity')), tiers jsonb NOT NULL,
 target_unit_cost numeric(19,4), margin_percent numeric(19,4),
 stacking text NOT NULL CHECK(stacking IN ('stack','best')), selection_group text NOT NULL CHECK(length(btrim(selection_group))>0),
 accrual_account_id uuid NOT NULL, offset_account_id uuid NOT NULL, fx_account_id uuid NOT NULL,
 tax_treatment text NOT NULL CHECK(tax_treatment IN ('outside_scope','taxable')), settlement_tax_code_id uuid,
 CHECK((tax_treatment='outside_scope' AND settlement_tax_code_id IS NULL) OR (tax_treatment='taxable' AND settlement_tax_code_id IS NOT NULL)),
 FOREIGN KEY(org_id,settlement_tax_code_id) REFERENCES public.tax_codes(org_id,id),
 reason text NOT NULL CHECK(length(btrim(reason))>=8), approved_by uuid REFERENCES public.users(id), approved_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES public.users(id),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES public.users(id),
 UNIQUE(org_id,id), UNIQUE(org_id,code),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(org_id,party_id) REFERENCES public.parties(org_id,id), FOREIGN KEY(org_id,class_id) REFERENCES public.classes(org_id,id),
 FOREIGN KEY(org_id,item_id) REFERENCES public.items(org_id,id),
 FOREIGN KEY(org_id,accrual_account_id) REFERENCES public.accounts(org_id,id),
 FOREIGN KEY(org_id,offset_account_id) REFERENCES public.accounts(org_id,id), FOREIGN KEY(org_id,fx_account_id) REFERENCES public.accounts(org_id,id),
 CHECK((side='customer' AND activity='sale' AND (party_id IS NOT NULL OR class_id IS NOT NULL)) OR (side='vendor' AND activity IN ('purchase','downstream_sale') AND party_id IS NOT NULL)),
 CHECK(activity<>'downstream_sale' OR item_id IS NOT NULL),
 CHECK(method<>'fixed_cost' OR (target_unit_cost IS NOT NULL AND target_unit_cost>=0)),
 CHECK(method<>'guaranteed_margin' OR (margin_percent IS NOT NULL AND margin_percent>=0 AND margin_percent<100)),
 CHECK(jsonb_typeof(tiers)='array'), CHECK(accrual_account_id<>offset_account_id AND fx_account_id<>accrual_account_id),
 CHECK((status='draft' AND approved_by IS NULL AND approved_at IS NULL) OR (status='approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by<>created_by))
);
CREATE INDEX rebate_agreements_earning ON public.rebate_agreements(org_id,subsidiary_id,effective_from,effective_to,status);

CREATE TABLE public.rebate_cost_attestations (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 document_line_id uuid NOT NULL, cost_amount numeric(19,4) NOT NULL CHECK(cost_amount>=0),
 currency text NOT NULL REFERENCES public.currencies(code), resale_amount numeric(19,4) CHECK(resale_amount>=0), evidence text NOT NULL CHECK(length(btrim(evidence))>=20),
 actor_id uuid NOT NULL REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now(),
 revision integer NOT NULL CHECK(revision>0), line_basis jsonb NOT NULL,
 UNIQUE(org_id,document_line_id,revision), FOREIGN KEY(org_id,document_line_id) REFERENCES public.document_lines(org_id,id)
);
CREATE TABLE public.rebate_accruals (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 agreement_id uuid NOT NULL, document_line_id uuid NOT NULL, party_id uuid NOT NULL,
 amount numeric(19,4) NOT NULL CHECK(amount<>0), base_amount numeric(19,4) NOT NULL, fx_rate numeric(19,10) NOT NULL CHECK(fx_rate>0),
 journal_entry_id uuid NOT NULL, accrued_on date NOT NULL, revision integer NOT NULL CHECK(revision>0),
 basis jsonb NOT NULL, actor_id uuid REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), UNIQUE(org_id,agreement_id,document_line_id,revision),
 FOREIGN KEY(org_id,agreement_id) REFERENCES public.rebate_agreements(org_id,id),
 FOREIGN KEY(org_id,document_line_id) REFERENCES public.document_lines(org_id,id), FOREIGN KEY(org_id,party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,journal_entry_id) REFERENCES public.journal_entries(org_id,id)
);
CREATE TABLE public.rebate_claims (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 agreement_id uuid NOT NULL, party_id uuid NOT NULL, amount numeric(19,4) NOT NULL CHECK(amount<>0),
 base_amount numeric(19,4) NOT NULL, cutoff_on date NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','document_pending','settled','cancelled')),
 reason text NOT NULL CHECK(length(btrim(reason))>=8), basis jsonb NOT NULL,
 approved_by uuid REFERENCES public.users(id), approved_at timestamptz,
 settlement_document_id uuid, settlement_entry_id uuid, settlement_on date, settlement_basis jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES public.users(id),
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid REFERENCES public.users(id),
 UNIQUE(org_id,id), UNIQUE(org_id,settlement_document_id),
 FOREIGN KEY(org_id,agreement_id) REFERENCES public.rebate_agreements(org_id,id), FOREIGN KEY(org_id,party_id) REFERENCES public.parties(org_id,id),
 FOREIGN KEY(org_id,settlement_document_id) REFERENCES public.documents(org_id,id), FOREIGN KEY(org_id,settlement_entry_id) REFERENCES public.journal_entries(org_id,id),
 CHECK(status IN ('draft','cancelled') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by<>created_by)),
 CHECK(status<>'settled' OR (settlement_entry_id IS NOT NULL AND settlement_on IS NOT NULL))
);
CREATE FUNCTION public.rebate_fact_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF; RAISE EXCEPTION 'Rebate accruals and cost evidence are immutable; post a correcting assessment'; END $$;
CREATE TRIGGER rebate_accruals_immutable BEFORE UPDATE OR DELETE ON public.rebate_accruals FOR EACH ROW EXECUTE FUNCTION public.rebate_fact_immutable();
CREATE TRIGGER rebate_costs_immutable BEFORE UPDATE OR DELETE ON public.rebate_cost_attestations FOR EACH ROW EXECUTE FUNCTION public.rebate_fact_immutable();
CREATE FUNCTION public.rebate_agreement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tier jsonb; last_threshold numeric; threshold numeric; rate numeric;
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Rebate agreements are retained for audit'; END IF;
 IF TG_OP='UPDATE' AND OLD.status='approved' THEN RAISE EXCEPTION 'Approved rebate terms are immutable; create a successor dated agreement'; END IF;
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.org_id,NEW.created_by) IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.created_by) THEN RAISE EXCEPTION 'Rebate agreement identity is immutable'; END IF;
 IF jsonb_array_length(NEW.tiers)>100 OR (NEW.method IN ('percent','per_unit') AND jsonb_array_length(NEW.tiers)=0) THEN RAISE EXCEPTION 'Configure one through one hundred rebate tiers'; END IF;
 FOR tier IN SELECT value FROM jsonb_array_elements(NEW.tiers) LOOP
  IF jsonb_typeof(tier->'threshold') IS DISTINCT FROM 'string' OR jsonb_typeof(tier->'rate') IS DISTINCT FROM 'string'
    OR (tier->>'threshold') !~ '^[0-9]+(\.[0-9]{1,4})?$' OR (tier->>'rate') !~ '^[0-9]+(\.[0-9]{1,4})?$' THEN RAISE EXCEPTION 'Rebate tiers require exact non-negative threshold and rate strings'; END IF;
  threshold:=(tier->>'threshold')::numeric; rate:=(tier->>'rate')::numeric;
  IF (last_threshold IS NOT NULL AND threshold<=last_threshold) OR (NEW.method='percent' AND rate>100) THEN RAISE EXCEPTION 'Rebate thresholds must increase and percentages cannot exceed one hundred'; END IF;
  last_threshold:=threshold;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.org_id=NEW.org_id AND a.id=NEW.accrual_account_id AND a.is_active AND NOT a.is_summary AND a.type=CASE NEW.side WHEN 'customer' THEN 'liability_current_other' ELSE 'asset_current_other' END)
  THEN RAISE EXCEPTION 'Select a postable rebate liability or receivable account for this side'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY[NEW.offset_account_id,NEW.fx_account_id]) target(id) WHERE NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.org_id=NEW.org_id AND a.id=target.id AND a.is_active AND NOT a.is_summary AND a.type IN ('expense','expense_other','cogs','income','income_other')))
  THEN RAISE EXCEPTION 'Select postable income or expense offset and FX accounts'; END IF;
 IF NEW.party_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.parties p WHERE p.org_id=NEW.org_id AND p.id=NEW.party_id AND p.is_active AND (p.subsidiary_id IS NULL OR p.subsidiary_id=NEW.subsidiary_id)
  AND CASE NEW.side WHEN 'customer' THEN EXISTS(SELECT 1 FROM public.customer_roles r WHERE r.org_id=p.org_id AND r.party_id=p.id AND r.is_active) ELSE EXISTS(SELECT 1 FROM public.vendor_roles r WHERE r.org_id=p.org_id AND r.party_id=p.id AND r.is_active) END)
  THEN RAISE EXCEPTION 'Agreement counterparty must hold the active customer or vendor role in this legal entity'; END IF;
 IF NEW.status='approved' AND EXISTS(SELECT 1 FROM public.rebate_agreements a WHERE a.org_id=NEW.org_id AND a.id<>NEW.id AND a.status='approved' AND a.subsidiary_id=NEW.subsidiary_id AND a.side=NEW.side
  AND a.party_id IS NOT DISTINCT FROM NEW.party_id AND a.selection_group=NEW.selection_group AND a.stacking='best' AND NEW.stacking='best'
  AND daterange(a.effective_from,a.effective_to,'[]') && daterange(NEW.effective_from,NEW.effective_to,'[]') AND a.currency<>NEW.currency)
  THEN RAISE EXCEPTION 'Competing best-deal agreements must use the same currency'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rebate_agreement_guard BEFORE INSERT OR UPDATE OR DELETE ON public.rebate_agreements FOR EACH ROW EXECUTE FUNCTION public.rebate_agreement_guard();
CREATE FUNCTION public.rebate_claim_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Rebate claim evidence is retained'; END IF;
 IF ROW(NEW.id,NEW.org_id,NEW.agreement_id,NEW.party_id,NEW.amount,NEW.base_amount,NEW.cutoff_on,NEW.basis,NEW.created_by,NEW.reason)
  IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.agreement_id,OLD.party_id,OLD.amount,OLD.base_amount,OLD.cutoff_on,OLD.basis,OLD.created_by,OLD.reason) THEN RAISE EXCEPTION 'Rebate claim terms are immutable'; END IF;
 IF NOT ((OLD.status='draft' AND NEW.status IN ('approved','cancelled')) OR (OLD.status='approved' AND NEW.status IN ('document_pending','settled','cancelled')) OR (OLD.status='document_pending' AND NEW.status IN ('settled','approved')) OR (OLD.status='settled' AND NEW.status='approved'))
  THEN RAISE EXCEPTION 'Invalid rebate claim transition'; END IF;
 IF OLD.approved_by IS NOT NULL AND ROW(NEW.approved_by,NEW.approved_at) IS DISTINCT FROM ROW(OLD.approved_by,OLD.approved_at) THEN RAISE EXCEPTION 'Claim approval evidence is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rebate_claim_guard BEFORE UPDATE OR DELETE ON public.rebate_claims FOR EACH ROW EXECUTE FUNCTION public.rebate_claim_guard();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['rebate_agreements','rebate_cost_attestations','rebate_accruals','rebate_claims'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING (public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true)) WITH CHECK (public.app_bypass_rls_active() OR org_id::text=current_setting(''app.current_org'',true))',t);
 END LOOP;
END $$;

CREATE TABLE public.rebate_settlement_reversals (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id), claim_id uuid NOT NULL,
 original_entry_id uuid NOT NULL, reversal_entry_id uuid NOT NULL, reversed_on date NOT NULL, reason text NOT NULL CHECK(length(btrim(reason))>=8),
 actor_id uuid NOT NULL REFERENCES public.users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(org_id,original_entry_id),
 FOREIGN KEY(org_id,claim_id) REFERENCES public.rebate_claims(org_id,id),
 FOREIGN KEY(org_id,original_entry_id) REFERENCES public.journal_entries(org_id,id), FOREIGN KEY(org_id,reversal_entry_id) REFERENCES public.journal_entries(org_id,id)
);
CREATE TRIGGER rebate_reversals_immutable BEFORE UPDATE OR DELETE ON public.rebate_settlement_reversals FOR EACH ROW EXECUTE FUNCTION public.rebate_fact_immutable();
ALTER TABLE public.rebate_settlement_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rebate_settlement_reversals FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.rebate_settlement_reversals USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true)) WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.rebate_agreements FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.rebate_cost_attestations FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.rebate_accruals FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.rebate_claims FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.rebate_settlement_reversals FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
