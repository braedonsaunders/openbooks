-- OpenBooks forward migration 0682_accounting_book_currency_and_account_maps.
--
-- Multi-book accounting configuration and evidence.
--
-- * accounting_books gains its replication mode (adjustment-only or full),
--   the date full replication starts from, and the account that receives
--   currency differences when a book translates into its own currency.
--   These settings change only in the transaction that records an
--   accounting_book_replication_runs row, so every change carries an actor
--   and a reason; the start date is fixed once set.
-- * accounting_book_currencies gives a secondary book its own base currency
--   and rate type for one subsidiary over an effective-dated window. A
--   window never changes under entries the book already holds for that
--   subsidiary, and one book keeps one currency per subsidiary.
-- * accounting_book_account_maps carry a primary chart account as another
--   account in one book (optionally for one subsidiary), effective-dated.
--   A mapping never changes under book entries it governed.
-- * book_entry_replications link every primary entry a full book received
--   to the book entry that carries it (or record why nothing was carried).
--   One row per book and source entry makes replication exactly-once.
-- * accounting_book_replication_runs record each activation, catch-up,
--   deactivation and settings change with its basis and reason.
-- * accounting_book_currency(org, book, subsidiary) answers the currency a
--   book carries a subsidiary in, for statements and checks.
--
-- Backfill: none. Existing books default to adjustment-only with no
-- currency or account configuration, which is their current behaviour.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- ---------------------------------------------------------------------------
-- Replication settings on the book
-- ---------------------------------------------------------------------------

ALTER TABLE public.accounting_books
  ADD COLUMN IF NOT EXISTS replication_mode text NOT NULL DEFAULT 'adjustment_only',
  ADD COLUMN IF NOT EXISTS replication_from date,
  ADD COLUMN IF NOT EXISTS currency_difference_account_id uuid;

ALTER TABLE public.accounting_books
  ADD CONSTRAINT accounting_books_replication_mode_check
    CHECK (replication_mode IN ('adjustment_only', 'full')),
  ADD CONSTRAINT accounting_books_full_replication_start
    CHECK (replication_mode = 'adjustment_only' OR replication_from IS NOT NULL),
  ADD CONSTRAINT accounting_books_primary_is_source
    CHECK (NOT is_primary OR replication_mode = 'adjustment_only'),
  ADD CONSTRAINT accounting_books_currency_difference_account_fk
    FOREIGN KEY (org_id, currency_difference_account_id) REFERENCES public.accounts(org_id, id);

COMMENT ON COLUMN public.accounting_books.replication_mode IS
  'adjustment_only: the book receives only book-specific and generated entries. full: every replicable primary-book posting dated on or after replication_from is replicated into the book.';
COMMENT ON COLUMN public.accounting_books.replication_from IS
  'First posting date full replication covers. Fixed once set; earlier history enters through the activation''s opening strategy.';
COMMENT ON COLUMN public.accounting_books.currency_difference_account_id IS
  'Receives currency differences that remain when a mixed-currency posting translates into the book currency, and opening-balance differences on activation.';

-- ---------------------------------------------------------------------------
-- Replication runs (append-only governance evidence)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.accounting_book_replication_runs (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 book_id uuid NOT NULL,
 kind text NOT NULL,
 mode_before text NOT NULL,
 mode_after text NOT NULL,
 replication_from date,
 opening_strategy text,
 opening_entry_ids uuid[] NOT NULL DEFAULT '{}',
 replicated_count integer NOT NULL DEFAULT 0,
 excluded_count integer NOT NULL DEFAULT 0,
 settings jsonb NOT NULL DEFAULT '{}'::jsonb,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 created_txid bigint NOT NULL DEFAULT txid_current(),
 UNIQUE (org_id, id),
 CONSTRAINT accounting_book_replication_runs_book_fk
   FOREIGN KEY (org_id, book_id) REFERENCES public.accounting_books(org_id, id),
 CONSTRAINT accounting_book_replication_runs_kind_check
   CHECK (kind IN ('activation', 'catch_up', 'deactivation', 'settings')),
 CONSTRAINT accounting_book_replication_runs_modes_check
   CHECK (mode_before IN ('adjustment_only', 'full') AND mode_after IN ('adjustment_only', 'full')),
 CONSTRAINT accounting_book_replication_runs_strategy_check
   CHECK (opening_strategy IS NULL OR opening_strategy IN ('full_history', 'opening_balances')),
 CONSTRAINT accounting_book_replication_runs_activation_basis
   CHECK (kind <> 'activation' OR (replication_from IS NOT NULL AND opening_strategy IS NOT NULL AND mode_after = 'full')),
 CONSTRAINT accounting_book_replication_runs_counts_check
   CHECK (replicated_count >= 0 AND excluded_count >= 0),
 CONSTRAINT accounting_book_replication_runs_settings_object
   CHECK (jsonb_typeof(settings) = 'object'),
 CONSTRAINT accounting_book_replication_runs_reason_text
   CHECK (length(btrim(reason)) BETWEEN 8 AND 500)
);
CREATE INDEX IF NOT EXISTS accounting_book_replication_runs_book
  ON public.accounting_book_replication_runs USING btree (org_id, book_id, created_at DESC);
