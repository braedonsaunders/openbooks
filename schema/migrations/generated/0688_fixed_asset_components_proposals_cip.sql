-- OpenBooks forward migration 0688_fixed_asset_components_proposals_cip.
--
-- Compound assets, asset proposals from purchases and construction in
-- progress for the fixed-asset register.
--
-- fixed_assets gains parent_asset_id: a component asset belongs to exactly
-- one parent in the same legal entity, one level deep, so cycles cannot
-- form. Construction-in-progress records are fixed_assets rows in the
-- 'construction' status (closed as 'capitalized'); their carried cost moves
-- only through linked GL costs and governed capitalizations, which a guard
-- enforces. The same guard keeps the cost, category, account and legal
-- entity of an asset created from posted cost fixed until its acceptance or
-- capitalization is reversed.
--
-- asset_capitalization_rules hold the effective-dated rules (account, item
-- or item category, with a minimum capitalization amount) that turn posted
-- purchase lines into asset_proposals, one per source journal line.
-- asset_proposal_acceptances and asset_proposal_allocations record each
-- accepted proposal's lineage into assets, components or construction in
-- progress together with its reclassification journal.
-- asset_cip_costs, asset_cip_capitalizations and
-- asset_cip_capitalization_lines are the construction-in-progress
-- subledger. A journal entry that sources an accepted proposal, a linked
-- construction cost or a posted reclassification cannot be reversed until
-- that dependent is reversed first; pending proposals on a reversed source
-- are voided.
--
-- Roles, overrides and API key scopes holding assets.manage also receive
-- assets.capitalize, which accepting proposals and capitalizing
-- construction in progress require.
--
-- Backfill: none. New tables arrive empty; the new column is nullable.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Asset categories are referenced by tenant-composite keys below.
CREATE UNIQUE INDEX IF NOT EXISTS asset_categories_org_id_id_unique ON public.asset_categories USING btree (org_id, id);

-- Compound assets -----------------------------------------------------------

ALTER TABLE public.fixed_assets ADD COLUMN parent_asset_id uuid;
ALTER TABLE public.fixed_assets ADD CONSTRAINT fixed_assets_parent_asset_fkey
  FOREIGN KEY (org_id, parent_asset_id) REFERENCES public.fixed_assets(org_id, id) DEFERRABLE;
ALTER TABLE public.fixed_assets ADD CONSTRAINT fixed_assets_parent_not_self
  CHECK (parent_asset_id IS NULL OR parent_asset_id <> id);
CREATE INDEX fixed_assets_parent ON public.fixed_assets (org_id, parent_asset_id) WHERE parent_asset_id IS NOT NULL;

CREATE FUNCTION public.fixed_asset_component_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  parent record;
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.parent_asset_id IS NOT NULL THEN
    SELECT p.id, p.subsidiary_id, p.parent_asset_id, p.status INTO parent
      FROM public.fixed_assets p
     WHERE p.org_id = NEW.org_id AND p.id = NEW.parent_asset_id
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the parent asset does not exist in this organization' USING ERRCODE = '23503';
    END IF;
    IF parent.parent_asset_id IS NOT NULL THEN
      RAISE EXCEPTION 'a component cannot own components; attach it to the top-level parent asset' USING ERRCODE = '23514';
    END IF;
    IF parent.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id THEN
      RAISE EXCEPTION 'a component must belong to the same legal entity as its parent asset' USING ERRCODE = '23514';
    END IF;
    IF parent.status IN ('construction', 'capitalized') OR NEW.status IN ('construction', 'capitalized') THEN
      RAISE EXCEPTION 'construction-in-progress records cannot own or be components' USING ERRCODE = '23514';
    END IF;
    IF (TG_OP = 'INSERT' OR NEW.parent_asset_id IS DISTINCT FROM OLD.parent_asset_id)
       AND parent.status IN ('disposed', 'written_off') THEN
      RAISE EXCEPTION 'components cannot be added to a disposed or written-off asset' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.fixed_assets c WHERE c.org_id = NEW.org_id AND c.parent_asset_id = NEW.id) THEN
      RAISE EXCEPTION 'an asset that owns components cannot itself become a component' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.subsidiary_id IS DISTINCT FROM OLD.subsidiary_id
     AND EXISTS (SELECT 1 FROM public.fixed_assets c WHERE c.org_id = NEW.org_id AND c.parent_asset_id = NEW.id) THEN
    RAISE EXCEPTION 'an asset with components cannot change legal entity; detach or transfer its components first' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fixed_asset_component_guard BEFORE INSERT OR UPDATE OF parent_asset_id, subsidiary_id, status ON public.fixed_assets
 FOR EACH ROW EXECUTE FUNCTION public.fixed_asset_component_guard();

