-- OpenBooks forward migration 0680_account_localization_and_merge.
--
-- Account merges: an account can be merged into a surviving account of the
-- same organization. The merged account records the survivor, when and by
-- whom it was merged and why; it is inactive and stays merged permanently.
-- account_merges is the append-only record of each executed merge (its
-- previewed consequences digest, the reclass journals that moved the
-- balance and the configuration references that were redirected). Posted
-- history is never rewritten: journal lines keep their original account.
-- New postings, new parent links and new references from any table with a
-- foreign key to accounts are refused while they name a merged account, so
-- every write path (screens, API, imports, scripts, jobs) meets the same
-- refusal naming the survivor. Account merge proposals can be governed by
-- an optional Accounting event approval flow through financial_changes
-- under the new ledger domain; a binding check keeps each proposal tied to
-- its source account, survivor, effective date and previewed consequences.
--
-- Accounting contexts: named presentation contexts (for example a local
-- statutory chart) with optional per-subsidiary or per-country defaults,
-- and per-account localized numbers and names, effective-dated and
-- optionally subsidiary-specific. Localized numbers are unique within a
-- context and subsidiary scope for overlapping effective windows.
--
-- Backfill: none. Every existing account stays unmerged; the new tables
-- start empty.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Merged-account state on accounts
-- ---------------------------------------------------------------------------
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS merged_into_id uuid;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS merged_at timestamp with time zone;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS merged_by uuid;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS merge_reason text;

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_merged_into_id_fkey;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_merged_into_id_fkey
  FOREIGN KEY (org_id, merged_into_id) REFERENCES public.accounts(org_id, id) DEFERRABLE;

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_merge_state;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_merge_state CHECK (
  (merged_into_id IS NULL AND merged_at IS NULL AND merged_by IS NULL AND merge_reason IS NULL)
  OR (merged_into_id IS NOT NULL AND merged_into_id <> id AND merged_at IS NOT NULL
      AND merged_by IS NOT NULL AND merge_reason IS NOT NULL
      AND length(btrim(merge_reason)) BETWEEN 8 AND 1000 AND NOT is_active)
);

CREATE INDEX IF NOT EXISTS accounts_merged_into
  ON public.accounts (org_id, merged_into_id) WHERE merged_into_id IS NOT NULL;

COMMENT ON COLUMN public.accounts.merged_into_id IS 'Surviving account this account was merged into; set once by the account merge command and permanent.';

-- ---------------------------------------------------------------------------
-- Executed merges (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_merges (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  source_account_id uuid NOT NULL,
  target_account_id uuid NOT NULL,
  effective_date date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 1000),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 120),
  financial_change_id uuid,
  preview_digest text NOT NULL CHECK (preview_digest ~ '^[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  merged_by uuid NOT NULL,
  merged_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CONSTRAINT account_merges_idempotency UNIQUE (org_id, idempotency_key),
  CONSTRAINT account_merges_source_once UNIQUE (org_id, source_account_id),
  CONSTRAINT account_merges_distinct CHECK (source_account_id <> target_account_id),
  CONSTRAINT account_merges_source_fkey FOREIGN KEY (org_id, source_account_id)
    REFERENCES public.accounts(org_id, id) DEFERRABLE,
  CONSTRAINT account_merges_target_fkey FOREIGN KEY (org_id, target_account_id)
    REFERENCES public.accounts(org_id, id) DEFERRABLE,
  CONSTRAINT account_merges_change_fkey FOREIGN KEY (org_id, financial_change_id)
    REFERENCES public.financial_changes(org_id, id) DEFERRABLE,
  CONSTRAINT account_merges_merged_by_fkey FOREIGN KEY (org_id, merged_by)
    REFERENCES public.users(org_id, id) DEFERRABLE
);
CREATE INDEX IF NOT EXISTS account_merges_target
  ON public.account_merges (org_id, target_account_id);
CREATE INDEX IF NOT EXISTS account_merges_recent
  ON public.account_merges (org_id, merged_at DESC, id);
COMMENT ON TABLE public.account_merges IS 'Append-only record of executed account merges: survivor, effective date, reason, previewed consequences digest, reclass journals and redirected references.';

CREATE OR REPLACE FUNCTION public.account_merge_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Account merges are permanent history; correct a merge with an adjusting journal entry.';
END;
$$;
DROP TRIGGER IF EXISTS account_merge_immutable ON public.account_merges;
CREATE TRIGGER account_merge_immutable BEFORE UPDATE OR DELETE ON public.account_merges
  FOR EACH ROW EXECUTE FUNCTION public.account_merge_immutable();

ALTER TABLE public.account_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_merges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.account_merges;
CREATE POLICY org_isolation ON public.account_merges
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.account_merges IS 'openbooks:org_isolation:v1';