COMMENT ON TABLE public.accounting_book_replication_runs IS
  'Append-only record of each multi-book replication activation, catch-up, deactivation and settings change, with its basis and reason.';

-- Settings change only alongside a run recorded in the same transaction.
CREATE OR REPLACE FUNCTION public.accounting_book_replication_settings_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF coalesce(current_setting('openbooks.migration', true), 'off') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.replication_mode IS NOT DISTINCT FROM OLD.replication_mode
     AND NEW.replication_from IS NOT DISTINCT FROM OLD.replication_from
     AND NEW.currency_difference_account_id IS NOT DISTINCT FROM OLD.currency_difference_account_id THEN
    RETURN NEW;
  END IF;
  IF OLD.replication_from IS NOT NULL AND NEW.replication_from IS DISTINCT FROM OLD.replication_from THEN
    RAISE EXCEPTION 'The replication start date of book % is fixed once set; catch up from it instead', OLD.code
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.accounting_book_replication_runs run
     WHERE run.org_id = NEW.org_id AND run.book_id = NEW.id AND run.created_txid = txid_current()
  ) THEN
    RAISE EXCEPTION 'Replication settings of book % change only through a recorded replication change with a reason', OLD.code
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS accounting_book_replication_settings_guard ON public.accounting_books;
CREATE TRIGGER accounting_book_replication_settings_guard
  BEFORE UPDATE OF replication_mode, replication_from, currency_difference_account_id ON public.accounting_books
  FOR EACH ROW EXECUTE FUNCTION public.accounting_book_replication_settings_guard();

-- ---------------------------------------------------------------------------
-- Book base currency per subsidiary
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.accounting_book_currencies (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 book_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL,
 currency text NOT NULL REFERENCES public.currencies(code),
 rate_type text NOT NULL,
 effective_from date NOT NULL,
 effective_to date,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id, id),
 CONSTRAINT accounting_book_currencies_book_fk
   FOREIGN KEY (org_id, book_id) REFERENCES public.accounting_books(org_id, id),
 CONSTRAINT accounting_book_currencies_subsidiary_fk
   FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT accounting_book_currencies_code_check CHECK (currency ~ '^[A-Z]{3}$'),
 CONSTRAINT accounting_book_currencies_rate_type_check CHECK (rate_type IN ('spot', 'month_average')),
 CONSTRAINT accounting_book_currencies_window_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
 CONSTRAINT accounting_book_currencies_reason_text CHECK (length(btrim(reason)) BETWEEN 8 AND 500),
 CONSTRAINT accounting_book_currencies_no_overlap EXCLUDE USING gist (
   org_id WITH =, book_id WITH =, subsidiary_id WITH =,
   daterange(effective_from, effective_to, '[]') WITH &&)
);
COMMENT ON TABLE public.accounting_book_currencies IS
  'Effective-dated base currency and translation rate type of a secondary accounting book for one subsidiary. Without a row the book carries the subsidiary in its functional currency.';

-- Lines a book already holds for one subsidiary in a date window.
CREATE OR REPLACE FUNCTION public.accounting_book_has_lines(
  p_org uuid, p_book uuid, p_subsidiary uuid, p_account uuid, p_from date, p_to date
) RETURNS boolean
 LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.journal_lines l
      JOIN public.journal_entries e ON e.id = l.entry_id AND e.org_id = l.org_id
     WHERE l.org_id = p_org AND e.book_id = p_book
       AND (p_subsidiary IS NULL OR l.subsidiary_id = p_subsidiary)
       AND (p_account IS NULL OR l.account_id = p_account)
       AND (p_from IS NULL OR e.posting_date >= p_from)
       AND (p_to IS NULL OR e.posting_date <= p_to)
  )
$$;