-- Capitalized cost stays tied to the ledger. The carried cost of a
-- 'construction' record is its open subledger balance, so its status, cost,
-- account and legal entity move only inside the subledger writer's
-- transaction. An asset created by an accepted proposal or a posted
-- capitalization carries exactly the cost that journal moved into its
-- category's account, so its cost, category, account and legal entity stay
-- fixed until that acceptance or capitalization is reversed.
CREATE FUNCTION public.fixed_asset_capitalization_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on'
     OR coalesce(current_setting('openbooks.asset_cip_ledger', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IN ('construction', 'capitalized') THEN
      RAISE EXCEPTION 'create construction in progress from Fixed Assets → Construction in progress' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.status IN ('construction', 'capitalized') OR NEW.status IN ('construction', 'capitalized'))
     AND (NEW.status IS DISTINCT FROM OLD.status
       OR NEW.acquisition_cost IS DISTINCT FROM OLD.acquisition_cost
       OR NEW.asset_account_id IS DISTINCT FROM OLD.asset_account_id
       OR NEW.subsidiary_id IS DISTINCT FROM OLD.subsidiary_id) THEN
    RAISE EXCEPTION 'construction-in-progress cost moves only through linked costs and governed capitalization' USING ERRCODE = '23514';
  END IF;
  IF (NEW.acquisition_cost IS DISTINCT FROM OLD.acquisition_cost
      OR NEW.category_id IS DISTINCT FROM OLD.category_id
      OR NEW.asset_account_id IS DISTINCT FROM OLD.asset_account_id
      OR NEW.subsidiary_id IS DISTINCT FROM OLD.subsidiary_id)
     AND (EXISTS (SELECT 1 FROM public.asset_proposal_allocations al
                    JOIN public.asset_proposal_acceptances ac ON ac.org_id = al.org_id AND ac.id = al.acceptance_id
                   WHERE al.org_id = OLD.org_id AND al.asset_id = OLD.id AND al.cip_cost_id IS NULL AND ac.status = 'posted')
       OR EXISTS (SELECT 1 FROM public.asset_cip_capitalization_lines cl
                    JOIN public.asset_cip_capitalizations k ON k.org_id = cl.org_id AND k.id = cl.capitalization_id
                   WHERE cl.org_id = OLD.org_id AND cl.asset_id = OLD.id AND k.status = 'posted')) THEN
    RAISE EXCEPTION 'this asset''s cost was capitalized from posted transactions; reverse the acceptance or capitalization to change its cost, category, account or legal entity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER fixed_asset_capitalization_guard BEFORE INSERT OR UPDATE ON public.fixed_assets
 FOR EACH ROW EXECUTE FUNCTION public.fixed_asset_capitalization_guard();

-- Capitalization rules ------------------------------------------------------

CREATE TABLE public.asset_capitalization_rules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    name text NOT NULL,
    subsidiary_id uuid,
    match_kind text NOT NULL,
    account_id uuid,
    item_id uuid,
    item_category text,
    asset_category_id uuid,
    minimum_amount numeric(19,4) DEFAULT 0 NOT NULL,
    effective_from date NOT NULL,
    effective_to date,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT asset_capitalization_rules_pkey PRIMARY KEY (id),
    CONSTRAINT asset_capitalization_rules_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_capitalization_rules_name CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    CONSTRAINT asset_capitalization_rules_match_kind CHECK (match_kind IN ('account', 'item', 'item_category')),
    CONSTRAINT asset_capitalization_rules_match_shape CHECK (
      (match_kind = 'account' AND account_id IS NOT NULL AND item_id IS NULL AND item_category IS NULL)
      OR (match_kind = 'item' AND item_id IS NOT NULL AND account_id IS NULL AND item_category IS NULL)
      OR (match_kind = 'item_category' AND item_category IS NOT NULL AND length(btrim(item_category)) > 0 AND account_id IS NULL AND item_id IS NULL)),
    CONSTRAINT asset_capitalization_rules_minimum CHECK (minimum_amount >= 0),
    CONSTRAINT asset_capitalization_rules_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
    CONSTRAINT asset_capitalization_rules_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_capitalization_rules_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id)
      REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
    CONSTRAINT asset_capitalization_rules_account_fkey FOREIGN KEY (org_id, account_id)
      REFERENCES public.accounts(org_id, id) DEFERRABLE,
    CONSTRAINT asset_capitalization_rules_item_fkey FOREIGN KEY (org_id, item_id)
      REFERENCES public.items(org_id, id) DEFERRABLE,
    CONSTRAINT asset_capitalization_rules_category_fkey FOREIGN KEY (org_id, asset_category_id)
      REFERENCES public.asset_categories(org_id, id) DEFERRABLE,
    CONSTRAINT asset_capitalization_rules_created_by_fkey FOREIGN KEY (created_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE,
    CONSTRAINT asset_capitalization_rules_updated_by_fkey FOREIGN KEY (updated_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE
);

CREATE INDEX asset_capitalization_rules_org_window ON public.asset_capitalization_rules (org_id, effective_from DESC);

-- A rule's matching terms are what historical proposals were generated
-- under: once written they never change. Close a rule (effective_to or
-- is_active) and add a new one to change policy from a date forward.
CREATE FUNCTION public.asset_capitalization_rule_terms_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF (NEW.org_id, NEW.subsidiary_id, NEW.match_kind, NEW.account_id, NEW.item_id, NEW.item_category, NEW.minimum_amount, NEW.effective_from)
     IS DISTINCT FROM
     (OLD.org_id, OLD.subsidiary_id, OLD.match_kind, OLD.account_id, OLD.item_id, OLD.item_category, OLD.minimum_amount, OLD.effective_from) THEN
    RAISE EXCEPTION 'capitalization rule terms are effective-dated; end this rule and add a new one from the change date' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER asset_capitalization_rule_terms_guard BEFORE UPDATE ON public.asset_capitalization_rules
 FOR EACH ROW EXECUTE FUNCTION public.asset_capitalization_rule_terms_guard();

ALTER TABLE ONLY public.asset_capitalization_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.asset_capitalization_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.asset_capitalization_rules
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.asset_capitalization_rules IS 'openbooks:org_isolation:v1';

-- Proposal acceptances (created before proposals so proposals can reference them).

CREATE TABLE public.asset_proposal_acceptances (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    subsidiary_id uuid NOT NULL,
    operation text NOT NULL,
    accepted_on date NOT NULL,
    reclass_entry_id uuid,
    status text DEFAULT 'posted' NOT NULL,
    reason text,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    reversal_entry_id uuid,
    reversed_at timestamp with time zone,
    reversed_by uuid,
    reversal_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    CONSTRAINT asset_proposal_acceptances_pkey PRIMARY KEY (id),
    CONSTRAINT asset_proposal_acceptances_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_proposal_acceptances_idempotency UNIQUE (org_id, idempotency_key),
    CONSTRAINT asset_proposal_acceptances_operation CHECK (operation IN ('asset', 'split', 'merge', 'component', 'cip')),
    CONSTRAINT asset_proposal_acceptances_status CHECK (status IN ('posted', 'reversed')),
    CONSTRAINT asset_proposal_acceptances_reversal_shape CHECK (
      (status = 'posted' AND reversed_at IS NULL AND reversed_by IS NULL AND reversal_entry_id IS NULL AND reversal_reason IS NULL)
      OR (status = 'reversed' AND reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_reason IS NOT NULL
          AND length(btrim(reversal_reason)) > 0 AND (reversal_entry_id IS NOT NULL) = (reclass_entry_id IS NOT NULL))),
    CONSTRAINT asset_proposal_acceptances_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_proposal_acceptances_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id)
      REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposal_acceptances_reclass_fkey FOREIGN KEY (org_id, reclass_entry_id)
      REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposal_acceptances_reversal_fkey FOREIGN KEY (org_id, reversal_entry_id)
      REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposal_acceptances_created_by_fkey FOREIGN KEY (org_id, created_by)
      REFERENCES public.users(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposal_acceptances_reversed_by_fkey FOREIGN KEY (org_id, reversed_by)
      REFERENCES public.users(org_id, id) DEFERRABLE
);

CREATE INDEX asset_proposal_acceptances_reclass ON public.asset_proposal_acceptances (org_id, reclass_entry_id) WHERE reclass_entry_id IS NOT NULL;

ALTER TABLE ONLY public.asset_proposal_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.asset_proposal_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.asset_proposal_acceptances
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.asset_proposal_acceptances IS 'openbooks:org_isolation:v1';

-- Proposals -----------------------------------------------------------------

CREATE TABLE public.asset_proposals (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    subsidiary_id uuid NOT NULL,
    origin text DEFAULT 'rule' NOT NULL,
    rule_id uuid,
    source_entry_id uuid NOT NULL,
    source_line_id uuid NOT NULL,
    source_document_id uuid,
    source_document_line_id uuid,
    account_id uuid NOT NULL,
    item_id uuid,
    vendor_party_id uuid,
    department_id uuid,
    project_id uuid,
    location_id uuid,
    description text,
    quantity numeric(28,8),
    amount numeric(19,4) NOT NULL,
    currency text NOT NULL,
    posting_date date NOT NULL,
    suggested_category_id uuid,
    status text DEFAULT 'pending' NOT NULL,
    acceptance_id uuid,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    resolution_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT asset_proposals_pkey PRIMARY KEY (id),
    CONSTRAINT asset_proposals_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_proposals_source_line_unique UNIQUE (org_id, source_line_id),
    CONSTRAINT asset_proposals_origin CHECK (origin IN ('rule', 'manual')),
    CONSTRAINT asset_proposals_origin_shape CHECK ((origin = 'rule') = (rule_id IS NOT NULL)),
    CONSTRAINT asset_proposals_amount CHECK (amount > 0),
    CONSTRAINT asset_proposals_quantity CHECK (quantity IS NULL OR quantity > 0),
    CONSTRAINT asset_proposals_status CHECK (status IN ('pending', 'accepted', 'rejected', 'voided')),
    CONSTRAINT asset_proposals_status_shape CHECK (
      (status = 'pending' AND acceptance_id IS NULL AND resolved_at IS NULL AND resolved_by IS NULL AND resolution_reason IS NULL)
      OR (status = 'accepted' AND acceptance_id IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL)
      OR (status = 'rejected' AND acceptance_id IS NULL AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL
          AND resolution_reason IS NOT NULL AND length(btrim(resolution_reason)) > 0)
      OR (status = 'voided' AND acceptance_id IS NULL AND resolved_at IS NOT NULL
          AND resolution_reason IS NOT NULL AND length(btrim(resolution_reason)) > 0)),
    CONSTRAINT asset_proposals_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_proposals_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id)
      REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_rule_fkey FOREIGN KEY (org_id, rule_id)
      REFERENCES public.asset_capitalization_rules(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_source_entry_fkey FOREIGN KEY (org_id, source_entry_id)
      REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_source_line_fkey FOREIGN KEY (org_id, source_line_id)
      REFERENCES public.journal_lines(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_source_document_fkey FOREIGN KEY (org_id, source_document_id)
      REFERENCES public.documents(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_source_document_line_fkey FOREIGN KEY (org_id, source_document_line_id)
      REFERENCES public.document_lines(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_account_fkey FOREIGN KEY (org_id, account_id)
      REFERENCES public.accounts(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_item_fkey FOREIGN KEY (org_id, item_id)
      REFERENCES public.items(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_vendor_party_fkey FOREIGN KEY (org_id, vendor_party_id)
      REFERENCES public.parties(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_department_fkey FOREIGN KEY (org_id, department_id)
      REFERENCES public.departments(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_project_fkey FOREIGN KEY (org_id, project_id)
      REFERENCES public.projects(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_location_fkey FOREIGN KEY (org_id, location_id)
      REFERENCES public.locations(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_suggested_category_fkey FOREIGN KEY (org_id, suggested_category_id)
      REFERENCES public.asset_categories(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_acceptance_fkey FOREIGN KEY (org_id, acceptance_id)
      REFERENCES public.asset_proposal_acceptances(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_resolved_by_fkey FOREIGN KEY (org_id, resolved_by)
      REFERENCES public.users(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposals_created_by_fkey FOREIGN KEY (created_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE,
    CONSTRAINT asset_proposals_updated_by_fkey FOREIGN KEY (updated_by)
      REFERENCES public.users(id) ON DELETE RESTRICT DEFERRABLE
);

CREATE INDEX asset_proposals_org_status ON public.asset_proposals (org_id, status, posting_date);
CREATE INDEX asset_proposals_source_entry ON public.asset_proposals (org_id, source_entry_id);
CREATE INDEX asset_proposals_source_document_line ON public.asset_proposals (org_id, source_document_line_id) WHERE source_document_line_id IS NOT NULL;

ALTER TABLE ONLY public.asset_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.asset_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.asset_proposals
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.asset_proposals IS 'openbooks:org_isolation:v1';

-- Construction-in-progress subledger ---------------------------------------

CREATE TABLE public.asset_cip_costs (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    cip_asset_id uuid NOT NULL,
    subsidiary_id uuid NOT NULL,
    source_entry_id uuid NOT NULL,
    source_line_id uuid NOT NULL,
    source_document_id uuid,
    account_id uuid NOT NULL,
    project_id uuid,
    amount numeric(19,4) NOT NULL,
    posting_date date NOT NULL,
    memo text,
    status text DEFAULT 'linked' NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    linked_by uuid NOT NULL,
    unlinked_at timestamp with time zone,
    unlinked_by uuid,
    unlink_reason text,
    CONSTRAINT asset_cip_costs_pkey PRIMARY KEY (id),
    CONSTRAINT asset_cip_costs_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_cip_costs_amount CHECK (amount <> 0),
    CONSTRAINT asset_cip_costs_status CHECK (status IN ('linked', 'unlinked')),
    CONSTRAINT asset_cip_costs_unlink_shape CHECK (
      (status = 'linked' AND unlinked_at IS NULL AND unlinked_by IS NULL AND unlink_reason IS NULL)
      OR (status = 'unlinked' AND unlinked_at IS NOT NULL AND unlinked_by IS NOT NULL
          AND unlink_reason IS NOT NULL AND length(btrim(unlink_reason)) > 0)),
    CONSTRAINT asset_cip_costs_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_cip_costs_cip_asset_fkey FOREIGN KEY (org_id, cip_asset_id)
      REFERENCES public.fixed_assets(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_costs_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id)
      REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_costs_source_entry_fkey FOREIGN KEY (org_id, source_entry_id)
      REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_costs_source_line_fkey FOREIGN KEY (org_id, source_line_id)
      REFERENCES public.journal_lines(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_costs_source_document_fkey FOREIGN KEY (org_id, source_document_id)
      REFERENCES public.documents(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_costs_account_fkey FOREIGN KEY (org_id, account_id)
      REFERENCES public.accounts(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_costs_project_fkey FOREIGN KEY (org_id, project_id)
      REFERENCES public.projects(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_costs_linked_by_fkey FOREIGN KEY (org_id, linked_by)
      REFERENCES public.users(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_costs_unlinked_by_fkey FOREIGN KEY (org_id, unlinked_by)
      REFERENCES public.users(org_id, id) DEFERRABLE
);

-- A GL line feeds at most one live construction-in-progress record.
CREATE UNIQUE INDEX asset_cip_costs_live_source_line ON public.asset_cip_costs (org_id, source_line_id) WHERE status = 'linked';
CREATE INDEX asset_cip_costs_cip ON public.asset_cip_costs (org_id, cip_asset_id, status);
CREATE INDEX asset_cip_costs_source_entry ON public.asset_cip_costs (org_id, source_entry_id);

ALTER TABLE ONLY public.asset_cip_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.asset_cip_costs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.asset_cip_costs
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.asset_cip_costs IS 'openbooks:org_isolation:v1';

CREATE TABLE public.asset_cip_capitalizations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    cip_asset_id uuid NOT NULL,
    subsidiary_id uuid NOT NULL,
    capitalized_on date NOT NULL,
    entry_id uuid NOT NULL,
    capitalized_amount numeric(19,4) NOT NULL,
    expensed_amount numeric(19,4) NOT NULL,
    reason text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    status text DEFAULT 'posted' NOT NULL,
    reversal_entry_id uuid,
    reversed_at timestamp with time zone,
    reversed_by uuid,
    reversal_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    CONSTRAINT asset_cip_capitalizations_pkey PRIMARY KEY (id),
    CONSTRAINT asset_cip_capitalizations_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_cip_capitalizations_idempotency UNIQUE (org_id, idempotency_key),
    CONSTRAINT asset_cip_capitalizations_amounts CHECK (capitalized_amount >= 0 AND expensed_amount >= 0 AND capitalized_amount + expensed_amount > 0),
    CONSTRAINT asset_cip_capitalizations_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
    CONSTRAINT asset_cip_capitalizations_status CHECK (status IN ('posted', 'reversed')),
    CONSTRAINT asset_cip_capitalizations_reversal_shape CHECK (
      (status = 'posted' AND reversal_entry_id IS NULL AND reversed_at IS NULL AND reversed_by IS NULL AND reversal_reason IS NULL)
      OR (status = 'reversed' AND reversal_entry_id IS NOT NULL AND reversed_at IS NOT NULL AND reversed_by IS NOT NULL
          AND reversal_reason IS NOT NULL AND length(btrim(reversal_reason)) > 0)),
    CONSTRAINT asset_cip_capitalizations_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_cip_capitalizations_cip_asset_fkey FOREIGN KEY (org_id, cip_asset_id)
      REFERENCES public.fixed_assets(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_capitalizations_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id)
      REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_capitalizations_entry_fkey FOREIGN KEY (org_id, entry_id)
      REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_capitalizations_reversal_fkey FOREIGN KEY (org_id, reversal_entry_id)
      REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_capitalizations_created_by_fkey FOREIGN KEY (org_id, created_by)
      REFERENCES public.users(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_capitalizations_reversed_by_fkey FOREIGN KEY (org_id, reversed_by)
      REFERENCES public.users(org_id, id) DEFERRABLE
);

CREATE INDEX asset_cip_capitalizations_cip ON public.asset_cip_capitalizations (org_id, cip_asset_id, capitalized_on);
CREATE INDEX asset_cip_capitalizations_entry ON public.asset_cip_capitalizations (org_id, entry_id);

ALTER TABLE ONLY public.asset_cip_capitalizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.asset_cip_capitalizations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.asset_cip_capitalizations
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.asset_cip_capitalizations IS 'openbooks:org_isolation:v1';

CREATE TABLE public.asset_cip_capitalization_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    capitalization_id uuid NOT NULL,
    line_number integer NOT NULL,
    kind text NOT NULL,
    asset_id uuid,
    asset_number text,
    parent_asset_id uuid,
    target_account_id uuid NOT NULL,
    amount numeric(19,4) NOT NULL,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_cip_capitalization_lines_pkey PRIMARY KEY (id),
    CONSTRAINT asset_cip_capitalization_lines_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_cip_capitalization_lines_number UNIQUE (org_id, capitalization_id, line_number),
    CONSTRAINT asset_cip_capitalization_lines_kind CHECK (kind IN ('asset', 'component', 'expense')),
    CONSTRAINT asset_cip_capitalization_lines_shape CHECK (
      (kind = 'expense' AND asset_number IS NULL AND asset_id IS NULL AND parent_asset_id IS NULL)
      OR (kind = 'asset' AND asset_number IS NOT NULL AND parent_asset_id IS NULL)
      OR (kind = 'component' AND asset_number IS NOT NULL AND parent_asset_id IS NOT NULL)),
    CONSTRAINT asset_cip_capitalization_lines_amount CHECK (amount > 0),
    CONSTRAINT asset_cip_capitalization_lines_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_cip_capitalization_lines_capitalization_fkey FOREIGN KEY (org_id, capitalization_id)
      REFERENCES public.asset_cip_capitalizations(org_id, id) DEFERRABLE,
    -- A reversed capitalization clears asset_id before removing the draft
    -- asset it created; asset_number stays as evidence.
    CONSTRAINT asset_cip_capitalization_lines_asset_fkey FOREIGN KEY (org_id, asset_id)
      REFERENCES public.fixed_assets(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_capitalization_lines_parent_fkey FOREIGN KEY (org_id, parent_asset_id)
      REFERENCES public.fixed_assets(org_id, id) DEFERRABLE,
    CONSTRAINT asset_cip_capitalization_lines_account_fkey FOREIGN KEY (org_id, target_account_id)
      REFERENCES public.accounts(org_id, id) DEFERRABLE
);

CREATE INDEX asset_cip_capitalization_lines_asset ON public.asset_cip_capitalization_lines (org_id, asset_id) WHERE asset_id IS NOT NULL;

ALTER TABLE ONLY public.asset_cip_capitalization_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.asset_cip_capitalization_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.asset_cip_capitalization_lines
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.asset_cip_capitalization_lines IS 'openbooks:org_isolation:v1';

-- Proposal allocations: one row per (proposal, resulting asset or
-- construction cost). A reversed acceptance clears asset_id before removing
-- the draft assets it created; asset_number stays as evidence. While the
-- reference stands, the asset cannot be deleted.
CREATE TABLE public.asset_proposal_allocations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    acceptance_id uuid NOT NULL,
    proposal_id uuid NOT NULL,
    asset_id uuid,
    asset_number text NOT NULL,
    cip_cost_id uuid,
    target_account_id uuid NOT NULL,
    amount numeric(19,4) NOT NULL,
    quantity numeric(28,8),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT asset_proposal_allocations_pkey PRIMARY KEY (id),
    CONSTRAINT asset_proposal_allocations_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT asset_proposal_allocations_amount CHECK (amount > 0),
    CONSTRAINT asset_proposal_allocations_quantity CHECK (quantity IS NULL OR quantity > 0),
    CONSTRAINT asset_proposal_allocations_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
    CONSTRAINT asset_proposal_allocations_acceptance_fkey FOREIGN KEY (org_id, acceptance_id)
      REFERENCES public.asset_proposal_acceptances(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposal_allocations_proposal_fkey FOREIGN KEY (org_id, proposal_id)
      REFERENCES public.asset_proposals(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposal_allocations_asset_fkey FOREIGN KEY (org_id, asset_id)
      REFERENCES public.fixed_assets(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposal_allocations_cip_cost_fkey FOREIGN KEY (org_id, cip_cost_id)
      REFERENCES public.asset_cip_costs(org_id, id) DEFERRABLE,
    CONSTRAINT asset_proposal_allocations_account_fkey FOREIGN KEY (org_id, target_account_id)
      REFERENCES public.accounts(org_id, id) DEFERRABLE
);

CREATE INDEX asset_proposal_allocations_acceptance ON public.asset_proposal_allocations (org_id, acceptance_id);
CREATE INDEX asset_proposal_allocations_proposal ON public.asset_proposal_allocations (org_id, proposal_id);
CREATE INDEX asset_proposal_allocations_asset ON public.asset_proposal_allocations (org_id, asset_id) WHERE asset_id IS NOT NULL;

ALTER TABLE ONLY public.asset_proposal_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.asset_proposal_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.asset_proposal_allocations
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.asset_proposal_allocations IS 'openbooks:org_isolation:v1';

-- Source-journal reversal fence ---------------------------------------------
-- A journal entry that an accepted proposal, a linked construction cost or a
-- posted acceptance or capitalization depends on cannot be reversed until the
-- dependent is reversed first. Pending proposals on a reversed source are
-- voided in the same statement, so the queue never offers a cost that left
-- the ledger.
CREATE FUNCTION public.asset_capitalization_source_reversal_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.asset_proposals p
              WHERE p.org_id = NEW.org_id AND p.source_entry_id = NEW.id AND p.status = 'accepted') THEN
    RAISE EXCEPTION 'this transaction is the source of an accepted fixed-asset proposal; reverse the acceptance from Fixed Assets → Proposals before reversing it' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.asset_cip_costs c
              WHERE c.org_id = NEW.org_id AND c.source_entry_id = NEW.id AND c.status = 'linked') THEN
    RAISE EXCEPTION 'this transaction carries a cost linked to construction in progress; unlink the cost from Fixed Assets → Construction in progress before reversing it' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.asset_proposal_acceptances a
              WHERE a.org_id = NEW.org_id AND a.reclass_entry_id = NEW.id AND a.status = 'posted') THEN
    RAISE EXCEPTION 'this reclassification belongs to an accepted fixed-asset proposal; use Reverse acceptance on the proposal instead' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.asset_cip_capitalizations k
              WHERE k.org_id = NEW.org_id AND k.entry_id = NEW.id AND k.status = 'posted') THEN
    RAISE EXCEPTION 'this journal belongs to a construction-in-progress capitalization; use Reverse capitalization on the record instead' USING ERRCODE = '23514';
  END IF;
  UPDATE public.asset_proposals
     SET status = 'voided', resolved_at = now(), resolved_by = NULL,
         resolution_reason = 'The source transaction was reversed.',
         updated_at = now(), updated_by = NEW.updated_by
   WHERE org_id = NEW.org_id AND source_entry_id = NEW.id AND status = 'pending';
  RETURN NEW;
END;
$$;
CREATE TRIGGER asset_capitalization_source_reversal_guard BEFORE UPDATE OF status ON public.journal_entries
 FOR EACH ROW WHEN (NEW.status = 'reversed' AND OLD.status IS DISTINCT FROM 'reversed')
 EXECUTE FUNCTION public.asset_capitalization_source_reversal_guard();

-- Retirement fences ---------------------------------------------------------

DO $fences$
DECLARE
  rel text;
BEGIN
 FOREACH rel IN ARRAY ARRAY['asset_capitalization_rules', 'asset_proposal_acceptances', 'asset_proposals',
   'asset_cip_costs', 'asset_cip_capitalizations', 'asset_cip_capitalization_lines', 'asset_proposal_allocations'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = rel AND t.tgname = 'tenant_retirement_fence') THEN
   EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()', rel);
  END IF;
 END LOOP;
END $fences$;

-- Permissions ---------------------------------------------------------------

UPDATE app_roles SET permissions = permissions || '["assets.capitalize"]'::jsonb, updated_at = now()
 WHERE (permissions ? 'assets.manage' OR permissions ? 'assets.*')
   AND NOT (permissions ? 'assets.capitalize' OR permissions ? '*');

INSERT INTO user_permission_overrides (org_id, user_id, permission, effect)
SELECT DISTINCT o.org_id, o.user_id, m.new_key, o.effect
  FROM user_permission_overrides o
  JOIN (VALUES ('assets.manage', 'assets.capitalize'),
               ('assets.*', 'assets.capitalize')) AS m(old_key, new_key)
    ON m.old_key = o.permission
-- An explicit override a user already holds for the new key keeps deciding it.
ON CONFLICT (user_id, permission) DO NOTHING;

UPDATE api_keys SET scopes = scopes || '["assets.capitalize"]'::jsonb
 WHERE (scopes ? 'assets.manage' OR scopes ? 'assets.*')
   AND NOT (scopes ? 'assets.capitalize' OR scopes ? '*');

-- Governed query catalog -----------------------------------------------------

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('asset_capitalization_rules', '0688_fixed_asset_components_proposals_cip'),
  ('asset_proposal_acceptances', '0688_fixed_asset_components_proposals_cip'),
  ('asset_proposals', '0688_fixed_asset_components_proposals_cip'),
  ('asset_cip_costs', '0688_fixed_asset_components_proposals_cip'),
  ('asset_cip_capitalizations', '0688_fixed_asset_components_proposals_cip'),
  ('asset_cip_capitalization_lines', '0688_fixed_asset_components_proposals_cip'),
  ('asset_proposal_allocations', '0688_fixed_asset_components_proposals_cip')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