-- ---------------------------------------------------------------------------
-- Merged-account guard on accounts: permanent, survivor-validated, and
-- recorded by the merge command before the account is marked.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_merge_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  v_survivor record;
  v_parent_survivor uuid;
BEGIN
  IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.merged_into_id IS NOT NULL THEN
    IF NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id
       OR NEW.merged_at IS DISTINCT FROM OLD.merged_at
       OR NEW.merged_by IS DISTINCT FROM OLD.merged_by
       OR NEW.merge_reason IS DISTINCT FROM OLD.merge_reason THEN
      RAISE EXCEPTION 'account % was merged into account %; a merge is permanent — correct it with an adjusting journal entry', OLD.id, OLD.merged_into_id
        USING ERRCODE = '23514';
    END IF;
    IF NEW.is_active THEN
      RAISE EXCEPTION 'account % was merged into account % and cannot be reactivated — use the surviving account', OLD.id, OLD.merged_into_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.merged_into_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.merged_into_id IS NULL) THEN
    SELECT id, is_active, is_summary, merged_into_id INTO v_survivor
      FROM public.accounts
     WHERE org_id = NEW.org_id AND id = NEW.merged_into_id
     FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'account % can only be merged into an account of the same organization', NEW.id
        USING ERRCODE = '23514';
    END IF;
    IF NOT v_survivor.is_active OR v_survivor.is_summary OR v_survivor.merged_into_id IS NOT NULL THEN
      RAISE EXCEPTION 'account % can only be merged into an active, postable, unmerged account', NEW.id
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.account_merges m
       WHERE m.org_id = NEW.org_id AND m.source_account_id = NEW.id
         AND m.target_account_id = NEW.merged_into_id
    ) THEN
      RAISE EXCEPTION 'account % is marked merged only by the account merge command, which records the merge first', NEW.id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.parent_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
    SELECT merged_into_id INTO v_parent_survivor
      FROM public.accounts WHERE org_id = NEW.org_id AND id = NEW.parent_id;
    IF v_parent_survivor IS NOT NULL THEN
      RAISE EXCEPTION 'parent account % was merged into account % — choose the surviving account as the parent', NEW.parent_id, v_parent_survivor
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_merge_guard ON public.accounts;
CREATE TRIGGER account_merge_guard
  BEFORE INSERT OR UPDATE OF merged_into_id, merged_at, merged_by, merge_reason, is_active, parent_id ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.account_merge_guard();

-- ---------------------------------------------------------------------------
-- Postings: a merged account refuses every new journal line, naming the
-- survivor. The guard is otherwise identical to jl_check_account v5.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jl_check_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_summary boolean;
  v_active boolean;
  v_ccy text;
  v_merged_into uuid;
begin
  -- Evidence-only stamps (0236) are not postings. The line satisfied the
  -- posting rules below when it was posted; recording cleared/reconciled
  -- evidence changes no posting-relevant field, so the question is not
  -- re-opened. The column set matches jl_guard() exactly: any UPDATE that
  -- touches anything else falls through to the full checks. Whether the
  -- stamp itself is a legal append-only transition stays jl_guard's call.
  if tg_op = 'UPDATE'
     and to_jsonb(new) - 'reconciled_at' - 'reconciliation_id' - 'source_cleared_date' - 'source_cleared_connector'
       = to_jsonb(old) - 'reconciled_at' - 'reconciliation_id' - 'source_cleared_date' - 'source_cleared_connector'
  then
    return new;
  end if;
  select is_summary, is_active, currency_restriction, merged_into_id
    into v_summary, v_active, v_ccy, v_merged_into
   from accounts
   where id = new.account_id and org_id = new.org_id
     for share;
  if not found then
    raise exception 'account % does not exist in organization %', new.account_id, new.org_id
      using errcode = '23503';
  end if;
  if v_summary then
    raise exception 'account % is a summary account and cannot be posted to', new.account_id;
  end if;
  if v_merged_into is not null then
    raise exception 'account % was merged into account % — post to the surviving account instead', new.account_id, v_merged_into
      using errcode = '23514';
  end if;
  if not v_active and coalesce(current_setting('openbooks.migration', true), 'off') <> 'on' then
    raise exception 'account % is inactive — reactivate the account or map the posting to an active account instead of posting to a deactivated one', new.account_id;
  end if;
  if v_ccy is not null and new.currency <> v_ccy then
    raise exception 'account % only accepts % postings', new.account_id, v_ccy;
  end if;
  return new;
end $$;

COMMENT ON FUNCTION public.jl_check_account() IS
  'openbooks:jl_check_account:v6 - locks the tenant-coherent account row before validating a direct journal-line write; evidence-only stamps (0236) are not re-validated as postings; the inactive-account refusal (0338/G9) names the remedy; a merged account (0680) refuses every posting and names its survivor';