CREATE OR REPLACE FUNCTION public.accounting_book_currency_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
DECLARE
  established text;
  base text;
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  IF coalesce(current_setting('openbooks.migration', true), 'off') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF public.accounting_book_has_lines(OLD.org_id, OLD.book_id, OLD.subsidiary_id, NULL, OLD.effective_from, OLD.effective_to) THEN
      RAISE EXCEPTION 'This book currency governs entries the book already holds; close its window after them instead'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_books b WHERE b.org_id = NEW.org_id AND b.id = NEW.book_id AND b.is_primary) THEN
    RAISE EXCEPTION 'The primary book carries every subsidiary in its functional currency'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.book_id IS DISTINCT FROM OLD.book_id
       OR NEW.subsidiary_id IS DISTINCT FROM OLD.subsidiary_id OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.rate_type IS DISTINCT FROM OLD.rate_type OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.reason IS DISTINCT FROM OLD.reason THEN
      RAISE EXCEPTION 'A book currency version keeps its currency, rate type and start date; add a new version from a later date instead'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.effective_to IS NOT NULL AND (OLD.effective_to IS NULL OR NEW.effective_to < OLD.effective_to)
       AND public.accounting_book_has_lines(OLD.org_id, OLD.book_id, OLD.subsidiary_id, NULL, NEW.effective_to + 1, OLD.effective_to) THEN
      RAISE EXCEPTION 'The book already holds entries for this subsidiary after %; end the window on or after its latest entry', NEW.effective_to
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT c.currency INTO established
    FROM public.accounting_book_currencies c
   WHERE c.org_id = NEW.org_id AND c.book_id = NEW.book_id AND c.subsidiary_id = NEW.subsidiary_id
   LIMIT 1;
  IF established IS NOT NULL AND established <> NEW.currency THEN
    RAISE EXCEPTION 'This book carries the subsidiary in %; a book keeps one currency per subsidiary', established
      USING ERRCODE = '23514';
  END IF;
  IF established IS NULL THEN
    SELECT s.base_currency INTO base FROM public.subsidiaries s WHERE s.org_id = NEW.org_id AND s.id = NEW.subsidiary_id;
    IF NEW.currency <> base AND public.accounting_book_has_lines(NEW.org_id, NEW.book_id, NEW.subsidiary_id, NULL, NULL, NULL) THEN
      RAISE EXCEPTION 'The book already holds % entries for this subsidiary; a different book currency needs a new book', base
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF public.accounting_book_has_lines(NEW.org_id, NEW.book_id, NEW.subsidiary_id, NULL, NEW.effective_from, NEW.effective_to) THEN
    RAISE EXCEPTION 'The book already holds entries for this subsidiary on or after %; start the version after its latest entry', NEW.effective_from
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS accounting_book_currency_guard ON public.accounting_book_currencies;
CREATE TRIGGER accounting_book_currency_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_book_currencies
  FOR EACH ROW EXECUTE FUNCTION public.accounting_book_currency_guard();

-- The currency a book carries a subsidiary in: its configured currency, or
-- the subsidiary's functional currency when the book has no configuration.
CREATE OR REPLACE FUNCTION public.accounting_book_currency(p_org uuid, p_book uuid, p_subsidiary uuid) RETURNS text
 LANGUAGE sql STABLE SET search_path = public, pg_catalog AS $$
  SELECT coalesce(
    (SELECT c.currency FROM public.accounting_book_currencies c
      WHERE c.org_id = p_org AND c.book_id = p_book AND c.subsidiary_id = p_subsidiary LIMIT 1),
    (SELECT s.base_currency FROM public.subsidiaries s WHERE s.org_id = p_org AND s.id = p_subsidiary))
$$;

