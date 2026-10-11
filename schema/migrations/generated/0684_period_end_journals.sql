-- OpenBooks forward migration 0684_period_end_journals.
--
-- Period-end journals: an opt-in year-end close that posts explicit closing
-- entries for jurisdictions that require them.
--
-- period_end_journal_policies holds the effective-dated organization policy:
-- the retained earnings account, an optional income summary account, whether
-- balance-sheet closing and next-year opening journals are created, the
-- posting period (last regular period or the year's adjustment period) and
-- which dimensions the closing lines preserve. Versions are append-only; a
-- change is a new row with its own effective date, so a closed year keeps the
-- policy it was closed under.
--
-- period_end_journal_sets records one generation of a fiscal year's journals
-- per accounting book and legal entity, with the policy snapshot, a content
-- hash and the closed earnings. At most one generation is live (posted) per
-- book, entity, calendar and fiscal year. A generation is never deleted: it
-- only moves from posted to reversed, with the actor, time and reason, when
-- its journals are reversed through the posting kernel.
--
-- period_end_journal_entries links each generated journal entry (and later
-- its reversal) to its generation.
--
-- period_end_journal_seal() is the one definition of the year-end seal: while
-- a live generation exists, no journal may post into a period of that book
-- and entity ending on or before the closed year end, except the reversal of
-- the generation's own journals. The posting kernel refuses through the same
-- function by name, and the journal_entries trigger is the storage backstop.
--
-- Backfill: none. New tables, empty on arrival; the seal applies only once a
-- generation exists.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- ---------------------------------------------------------------------------
-- Effective-dated policy
-- ---------------------------------------------------------------------------

CREATE TABLE public.period_end_journal_policies (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  effective_from date NOT NULL,
  closing_method text NOT NULL,
  retained_earnings_account_id uuid NOT NULL,
  income_summary_account_id uuid,
  balance_sheet_journals boolean DEFAULT false NOT NULL,
  posting_period text DEFAULT 'last_period' NOT NULL,
  preserve_departments boolean DEFAULT false NOT NULL,
  preserve_classes boolean DEFAULT false NOT NULL,
  preserve_locations boolean DEFAULT false NOT NULL,
  preserve_projects boolean DEFAULT false NOT NULL,
  preserve_segments boolean DEFAULT false NOT NULL,
  reason text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT period_end_journal_policies_pkey PRIMARY KEY (id),
  CONSTRAINT period_end_journal_policies_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT period_end_journal_policies_effective_unique UNIQUE (org_id, effective_from),
  CONSTRAINT period_end_journal_policies_closing_method
    CHECK (closing_method IN ('retained_earnings', 'income_summary')),
  CONSTRAINT period_end_journal_policies_posting_period
    CHECK (posting_period IN ('last_period', 'adjustment_period')),
  CONSTRAINT period_end_journal_policies_income_summary
    CHECK ((closing_method = 'income_summary') = (income_summary_account_id IS NOT NULL)),
  CONSTRAINT period_end_journal_policies_distinct_accounts
    CHECK (income_summary_account_id IS DISTINCT FROM retained_earnings_account_id),
  CONSTRAINT period_end_journal_policies_reason
    CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT period_end_journal_policies_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT period_end_journal_policies_retained_earnings_fk
    FOREIGN KEY (org_id, retained_earnings_account_id)
    REFERENCES public.accounts(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT period_end_journal_policies_income_summary_fk
    FOREIGN KEY (org_id, income_summary_account_id)
    REFERENCES public.accounts(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT period_end_journal_policies_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT period_end_journal_policies_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE
);

COMMENT ON TABLE public.period_end_journal_policies IS
  'Effective-dated period-end journal policy. The row with the latest effective_from on or before a fiscal year end governs the journals generated for that year; versions are append-only.';

-- A policy version is retained exactly as entered, and its accounts must be
-- postable equity accounts of the organization when it is recorded.
CREATE FUNCTION public.period_end_journal_policy_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.migration', true), 'off') = 'on' THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.accounts a
       WHERE a.org_id = NEW.org_id AND a.id = NEW.retained_earnings_account_id
         AND a.type = 'equity' AND NOT a.is_summary AND a.is_active
    ) THEN
      RAISE EXCEPTION 'The retained earnings account of a period-end journal policy must be an active, postable equity account.'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.income_summary_account_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.accounts a
       WHERE a.org_id = NEW.org_id AND a.id = NEW.income_summary_account_id
         AND a.type = 'equity' AND NOT a.is_summary AND a.is_active
    ) THEN
      RAISE EXCEPTION 'The income summary account of a period-end journal policy must be an active, postable equity account.'
        USING ERRCODE = '23514';
    END IF;
    -- A new version cannot reach back into a year already closed by journal.
    IF EXISTS (
      SELECT 1 FROM public.period_end_journal_sets s
       WHERE s.org_id = NEW.org_id AND s.status = 'posted' AND s.year_ends_on >= NEW.effective_from
    ) THEN
      RAISE EXCEPTION 'A period-end journal policy cannot take effect on or before the end of a fiscal year closed by period-end journals; choose a later effective date.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Period-end journal policy history is preserved; record a new policy with its effective date in Setup → Accounting → Period-End Journals.'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER period_end_journal_policy_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.period_end_journal_policies
  FOR EACH ROW EXECUTE FUNCTION public.period_end_journal_policy_guard();

ALTER TABLE ONLY public.period_end_journal_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.period_end_journal_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.period_end_journal_policies
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.period_end_journal_policies IS 'openbooks:org_isolation:v1';

-- ---------------------------------------------------------------------------
-- Generations
-- ---------------------------------------------------------------------------

CREATE TABLE public.period_end_journal_sets (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  book_id uuid NOT NULL,
  subsidiary_id uuid NOT NULL,
  fiscal_calendar_id uuid NOT NULL,
  fiscal_year integer NOT NULL,
  year_starts_on date NOT NULL,
  year_ends_on date NOT NULL,
  closing_period_id uuid NOT NULL,
  opening_period_id uuid,
  generation integer NOT NULL,
  policy_id uuid NOT NULL,
  policy_snapshot jsonb NOT NULL,
  content_hash text NOT NULL,
  currency text NOT NULL,
  fiscal_year_earnings numeric(19,4) NOT NULL,
  prior_unclosed_earnings numeric(19,4) NOT NULL,
  status text DEFAULT 'posted' NOT NULL,
  reason text NOT NULL,
  generated_at timestamp with time zone DEFAULT now() NOT NULL,
  generated_by uuid,
  reversed_at timestamp with time zone,
  reversed_by uuid,
  reversal_reason text,
  reopen_request_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT period_end_journal_sets_pkey PRIMARY KEY (id),
  CONSTRAINT period_end_journal_sets_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT period_end_journal_sets_generation_unique
    UNIQUE (org_id, book_id, subsidiary_id, fiscal_calendar_id, fiscal_year, generation),
  CONSTRAINT period_end_journal_sets_status CHECK (status IN ('posted', 'reversed')),
  CONSTRAINT period_end_journal_sets_generation CHECK (generation >= 1),
  CONSTRAINT period_end_journal_sets_year CHECK (year_starts_on <= year_ends_on),
  CONSTRAINT period_end_journal_sets_content_hash CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT period_end_journal_sets_snapshot CHECK (jsonb_typeof(policy_snapshot) = 'object'),
  CONSTRAINT period_end_journal_sets_reason CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT period_end_journal_sets_reversal CHECK (
    (status = 'posted' AND reversed_at IS NULL AND reversed_by IS NULL AND reversal_reason IS NULL AND reopen_request_id IS NULL)
    OR (status = 'reversed' AND reversed_at IS NOT NULL AND length(btrim(coalesce(reversal_reason, ''))) BETWEEN 1 AND 2000)
  ),
  CONSTRAINT period_end_journal_sets_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT period_end_journal_sets_book_fk
    FOREIGN KEY (org_id, book_id) REFERENCES public.accounting_books(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT period_end_journal_sets_subsidiary_fk
    FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT period_end_journal_sets_closing_period_fk
    FOREIGN KEY (org_id, closing_period_id) REFERENCES public.accounting_periods(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT period_end_journal_sets_opening_period_fk
    FOREIGN KEY (org_id, opening_period_id) REFERENCES public.accounting_periods(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT period_end_journal_sets_policy_fk
    FOREIGN KEY (org_id, policy_id) REFERENCES public.period_end_journal_policies(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT period_end_journal_sets_generated_by_fk
    FOREIGN KEY (generated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT period_end_journal_sets_reversed_by_fk
    FOREIGN KEY (reversed_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT period_end_journal_sets_created_by_fk
    FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE,
  CONSTRAINT period_end_journal_sets_updated_by_fk
    FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL DEFERRABLE
);

-- One live generation per book, legal entity, calendar and fiscal year: the
-- arbiter of idempotent generation under concurrency.
CREATE UNIQUE INDEX period_end_journal_sets_live
  ON public.period_end_journal_sets (org_id, book_id, subsidiary_id, fiscal_calendar_id, fiscal_year)
  WHERE status = 'posted';
-- The seal probe: live generations of one book ordered by the year they close.
CREATE INDEX period_end_journal_sets_seal
  ON public.period_end_journal_sets (org_id, book_id, year_ends_on)
  WHERE status = 'posted';
CREATE INDEX period_end_journal_sets_history
  ON public.period_end_journal_sets (org_id, fiscal_year, generated_at DESC);

COMMENT ON TABLE public.period_end_journal_sets IS
  'One generation of a fiscal year''s period-end journals for one accounting book and legal entity. Posted generations seal the ledger through year_ends_on; a generation only moves to reversed, never deleted.';

-- A generation is identified by its closing period, which must be a period of
-- the stated calendar and fiscal year ending on the year end. Afterwards the
-- only change is the one-way posted → reversed transition with its evidence.
CREATE FUNCTION public.period_end_journal_set_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Period-end journal generations are retained history; reverse the generation instead.'
      USING ERRCODE = '23514';
  END IF;
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.migration', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'posted' THEN
      RAISE EXCEPTION 'A period-end journal generation is recorded as posted.' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.accounting_periods p
       WHERE p.org_id = NEW.org_id AND p.id = NEW.closing_period_id
         AND p.fiscal_calendar_id = NEW.fiscal_calendar_id AND p.fiscal_year = NEW.fiscal_year
         AND p.ends_on = NEW.year_ends_on
    ) THEN
      RAISE EXCEPTION 'The closing period of a period-end journal generation must be a period of its fiscal year ending on the year end.'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.opening_period_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.accounting_periods p
       WHERE p.org_id = NEW.org_id AND p.id = NEW.opening_period_id
         AND p.fiscal_calendar_id = NEW.fiscal_calendar_id AND p.starts_on > NEW.year_ends_on
         AND NOT p.is_adjustment
    ) THEN
      RAISE EXCEPTION 'The opening period of a period-end journal generation must be a regular period after the closed year.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'posted' AND NEW.status = 'reversed'
     AND NEW.id = OLD.id AND NEW.org_id = OLD.org_id AND NEW.book_id = OLD.book_id
     AND NEW.subsidiary_id = OLD.subsidiary_id AND NEW.fiscal_calendar_id = OLD.fiscal_calendar_id
     AND NEW.fiscal_year = OLD.fiscal_year AND NEW.year_starts_on = OLD.year_starts_on
     AND NEW.year_ends_on = OLD.year_ends_on AND NEW.closing_period_id = OLD.closing_period_id
     AND NEW.opening_period_id IS NOT DISTINCT FROM OLD.opening_period_id
     AND NEW.generation = OLD.generation AND NEW.policy_id = OLD.policy_id
     AND NEW.policy_snapshot = OLD.policy_snapshot AND NEW.content_hash = OLD.content_hash
     AND NEW.currency = OLD.currency AND NEW.fiscal_year_earnings = OLD.fiscal_year_earnings
     AND NEW.prior_unclosed_earnings = OLD.prior_unclosed_earnings AND NEW.reason = OLD.reason
     AND NEW.generated_at = OLD.generated_at AND NEW.generated_by IS NOT DISTINCT FROM OLD.generated_by
     AND NEW.created_at = OLD.created_at AND NEW.created_by IS NOT DISTINCT FROM OLD.created_by
     AND (NEW.reopen_request_id IS NULL OR EXISTS (
       SELECT 1 FROM public.close_reopen_requests r WHERE r.org_id = NEW.org_id AND r.id = NEW.reopen_request_id
     ))
     AND NOT EXISTS (
       SELECT 1 FROM public.period_end_journal_entries pe
        WHERE pe.org_id = NEW.org_id AND pe.set_id = NEW.id AND pe.reversal_entry_id IS NULL
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A period-end journal generation changes only from posted to reversed, after every journal in it has been reversed, with the reversal evidence.'
    USING ERRCODE = '23514';
END;
$$;

ALTER TABLE ONLY public.period_end_journal_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.period_end_journal_sets FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.period_end_journal_sets
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.period_end_journal_sets IS 'openbooks:org_isolation:v1';

-- ---------------------------------------------------------------------------
-- Journals of a generation
-- ---------------------------------------------------------------------------

CREATE TABLE public.period_end_journal_entries (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  set_id uuid NOT NULL,
  kind text NOT NULL,
  entry_id uuid NOT NULL,
  reversal_entry_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT period_end_journal_entries_pkey PRIMARY KEY (id),
  CONSTRAINT period_end_journal_entries_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT period_end_journal_entries_kind_unique UNIQUE (org_id, set_id, kind),
  CONSTRAINT period_end_journal_entries_entry_unique UNIQUE (org_id, entry_id),
  CONSTRAINT period_end_journal_entries_kind
    CHECK (kind IN ('income_statement', 'income_summary', 'balance_sheet', 'opening')),
  CONSTRAINT period_end_journal_entries_reversal_distinct CHECK (reversal_entry_id IS DISTINCT FROM entry_id),
  CONSTRAINT period_end_journal_entries_org_fk
    FOREIGN KEY (org_id) REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE,
  CONSTRAINT period_end_journal_entries_set_fk
    FOREIGN KEY (org_id, set_id) REFERENCES public.period_end_journal_sets(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT period_end_journal_entries_entry_fk
    FOREIGN KEY (org_id, entry_id) REFERENCES public.journal_entries(org_id, id) ON DELETE RESTRICT DEFERRABLE,
  CONSTRAINT period_end_journal_entries_reversal_fk
    FOREIGN KEY (org_id, reversal_entry_id) REFERENCES public.journal_entries(org_id, id) ON DELETE RESTRICT DEFERRABLE
);

CREATE UNIQUE INDEX period_end_journal_entries_reversal_unique
  ON public.period_end_journal_entries (org_id, reversal_entry_id)
  WHERE reversal_entry_id IS NOT NULL;

COMMENT ON TABLE public.period_end_journal_entries IS
  'The journal entries of a period-end journal generation by kind, each linked to its reversal once reversed.';

-- A generation's journal is a posted entry of the same book and legal entity
-- with the period-end origin of its kind. The only later change is linking
-- the posted reversal that cancels it.
CREATE FUNCTION public.period_end_journal_entry_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  v_set record;
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Period-end journal links are retained history.' USING ERRCODE = '23514';
  END IF;
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.migration', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT s.book_id, s.subsidiary_id, s.status INTO v_set
      FROM public.period_end_journal_sets s
     WHERE s.org_id = NEW.org_id AND s.id = NEW.set_id;
    IF NOT FOUND OR v_set.status <> 'posted' OR NEW.reversal_entry_id IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM public.journal_entries e
       WHERE e.org_id = NEW.org_id AND e.id = NEW.entry_id AND e.status = 'posted'
         AND e.book_id = v_set.book_id AND e.subsidiary_id = v_set.subsidiary_id
         AND e.reverses_entry_id IS NULL
         AND e.origin = CASE WHEN NEW.kind = 'opening' THEN 'opening' ELSE 'closing' END
    ) THEN
      RAISE EXCEPTION 'A period-end journal link names a posted period-end entry of its live generation''s book and legal entity.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.reversal_entry_id IS NULL AND NEW.reversal_entry_id IS NOT NULL
     AND NEW.id = OLD.id AND NEW.org_id = OLD.org_id AND NEW.set_id = OLD.set_id
     AND NEW.kind = OLD.kind AND NEW.entry_id = OLD.entry_id AND NEW.created_at = OLD.created_at
     AND EXISTS (
       SELECT 1 FROM public.journal_entries r
        WHERE r.org_id = NEW.org_id AND r.id = NEW.reversal_entry_id
          AND r.status = 'posted' AND r.reverses_entry_id = NEW.entry_id
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A period-end journal link changes only once, to name the posted reversal of its entry.'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER period_end_journal_entry_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.period_end_journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.period_end_journal_entry_guard();

-- The set guard reads the entries table, so it is attached once both exist.
CREATE TRIGGER period_end_journal_set_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.period_end_journal_sets
  FOR EACH ROW EXECUTE FUNCTION public.period_end_journal_set_guard();

ALTER TABLE ONLY public.period_end_journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.period_end_journal_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.period_end_journal_entries
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.period_end_journal_entries IS 'openbooks:org_isolation:v1';

-- ---------------------------------------------------------------------------
-- The year-end seal
-- ---------------------------------------------------------------------------

-- The live generation that seals a posting into p_period for any of the
-- given legal entities (all entities when p_subsidiaries is null or empty),
-- or no row. A reversal of one of a generation's own journals is not sealed
-- by that generation; a later live generation still seals it.
CREATE FUNCTION public.period_end_journal_seal(
  p_org uuid, p_book uuid, p_period uuid, p_subsidiaries uuid[], p_reverses uuid
) RETURNS TABLE (
  set_id uuid, subsidiary_id uuid, fiscal_year integer, year_ends_on date, closing_period_id uuid
)
  LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
  SELECT s.id, s.subsidiary_id, s.fiscal_year, s.year_ends_on, s.closing_period_id
    FROM public.period_end_journal_sets s
    JOIN public.accounting_periods p ON p.org_id = s.org_id AND p.id = p_period
   WHERE s.org_id = p_org AND s.book_id = p_book AND s.status = 'posted'
     AND p.ends_on <= s.year_ends_on
     AND (coalesce(cardinality(p_subsidiaries), 0) = 0 OR s.subsidiary_id = ANY (p_subsidiaries))
     AND NOT EXISTS (
       SELECT 1 FROM public.period_end_journal_entries pe
        WHERE pe.org_id = s.org_id AND pe.set_id = s.id AND pe.entry_id = p_reverses
     )
   ORDER BY s.year_ends_on DESC, s.subsidiary_id
   LIMIT 1
$$;

COMMENT ON FUNCTION public.period_end_journal_seal(uuid, uuid, uuid, uuid[], uuid) IS
  'The single definition of the year-end seal used by the posting kernel and the journal_entries storage guard.';

-- Storage backstop: a journal becoming posted (a posted insert or the
-- draft → posted flip) into a sealed period is refused. Trusted maintenance
-- copies (sandbox clone, restore) carry their source history verbatim.
CREATE FUNCTION public.period_end_journal_posting_fence() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  v_subsidiaries uuid[];
  v_seal record;
BEGIN
  IF NEW.status <> 'posted' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'draft' THEN
    RETURN NEW;
  END IF;
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.migration', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.period_end_journal_sets s
     WHERE s.org_id = NEW.org_id AND s.book_id = NEW.book_id AND s.status = 'posted'
  ) THEN
    RETURN NEW;
  END IF;
  SELECT array_agg(DISTINCT l.subsidiary_id) INTO v_subsidiaries
    FROM public.journal_lines l
   WHERE l.org_id = NEW.org_id AND l.entry_id = NEW.id;
  v_subsidiaries := array_append(coalesce(v_subsidiaries, ARRAY[]::uuid[]), NEW.subsidiary_id);
  SELECT * INTO v_seal
    FROM public.period_end_journal_seal(NEW.org_id, NEW.book_id, NEW.period_id, v_subsidiaries, NEW.reverses_entry_id);
  IF FOUND THEN
    RAISE EXCEPTION 'Fiscal year % of this accounting book is closed by its period-end journals; request a controlled reopen of the year-end period, which reverses them, before posting into it.', v_seal.fiscal_year
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER period_end_journal_posting_fence
  BEFORE INSERT OR UPDATE OF status ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.period_end_journal_posting_fence();

-- ---------------------------------------------------------------------------
-- Tenant retirement fences and the governed query catalog
-- ---------------------------------------------------------------------------

DO $fences$
DECLARE target record;
BEGIN
 FOR target IN SELECT * FROM (VALUES
('period_end_journal_policies'),
('period_end_journal_sets'),
('period_end_journal_entries')
 ) AS expected(table_name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=target.table_name AND t.tgname='tenant_retirement_fence') THEN
   EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()',target.table_name);
  END IF;
 END LOOP;
END $fences$;

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in) VALUES
  ('period_end_journal_policies', '0684_period_end_journals'),
  ('period_end_journal_sets', '0684_period_end_journals'),
  ('period_end_journal_entries', '0684_period_end_journals')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