-- ---------------------------------------------------------------------------
-- New references: every table with a foreign key to accounts refuses a new
-- or changed reference to a merged account. Unchanged references (posted
-- history, configuration not yet edited) keep reading. Sandbox copies carry
-- history verbatim under the clone authority.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refuse_merged_account_reference() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  v_column text;
  v_new text;
  v_survivor uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.accounts
     WHERE org_id = NEW.org_id AND merged_into_id IS NOT NULL
  ) THEN
    RETURN NEW;
  END IF;
  IF public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;
  FOREACH v_column IN ARRAY TG_ARGV LOOP
    v_new := to_jsonb(NEW) ->> v_column;
    CONTINUE WHEN v_new IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE' AND (to_jsonb(OLD) ->> v_column) IS NOT DISTINCT FROM v_new;
    SELECT merged_into_id INTO v_survivor
      FROM public.accounts
     WHERE org_id = NEW.org_id AND id = v_new::uuid;
    IF v_survivor IS NOT NULL THEN
      RAISE EXCEPTION '%.% names account %, which was merged into account % — choose the surviving account', TG_TABLE_NAME, v_column, v_new, v_survivor
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.refuse_merged_account_reference() IS
  'openbooks:merged_account_reference_guard:v1 - refuses a new or changed reference to a merged account; arguments name the referencing columns';

DO $attach$
DECLARE
  v_ref record;
BEGIN
  FOR v_ref IN
    SELECT c.conrelid::regclass AS rel,
           cls.relname AS table_name,
           array_agg(DISTINCT a.attname ORDER BY a.attname) AS columns
      FROM pg_constraint c
      JOIN pg_class cls ON cls.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = cls.relnamespace AND n.nspname = 'public'
      JOIN LATERAL unnest(c.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'f'
       AND c.confrelid = 'public.accounts'::regclass
       AND a.attname <> 'org_id'
       AND cls.relname NOT IN ('accounts', 'journal_lines', 'account_merges', 'account_localizations')
       AND EXISTS (SELECT 1 FROM pg_attribute o WHERE o.attrelid = c.conrelid AND o.attname = 'org_id' AND NOT o.attisdropped)
     GROUP BY c.conrelid, cls.relname
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', left(v_ref.table_name, 40) || '_merged_account_guard', v_ref.rel);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %s ON %s FOR EACH ROW EXECUTE FUNCTION public.refuse_merged_account_reference(%s)',
      left(v_ref.table_name, 40) || '_merged_account_guard',
      (SELECT string_agg(format('%I', col), ', ') FROM unnest(v_ref.columns) AS col),
      v_ref.rel,
      (SELECT string_agg(quote_literal(col), ', ') FROM unnest(v_ref.columns) AS col)
    );
  END LOOP;
END;
$attach$;

-- ---------------------------------------------------------------------------
-- Optional approval: account merge proposals ride the shared Accounting
-- event ledger under the ledger domain.
-- ---------------------------------------------------------------------------
DO $block$ DECLARE domain_constraint text; BEGIN
 SELECT conname INTO STRICT domain_constraint FROM pg_constraint
  WHERE conrelid = 'public.financial_changes'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%lease%revenue%asset%consolidation%manufacturing%provision%sales%payroll%';
 EXECUTE format('ALTER TABLE public.financial_changes DROP CONSTRAINT %I', domain_constraint);
 EXECUTE format('ALTER TABLE public.financial_changes ADD CONSTRAINT %I CHECK(domain IN (''lease'',''revenue'',''asset'',''consolidation'',''manufacturing'',''provision'',''sales'',''payroll'',''ledger''))', domain_constraint);
END $block$;

CREATE OR REPLACE FUNCTION public.account_merge_change_binding() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF NEW.domain <> 'ledger' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;
  IF NEW.operation <> 'account_merge' THEN
    RAISE EXCEPTION 'ledger accounting events admit only the account_merge operation, not %', NEW.operation
      USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
     OR NEW.payload ->> 'sourceAccountId' IS DISTINCT FROM NEW.subject_id::text
     OR NEW.payload ->> 'effectiveDate' IS DISTINCT FROM NEW.effective_on::text
     OR coalesce(NEW.payload ->> 'previewDigest', '') !~ '^[0-9a-f]{64}$'
     OR coalesce(NEW.payload ->> 'targetAccountId', '') !~ '^[0-9a-fA-F-]{36}$'
     OR jsonb_typeof(NEW.payload -> 'requiredSubsidiaryIds') IS DISTINCT FROM 'array'
     OR NOT EXISTS (SELECT 1 FROM public.accounts WHERE org_id = NEW.org_id AND id = NEW.subject_id)
     OR NOT EXISTS (SELECT 1 FROM public.accounts WHERE org_id = NEW.org_id AND id = (NEW.payload ->> 'targetAccountId')::uuid) THEN
    RAISE EXCEPTION 'An account merge proposal must bind its source account, surviving account, effective date and previewed consequences.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_merge_change_binding ON public.financial_changes;