-- ---------------------------------------------------------------------------
-- Book account mappings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.accounting_book_account_maps (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 book_id uuid NOT NULL,
 subsidiary_id uuid,
 source_account_id uuid NOT NULL,
 target_account_id uuid NOT NULL,
 effective_from date NOT NULL,
 effective_to date,
 reason text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id, id),
 CONSTRAINT accounting_book_account_maps_book_fk
   FOREIGN KEY (org_id, book_id) REFERENCES public.accounting_books(org_id, id),
 CONSTRAINT accounting_book_account_maps_subsidiary_fk
   FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT accounting_book_account_maps_source_fk
   FOREIGN KEY (org_id, source_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT accounting_book_account_maps_target_fk
   FOREIGN KEY (org_id, target_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT accounting_book_account_maps_distinct CHECK (source_account_id <> target_account_id),
 CONSTRAINT accounting_book_account_maps_window_check CHECK (effective_to IS NULL OR effective_to >= effective_from),
 CONSTRAINT accounting_book_account_maps_reason_text CHECK (length(btrim(reason)) BETWEEN 8 AND 500),
 CONSTRAINT accounting_book_account_maps_no_overlap EXCLUDE USING gist (
   org_id WITH =, book_id WITH =,
   (coalesce(subsidiary_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
   source_account_id WITH =,
   daterange(effective_from, effective_to, '[]') WITH &&)
);
CREATE INDEX IF NOT EXISTS accounting_book_account_maps_lookup
  ON public.accounting_book_account_maps USING btree (org_id, book_id, source_account_id, effective_from);
COMMENT ON TABLE public.accounting_book_account_maps IS
  'Effective-dated mapping of a chart account to the account one secondary book carries it in, optionally for one subsidiary. A subsidiary mapping wins over an organization-wide one.';

CREATE OR REPLACE FUNCTION public.accounting_book_account_map_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  IF coalesce(current_setting('openbooks.migration', true), 'off') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF public.accounting_book_has_lines(OLD.org_id, OLD.book_id, OLD.subsidiary_id, OLD.target_account_id, OLD.effective_from, OLD.effective_to)
       OR public.accounting_book_has_lines(OLD.org_id, OLD.book_id, OLD.subsidiary_id, OLD.source_account_id, OLD.effective_from, OLD.effective_to) THEN
      RAISE EXCEPTION 'This account mapping governs entries the book already holds; close its window after them instead'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM public.accounting_books b WHERE b.org_id = NEW.org_id AND b.id = NEW.book_id AND b.is_primary) THEN
    RAISE EXCEPTION 'The primary book is the chart of record; map accounts in a secondary book'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.book_id IS DISTINCT FROM OLD.book_id
       OR NEW.subsidiary_id IS DISTINCT FROM OLD.subsidiary_id OR NEW.source_account_id IS DISTINCT FROM OLD.source_account_id
       OR NEW.target_account_id IS DISTINCT FROM OLD.target_account_id OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.reason IS DISTINCT FROM OLD.reason THEN
      RAISE EXCEPTION 'An account mapping keeps its accounts, scope and start date; add a new mapping from a later date instead'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.effective_to IS NOT NULL AND (OLD.effective_to IS NULL OR NEW.effective_to < OLD.effective_to)
       AND (public.accounting_book_has_lines(OLD.org_id, OLD.book_id, OLD.subsidiary_id, OLD.target_account_id, NEW.effective_to + 1, OLD.effective_to)
            OR public.accounting_book_has_lines(OLD.org_id, OLD.book_id, OLD.subsidiary_id, OLD.source_account_id, NEW.effective_to + 1, OLD.effective_to)) THEN
      RAISE EXCEPTION 'The book already holds entries this mapping governed after %; end the window on or after its latest entry', NEW.effective_to
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF public.accounting_book_has_lines(NEW.org_id, NEW.book_id, NEW.subsidiary_id, NEW.source_account_id, NEW.effective_from, NEW.effective_to) THEN
    RAISE EXCEPTION 'The book already holds entries on the source account on or after %; start the mapping after its latest entry', NEW.effective_from
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS accounting_book_account_map_guard ON public.accounting_book_account_maps;
CREATE TRIGGER accounting_book_account_map_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_book_account_maps
  FOR EACH ROW EXECUTE FUNCTION public.accounting_book_account_map_guard();

-- ---------------------------------------------------------------------------
-- Replication evidence (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.book_entry_replications (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 book_id uuid NOT NULL,
 source_entry_id uuid NOT NULL,
 replica_entry_id uuid,
 outcome text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}'::jsonb,
 run_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 UNIQUE (org_id, id),
 CONSTRAINT book_entry_replications_book_fk
   FOREIGN KEY (org_id, book_id) REFERENCES public.accounting_books(org_id, id),
 CONSTRAINT book_entry_replications_source_fk
   FOREIGN KEY (org_id, source_entry_id) REFERENCES public.journal_entries(org_id, id),
 CONSTRAINT book_entry_replications_replica_fk
   FOREIGN KEY (org_id, replica_entry_id) REFERENCES public.journal_entries(org_id, id),
 CONSTRAINT book_entry_replications_run_fk
   FOREIGN KEY (org_id, run_id) REFERENCES public.accounting_book_replication_runs(org_id, id),
 CONSTRAINT book_entry_replications_outcome_check CHECK (outcome IN ('replicated', 'excluded')),
 CONSTRAINT book_entry_replications_outcome_replica CHECK ((outcome = 'replicated') = (replica_entry_id IS NOT NULL)),
 CONSTRAINT book_entry_replications_detail_object CHECK (jsonb_typeof(detail) = 'object')
);
CREATE UNIQUE INDEX IF NOT EXISTS book_entry_replications_once
  ON public.book_entry_replications USING btree (org_id, book_id, source_entry_id);
CREATE UNIQUE INDEX IF NOT EXISTS book_entry_replications_replica
  ON public.book_entry_replications USING btree (org_id, replica_entry_id) WHERE replica_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS book_entry_replications_source
  ON public.book_entry_replications USING btree (org_id, source_entry_id);
COMMENT ON TABLE public.book_entry_replications IS
  'One row per full book and replicated primary entry: the book entry that carries it, or why nothing was carried. Rows are never changed; corrections replicate as their own entries.';

CREATE OR REPLACE FUNCTION public.multibook_evidence_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Multi-book replication evidence is append-only history'
    USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS book_entry_replications_immutable ON public.book_entry_replications;
CREATE TRIGGER book_entry_replications_immutable BEFORE UPDATE OR DELETE ON public.book_entry_replications
  FOR EACH ROW EXECUTE FUNCTION public.multibook_evidence_immutable();
-- A run records its outcome (counts and opening entries) in the transaction
-- that performs it; once that transaction commits the row is sealed.
CREATE OR REPLACE FUNCTION public.accounting_book_replication_run_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.created_txid = txid_current() THEN
    IF (to_jsonb(NEW) - 'replicated_count' - 'excluded_count' - 'opening_entry_ids')
       = (to_jsonb(OLD) - 'replicated_count' - 'excluded_count' - 'opening_entry_ids') THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Multi-book replication runs are append-only history'
    USING ERRCODE = '23514';
END;
$$;
DROP TRIGGER IF EXISTS accounting_book_replication_runs_immutable ON public.accounting_book_replication_runs;
CREATE TRIGGER accounting_book_replication_runs_immutable BEFORE UPDATE OR DELETE ON public.accounting_book_replication_runs
  FOR EACH ROW EXECUTE FUNCTION public.accounting_book_replication_run_immutable();

-- ---------------------------------------------------------------------------
-- Tenant isolation
-- ---------------------------------------------------------------------------

ALTER TABLE public.accounting_book_currencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_book_currencies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.accounting_book_currencies;
CREATE POLICY org_isolation ON public.accounting_book_currencies
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.accounting_book_currencies IS 'openbooks:org_isolation:v1';

ALTER TABLE public.accounting_book_account_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_book_account_maps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.accounting_book_account_maps;
CREATE POLICY org_isolation ON public.accounting_book_account_maps
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.accounting_book_account_maps IS 'openbooks:org_isolation:v1';

ALTER TABLE public.book_entry_replications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.book_entry_replications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.book_entry_replications;
CREATE POLICY org_isolation ON public.book_entry_replications
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.book_entry_replications IS 'openbooks:org_isolation:v1';

ALTER TABLE public.accounting_book_replication_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_book_replication_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.accounting_book_replication_runs;
CREATE POLICY org_isolation ON public.accounting_book_replication_runs
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.accounting_book_replication_runs IS 'openbooks:org_isolation:v1';

-- The tenant retirement fence only reaches tables present when 0626 ran:
-- attach it to each new table, create-if-absent (the 0643 late-tables shape).
DO $fences$
DECLARE target record;
BEGIN
 FOR target IN SELECT * FROM (VALUES
('accounting_book_currencies'),
('accounting_book_account_maps'),
('book_entry_replications'),
('accounting_book_replication_runs')
 ) AS expected(table_name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=target.table_name AND t.tgname='tenant_retirement_fence') THEN
   EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()',target.table_name);
  END IF;
 END LOOP;
END $fences$;

-- ---------------------------------------------------------------------------
-- Governed query catalog
-- ---------------------------------------------------------------------------

INSERT INTO public.openbooks_query_catalog_relations(relation, added_in)
 VALUES ('accounting_book_currencies', '0682_accounting_book_currency_and_account_maps'),
        ('accounting_book_account_maps', '0682_accounting_book_currency_and_account_maps'),
        ('book_entry_replications', '0682_accounting_book_currency_and_account_maps'),
        ('accounting_book_replication_runs', '0682_accounting_book_currency_and_account_maps')
 ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