CREATE TRIGGER account_merge_change_binding BEFORE INSERT OR UPDATE ON public.financial_changes
  FOR EACH ROW EXECUTE FUNCTION public.account_merge_change_binding();

-- ---------------------------------------------------------------------------
-- Accounting contexts and account localization
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.accounting_contexts (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  code text NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE (org_id, id),
  CONSTRAINT accounting_contexts_org_code UNIQUE (org_id, code)
);
COMMENT ON TABLE public.accounting_contexts IS 'Named presentation contexts (for example a local statutory chart) under which reports show localized account numbers and names.';

CREATE TABLE IF NOT EXISTS public.accounting_context_defaults (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  context_id uuid NOT NULL,
  subsidiary_id uuid,
  country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE (org_id, id),
  CONSTRAINT accounting_context_defaults_one_scope CHECK (num_nonnulls(subsidiary_id, country) = 1),
  CONSTRAINT accounting_context_defaults_context_fkey FOREIGN KEY (org_id, context_id)
    REFERENCES public.accounting_contexts(org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT accounting_context_defaults_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id)
    REFERENCES public.subsidiaries(org_id, id) DEFERRABLE
);
CREATE UNIQUE INDEX IF NOT EXISTS accounting_context_defaults_subsidiary
  ON public.accounting_context_defaults (org_id, subsidiary_id) WHERE subsidiary_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS accounting_context_defaults_country
  ON public.accounting_context_defaults (org_id, country) WHERE country IS NOT NULL;
COMMENT ON TABLE public.accounting_context_defaults IS 'The context a subsidiary, or every subsidiary of a country, reports under unless a report names another context.';

CREATE TABLE IF NOT EXISTS public.account_localizations (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  context_id uuid NOT NULL,
  account_id uuid NOT NULL,
  subsidiary_id uuid,
  localized_number text CHECK (localized_number IS NULL OR (localized_number = btrim(localized_number) AND length(localized_number) BETWEEN 1 AND 40)),
  localized_name text CHECK (localized_name IS NULL OR (length(btrim(localized_name)) BETWEEN 1 AND 200)),
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE (org_id, id),
  CONSTRAINT account_localizations_value CHECK (localized_number IS NOT NULL OR localized_name IS NOT NULL),
  CONSTRAINT account_localizations_window CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT account_localizations_context_fkey FOREIGN KEY (org_id, context_id)
    REFERENCES public.accounting_contexts(org_id, id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT account_localizations_account_fkey FOREIGN KEY (org_id, account_id)
    REFERENCES public.accounts(org_id, id) DEFERRABLE,
  CONSTRAINT account_localizations_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id)
    REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
  CONSTRAINT account_localizations_one_version EXCLUDE USING gist (
    org_id WITH =, context_id WITH =, account_id WITH =,
    (coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    daterange(effective_from, coalesce(effective_to + 1, 'infinity'::date), '[)') WITH &&
  ),
  CONSTRAINT account_localizations_unique_number EXCLUDE USING gist (
    org_id WITH =, context_id WITH =,
    (coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (lower(localized_number)) WITH =,
    daterange(effective_from, coalesce(effective_to + 1, 'infinity'::date), '[)') WITH &&
  ) WHERE (localized_number IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS account_localizations_account
  ON public.account_localizations (org_id, account_id, context_id);
COMMENT ON TABLE public.account_localizations IS 'Effective-dated localized account number and name per accounting context, optionally specific to one subsidiary.';

ALTER TABLE public.accounting_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_contexts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.accounting_contexts;
CREATE POLICY org_isolation ON public.accounting_contexts
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.accounting_contexts IS 'openbooks:org_isolation:v1';

ALTER TABLE public.accounting_context_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_context_defaults FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.accounting_context_defaults;
CREATE POLICY org_isolation ON public.accounting_context_defaults
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.accounting_context_defaults IS 'openbooks:org_isolation:v1';

ALTER TABLE public.account_localizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_localizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.account_localizations;
CREATE POLICY org_isolation ON public.account_localizations
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.account_localizations IS 'openbooks:org_isolation:v1';

INSERT INTO public.openbooks_query_catalog_relations(relation, added_in)
 VALUES ('account_merges', '0680_account_localization_and_merge'),
        ('accounting_contexts', '0680_account_localization_and_merge'),
        ('accounting_context_defaults', '0680_account_localization_and_merge'),
        ('account_localizations', '0680_account_localization_and_merge')
 ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
