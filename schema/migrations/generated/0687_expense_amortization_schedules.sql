-- OpenBooks forward migration 0687_expense_amortization_schedules.
--
-- Prepaid and deferred expenses amortize through schedules. Effective-dated
-- amortization templates state the method, the term, the deferral account
-- and the default destination account; a template version that a schedule
-- or a posted line uses keeps its policy fixed, so a later change is a new
-- effective-dated version and never reinterprets history.
--
-- Vendor bill, journal and expense report lines name a template and an
-- optional service window. A schedule records the deferred amount, its
-- dimensions and one planned line per monthly period; amortization posts
-- each due line exactly once and links the journal entry. Posted and
-- superseded lines and the schedule event history are immutable; a
-- schedule changes only through recorded events with a reason, and a
-- completed or cancelled schedule is final.
--
-- The scheduler admits one periodic scan kind for automatic amortization;
-- the existing kind list is extended in place so kinds admitted by other
-- migrations are preserved.
--
-- Backfill: none. New tables arrive empty and the new line columns are null.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.expense_amortization_templates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    effective_from date NOT NULL,
    method text NOT NULL,
    term_source text NOT NULL,
    period_count integer,
    percentages jsonb,
    deferral_account_id uuid NOT NULL,
    destination_account_id uuid,
    period_offset integer DEFAULT 0 NOT NULL,
    rounding text DEFAULT 'remainder_last_period' NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT expense_amortization_templates_pkey PRIMARY KEY (id),
    CONSTRAINT expense_amortization_templates_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT expense_amortization_templates_code_version UNIQUE (org_id, code, effective_from),
    CONSTRAINT expense_amortization_templates_code_check CHECK (length(btrim(code)) BETWEEN 1 AND 64),
    CONSTRAINT expense_amortization_templates_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    CONSTRAINT expense_amortization_templates_method_check
      CHECK (method = ANY (ARRAY['straight_line'::text, 'prorated_first_last'::text, 'exact_days'::text, 'variable'::text])),
    CONSTRAINT expense_amortization_templates_term_source_check
      CHECK (term_source = ANY (ARRAY['template'::text, 'service_dates'::text])),
    CONSTRAINT expense_amortization_templates_period_count_check
      CHECK (period_count IS NULL OR period_count BETWEEN 1 AND 600),
    CONSTRAINT expense_amortization_templates_term_check
      CHECK (term_source <> 'template' OR period_count IS NOT NULL),
    CONSTRAINT expense_amortization_templates_variable_check
      CHECK ((method = 'variable') = (percentages IS NOT NULL)
             AND (method <> 'variable' OR (term_source = 'template'
                  AND jsonb_typeof(percentages) = 'array'
                  AND jsonb_array_length(percentages) = period_count))),
    CONSTRAINT expense_amortization_templates_offset_check CHECK (period_offset BETWEEN 0 AND 120),
    CONSTRAINT expense_amortization_templates_rounding_check CHECK (rounding = 'remainder_last_period'),
    CONSTRAINT expense_amortization_templates_accounts_distinct
      CHECK (destination_account_id IS NULL OR destination_account_id <> deferral_account_id),
    CONSTRAINT expense_amortization_templates_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) DEFERRABLE,
    CONSTRAINT expense_amortization_templates_deferral_account_fkey FOREIGN KEY (org_id, deferral_account_id)
      REFERENCES public.accounts(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_templates_destination_account_fkey FOREIGN KEY (org_id, destination_account_id)
      REFERENCES public.accounts(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_templates_created_by_fkey FOREIGN KEY (org_id, created_by)
      REFERENCES public.users(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_templates_updated_by_fkey FOREIGN KEY (org_id, updated_by)
      REFERENCES public.users(org_id, id) DEFERRABLE
);
CREATE INDEX expense_amortization_templates_code ON public.expense_amortization_templates (org_id, code, effective_from DESC);
COMMENT ON TABLE public.expense_amortization_templates IS 'Effective-dated amortization policy versions; a used version keeps its policy fixed.';

ALTER TABLE public.document_lines
  ADD COLUMN amortization_template_id uuid,
  ADD COLUMN amortization_start_on date,
  ADD COLUMN amortization_end_on date;
ALTER TABLE public.document_lines
  ADD CONSTRAINT document_lines_amortization_template_fkey FOREIGN KEY (org_id, amortization_template_id)
    REFERENCES public.expense_amortization_templates(org_id, id) DEFERRABLE,
  ADD CONSTRAINT document_lines_amortization_window_check
    CHECK (amortization_start_on IS NULL OR amortization_end_on IS NULL OR amortization_end_on >= amortization_start_on),
  ADD CONSTRAINT document_lines_amortization_dates_need_template
    CHECK (amortization_template_id IS NOT NULL OR (amortization_start_on IS NULL AND amortization_end_on IS NULL));
CREATE INDEX doc_lines_amortization_template ON public.document_lines (org_id, amortization_template_id)
  WHERE amortization_template_id IS NOT NULL;

CREATE TABLE public.expense_amortization_schedules (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    schedule_number text NOT NULL,
    status text NOT NULL,
    source_kind text NOT NULL,
    source_document_id uuid,
    source_line_id uuid,
    source_entry_id uuid,
    template_id uuid NOT NULL,
    method text NOT NULL,
    term_source text NOT NULL,
    period_offset integer NOT NULL,
    subsidiary_id uuid NOT NULL,
    book_id uuid NOT NULL,
    currency text NOT NULL,
    total_amount numeric(19,4) NOT NULL,
    opening_amortized_amount numeric(19,4) DEFAULT 0 NOT NULL,
    reversed_amount numeric(19,4) DEFAULT 0 NOT NULL,
    service_start_on date NOT NULL,
    service_end_on date NOT NULL,
    first_period_on date NOT NULL,
    deferral_account_id uuid NOT NULL,
    destination_account_id uuid NOT NULL,
    department_id uuid,
    project_id uuid,
    location_id uuid,
    class_id uuid,
    extra_dims jsonb DEFAULT '{}'::jsonb NOT NULL,
    memo text,
    hold_reason text,
    revision integer DEFAULT 1 NOT NULL,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT expense_amortization_schedules_pkey PRIMARY KEY (id),
    CONSTRAINT expense_amortization_schedules_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT expense_amortization_schedules_number_unique UNIQUE (org_id, schedule_number),
    CONSTRAINT expense_amortization_schedules_status_check
      CHECK (status = ANY (ARRAY['draft'::text, 'active'::text, 'on_hold'::text, 'completed'::text, 'cancelled'::text])),
    CONSTRAINT expense_amortization_schedules_source_kind_check
      CHECK (source_kind = ANY (ARRAY['vendor_bill'::text, 'journal'::text, 'expense_report'::text, 'manual'::text])),
    CONSTRAINT expense_amortization_schedules_source_check
      CHECK ((source_kind = 'manual') = (source_document_id IS NULL)
             AND (source_document_id IS NULL) = (source_line_id IS NULL)
             AND (source_document_id IS NULL) = (source_entry_id IS NULL)),
    CONSTRAINT expense_amortization_schedules_draft_manual_check
      CHECK (status <> 'draft' OR source_kind = 'manual'),
    CONSTRAINT expense_amortization_schedules_method_check
      CHECK (method = ANY (ARRAY['straight_line'::text, 'prorated_first_last'::text, 'exact_days'::text, 'variable'::text])),
    CONSTRAINT expense_amortization_schedules_term_source_check
      CHECK (term_source = ANY (ARRAY['template'::text, 'service_dates'::text])),
    CONSTRAINT expense_amortization_schedules_amounts_check
      CHECK (total_amount > 0 AND opening_amortized_amount >= 0 AND reversed_amount >= 0
             AND opening_amortized_amount <= total_amount),
    CONSTRAINT expense_amortization_schedules_window_check CHECK (service_end_on >= service_start_on),
    CONSTRAINT expense_amortization_schedules_first_period_check
      CHECK (first_period_on = date_trunc('month', first_period_on)::date),
    CONSTRAINT expense_amortization_schedules_accounts_distinct CHECK (destination_account_id <> deferral_account_id),
    CONSTRAINT expense_amortization_schedules_hold_check CHECK ((status = 'on_hold') = (hold_reason IS NOT NULL)),
    CONSTRAINT expense_amortization_schedules_revision_check CHECK (revision >= 1),
    CONSTRAINT expense_amortization_schedules_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_source_document_fkey FOREIGN KEY (org_id, source_document_id)
      REFERENCES public.documents(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_source_line_fkey FOREIGN KEY (org_id, source_line_id)
      REFERENCES public.document_lines(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_source_entry_fkey FOREIGN KEY (org_id, source_entry_id)
      REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_template_fkey FOREIGN KEY (org_id, template_id)
      REFERENCES public.expense_amortization_templates(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id)
      REFERENCES public.subsidiaries(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_book_fkey FOREIGN KEY (org_id, book_id)
      REFERENCES public.accounting_books(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_currency_fkey FOREIGN KEY (currency)
      REFERENCES public.currencies(code) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_deferral_account_fkey FOREIGN KEY (org_id, deferral_account_id)
      REFERENCES public.accounts(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_destination_account_fkey FOREIGN KEY (org_id, destination_account_id)
      REFERENCES public.accounts(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_department_fkey FOREIGN KEY (org_id, department_id)
      REFERENCES public.departments(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_project_fkey FOREIGN KEY (org_id, project_id)
      REFERENCES public.projects(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_location_fkey FOREIGN KEY (org_id, location_id)
      REFERENCES public.locations(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_class_fkey FOREIGN KEY (org_id, class_id)
      REFERENCES public.classes(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_created_by_fkey FOREIGN KEY (org_id, created_by)
      REFERENCES public.users(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedules_updated_by_fkey FOREIGN KEY (org_id, updated_by)
      REFERENCES public.users(org_id, id) DEFERRABLE
);
-- One schedule per source line: posting retries resolve to the same schedule.
CREATE UNIQUE INDEX expense_amortization_schedules_source_line
  ON public.expense_amortization_schedules (org_id, source_line_id) WHERE source_line_id IS NOT NULL;
CREATE INDEX expense_amortization_schedules_source_document
  ON public.expense_amortization_schedules (org_id, source_document_id) WHERE source_document_id IS NOT NULL;
CREATE INDEX expense_amortization_schedules_status ON public.expense_amortization_schedules (org_id, status);
CREATE INDEX expense_amortization_schedules_deferral
  ON public.expense_amortization_schedules (org_id, deferral_account_id, subsidiary_id);
COMMENT ON TABLE public.expense_amortization_schedules IS 'Prepaid and deferred expense balances amortized by monthly plan; changes are recorded as schedule events.';

CREATE TABLE public.expense_amortization_schedule_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    plan_revision integer NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    weight bigint NOT NULL,
    planned_amount numeric(19,4) NOT NULL,
    destination_account_id uuid NOT NULL,
    status text DEFAULT 'planned' NOT NULL,
    journal_entry_id uuid,
    posted_at timestamp with time zone,
    posted_by uuid,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT expense_amortization_schedule_lines_pkey PRIMARY KEY (id),
    CONSTRAINT expense_amortization_schedule_lines_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT expense_amortization_schedule_lines_status_check
      CHECK (status = ANY (ARRAY['planned'::text, 'posted'::text, 'superseded'::text, 'cancelled'::text])),
    CONSTRAINT expense_amortization_schedule_lines_period_check
      CHECK (period_start = date_trunc('month', period_start)::date
             AND period_end = (date_trunc('month', period_start) + interval '1 month - 1 day')::date),
    CONSTRAINT expense_amortization_schedule_lines_amount_check CHECK (planned_amount >= 0 AND weight >= 0),
    CONSTRAINT expense_amortization_schedule_lines_revision_check CHECK (plan_revision >= 1),
    CONSTRAINT expense_amortization_schedule_lines_posted_check
      CHECK ((status = 'posted') = (journal_entry_id IS NOT NULL)
             AND (status = 'posted') = (posted_at IS NOT NULL)
             AND (status = ANY (ARRAY['superseded'::text, 'cancelled'::text])) = (closed_at IS NOT NULL)),
    CONSTRAINT expense_amortization_schedule_lines_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedule_lines_schedule_fkey FOREIGN KEY (org_id, schedule_id)
      REFERENCES public.expense_amortization_schedules(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedule_lines_account_fkey FOREIGN KEY (org_id, destination_account_id)
      REFERENCES public.accounts(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedule_lines_entry_fkey FOREIGN KEY (org_id, journal_entry_id)
      REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedule_lines_posted_by_fkey FOREIGN KEY (org_id, posted_by)
      REFERENCES public.users(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedule_lines_created_by_fkey FOREIGN KEY (org_id, created_by)
      REFERENCES public.users(org_id, id) DEFERRABLE
);
-- One live (planned or posted) line per schedule and period: amortization
-- posts each period of a schedule exactly once.
CREATE UNIQUE INDEX expense_amortization_schedule_lines_live_period
  ON public.expense_amortization_schedule_lines (org_id, schedule_id, period_start)
  WHERE status = ANY (ARRAY['planned'::text, 'posted'::text]);
CREATE UNIQUE INDEX expense_amortization_schedule_lines_entry
  ON public.expense_amortization_schedule_lines (org_id, journal_entry_id) WHERE journal_entry_id IS NOT NULL;
CREATE INDEX expense_amortization_schedule_lines_due
  ON public.expense_amortization_schedule_lines (org_id, period_end) WHERE status = 'planned';
COMMENT ON TABLE public.expense_amortization_schedule_lines IS 'Monthly amortization plan; posted, superseded and cancelled lines are immutable history.';

CREATE TABLE public.expense_amortization_schedule_events (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    schedule_id uuid NOT NULL,
    kind text NOT NULL,
    effective_period_on date,
    effective_on date NOT NULL,
    balance_delta numeric(19,4) DEFAULT 0 NOT NULL,
    reason text NOT NULL,
    before_state jsonb,
    after_state jsonb NOT NULL,
    journal_entry_id uuid,
    related_document_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT expense_amortization_schedule_events_pkey PRIMARY KEY (id),
    CONSTRAINT expense_amortization_schedule_events_org_id_id_unique UNIQUE (org_id, id),
    CONSTRAINT expense_amortization_schedule_events_kind_check
      CHECK (kind = ANY (ARRAY['created'::text, 'activated'::text, 'held'::text, 'resumed'::text, 'term_changed'::text,
                                'destination_changed'::text, 'reduced'::text, 'cancelled'::text, 'source_voided'::text,
                                'completed'::text])),
    CONSTRAINT expense_amortization_schedule_events_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
    CONSTRAINT expense_amortization_schedule_events_state_check
      CHECK (jsonb_typeof(after_state) = 'object' AND (before_state IS NULL OR jsonb_typeof(before_state) = 'object')),
    CONSTRAINT expense_amortization_schedule_events_period_check
      CHECK (effective_period_on IS NULL OR effective_period_on = date_trunc('month', effective_period_on)::date),
    CONSTRAINT expense_amortization_schedule_events_org_id_fkey FOREIGN KEY (org_id)
      REFERENCES public.orgs(id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedule_events_schedule_fkey FOREIGN KEY (org_id, schedule_id)
      REFERENCES public.expense_amortization_schedules(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedule_events_entry_fkey FOREIGN KEY (org_id, journal_entry_id)
      REFERENCES public.journal_entries(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedule_events_document_fkey FOREIGN KEY (org_id, related_document_id)
      REFERENCES public.documents(org_id, id) DEFERRABLE,
    CONSTRAINT expense_amortization_schedule_events_created_by_fkey FOREIGN KEY (org_id, created_by)
      REFERENCES public.users(org_id, id) DEFERRABLE
);
CREATE INDEX expense_amortization_schedule_events_schedule
  ON public.expense_amortization_schedule_events (org_id, schedule_id, created_at);
COMMENT ON TABLE public.expense_amortization_schedule_events IS 'Append-only schedule history: every lifecycle change with its reason and before/after state.';
COMMENT ON COLUMN public.expense_amortization_schedule_events.balance_delta IS 'Change to the unamortized balance on effective_on, besides posted plan lines; the subledger balance as of a date is the sum of deltas less posted lines through that date.';

-- A template version in use keeps its policy: later policy is a new
-- effective-dated version. Name, description and the active flag stay editable.
CREATE FUNCTION public.expense_amortization_template_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $func$
BEGIN
  IF (NEW.code IS DISTINCT FROM OLD.code
      OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
      OR NEW.method IS DISTINCT FROM OLD.method
      OR NEW.term_source IS DISTINCT FROM OLD.term_source
      OR NEW.period_count IS DISTINCT FROM OLD.period_count
      OR NEW.percentages IS DISTINCT FROM OLD.percentages
      OR NEW.deferral_account_id IS DISTINCT FROM OLD.deferral_account_id
      OR NEW.destination_account_id IS DISTINCT FROM OLD.destination_account_id
      OR NEW.period_offset IS DISTINCT FROM OLD.period_offset
      OR NEW.rounding IS DISTINCT FROM OLD.rounding
      OR NEW.org_id IS DISTINCT FROM OLD.org_id)
     AND (EXISTS (SELECT 1 FROM public.expense_amortization_schedules s
                   WHERE s.org_id = OLD.org_id AND s.template_id = OLD.id)
          OR EXISTS (SELECT 1 FROM public.document_lines l
                       JOIN public.documents d ON d.org_id = l.org_id AND d.id = l.document_id
                      WHERE l.org_id = OLD.org_id AND l.amortization_template_id = OLD.id
                        AND d.status <> 'draft')) THEN
    RAISE EXCEPTION 'Amortization template % (effective %) is in use and its policy is fixed; add a new version with a later effective date instead.', OLD.code, OLD.effective_from
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $func$;
CREATE TRIGGER expense_amortization_template_guard
  BEFORE UPDATE ON public.expense_amortization_templates
  FOR EACH ROW EXECUTE FUNCTION public.expense_amortization_template_guard();

-- Schedule identity is fixed, a cancelled schedule is final, a completed
-- schedule only takes a credit reduction or its source's cancellation, every
-- change advances the revision by exactly one, and only the declared
-- lifecycle transitions are admitted.
CREATE FUNCTION public.expense_amortization_schedule_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $func$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
       OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Amortization schedules are retained history; cancel the schedule instead of deleting it.'
      USING ERRCODE = '23514';
  END IF;
  -- A project merge re-points the project dimension across history, exactly
  -- as it re-points the posted journal lines the schedule produced.
  IF (to_jsonb(NEW) - 'project_id' - 'updated_at' - 'updated_by')
     = (to_jsonb(OLD) - 'project_id' - 'updated_at' - 'updated_by') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'Amortization schedule % is cancelled, which is final.', OLD.schedule_number
      USING ERRCODE = '23514';
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.schedule_number IS DISTINCT FROM OLD.schedule_number
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
     OR NEW.source_line_id IS DISTINCT FROM OLD.source_line_id
     OR NEW.source_entry_id IS DISTINCT FROM OLD.source_entry_id
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.term_source IS DISTINCT FROM OLD.term_source
     OR NEW.subsidiary_id IS DISTINCT FROM OLD.subsidiary_id
     OR NEW.book_id IS DISTINCT FROM OLD.book_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.deferral_account_id IS DISTINCT FROM OLD.deferral_account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Amortization schedule % keeps its source, template, entity, book, currency and deferral account.', OLD.schedule_number
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.opening_amortized_amount IS DISTINCT FROM OLD.opening_amortized_amount
       OR NEW.service_start_on IS DISTINCT FROM OLD.service_start_on
       OR NEW.first_period_on IS DISTINCT FROM OLD.first_period_on
       OR NEW.period_offset IS DISTINCT FROM OLD.period_offset
       OR NEW.total_amount > OLD.total_amount
       OR NEW.reversed_amount < OLD.reversed_amount) THEN
    RAISE EXCEPTION 'Amortization schedule % changes only through its recorded events once activated.', OLD.schedule_number
      USING ERRCODE = '23514';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'Amortization schedule % changed concurrently; reload it and try again.', OLD.schedule_number
      USING ERRCODE = '40001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('active', 'cancelled'))
       OR (OLD.status = 'active' AND NEW.status IN ('on_hold', 'completed', 'cancelled'))
       OR (OLD.status = 'on_hold' AND NEW.status IN ('active', 'cancelled'))
       OR (OLD.status = 'completed' AND NEW.status = 'cancelled')) THEN
    RAISE EXCEPTION 'Amortization schedule % cannot move from % to %.', OLD.schedule_number, OLD.status, NEW.status
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $func$;
CREATE TRIGGER expense_amortization_schedule_guard
  BEFORE UPDATE OR DELETE ON public.expense_amortization_schedules
  FOR EACH ROW EXECUTE FUNCTION public.expense_amortization_schedule_guard();

-- A planned line either posts, is superseded by a re-forecast, or is
-- cancelled with its schedule; its period, weight, amount and account never
-- change, and every other status is final.
CREATE FUNCTION public.expense_amortization_line_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $func$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
       OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Amortization plan lines are retained history; re-forecast or cancel the schedule instead.'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'planned' THEN
    RAISE EXCEPTION 'A % amortization line is final.', OLD.status
      USING ERRCODE = '23514';
  END IF;
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
     OR NEW.plan_revision IS DISTINCT FROM OLD.plan_revision
     OR NEW.period_start IS DISTINCT FROM OLD.period_start
     OR NEW.period_end IS DISTINCT FROM OLD.period_end
     OR NEW.weight IS DISTINCT FROM OLD.weight
     OR NEW.planned_amount IS DISTINCT FROM OLD.planned_amount
     OR NEW.destination_account_id IS DISTINCT FROM OLD.destination_account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.status NOT IN ('posted', 'superseded', 'cancelled') THEN
    RAISE EXCEPTION 'An amortization line keeps its period, amount and account; it can only post, be superseded or be cancelled.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $func$;
CREATE TRIGGER expense_amortization_line_guard
  BEFORE UPDATE OR DELETE ON public.expense_amortization_schedule_lines
  FOR EACH ROW EXECUTE FUNCTION public.expense_amortization_line_guard();

CREATE FUNCTION public.expense_amortization_event_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_catalog AS $func$
BEGIN
  IF TG_OP = 'DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
                           OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Amortization schedule events are append-only history.'
    USING ERRCODE = '23514';
END $func$;
CREATE TRIGGER expense_amortization_event_guard
  BEFORE UPDATE OR DELETE ON public.expense_amortization_schedule_events
  FOR EACH ROW EXECUTE FUNCTION public.expense_amortization_event_guard();

ALTER TABLE ONLY public.expense_amortization_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.expense_amortization_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.expense_amortization_templates
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.expense_amortization_templates IS 'openbooks:org_isolation:v1';

ALTER TABLE ONLY public.expense_amortization_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.expense_amortization_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.expense_amortization_schedules
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.expense_amortization_schedules IS 'openbooks:org_isolation:v1';

ALTER TABLE ONLY public.expense_amortization_schedule_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.expense_amortization_schedule_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.expense_amortization_schedule_lines
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.expense_amortization_schedule_lines IS 'openbooks:org_isolation:v1';

ALTER TABLE ONLY public.expense_amortization_schedule_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY public.expense_amortization_schedule_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.expense_amortization_schedule_events
 USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.expense_amortization_schedule_events IS 'openbooks:org_isolation:v1';

-- Tenant retirement fences every tenant table; attach the standard fence,
-- create-if-absent so the migration reapplies cleanly.
DO $fences$
DECLARE target record;
BEGIN
 FOR target IN SELECT * FROM (VALUES
('expense_amortization_templates'),
('expense_amortization_schedules'),
('expense_amortization_schedule_lines'),
('expense_amortization_schedule_events')
 ) AS expected(table_name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=target.table_name AND t.tgname='tenant_retirement_fence') THEN
   EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()',target.table_name);
  END IF;
 END LOOP;
END $fences$;

-- Admit the automatic amortization scan. The kind list is extended in place
-- so every kind already admitted stays admitted; the scope constraint is
-- unchanged (every kind outside the subject-bound ones is an org-wide scan).
DO $kinds$
DECLARE current_def text; extended text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO current_def
    FROM pg_constraint c
   WHERE c.conrelid = 'public.scheduler_outbox'::regclass AND c.conname = 'scheduler_outbox_kind';
  IF current_def IS NULL THEN
    RAISE EXCEPTION 'scheduler_outbox_kind is not installed';
  END IF;
  IF position('''expense_amortization''::text' IN current_def) > 0 THEN
    RETURN; -- expected on replay
  END IF;
  extended := regexp_replace(current_def, '\](\)+)$', ', ''expense_amortization''::text]\1');
  IF extended = current_def THEN
    RAISE EXCEPTION 'scheduler_outbox_kind differs from the published shape; reconcile it before applying this migration';
  END IF;
  EXECUTE 'ALTER TABLE public.scheduler_outbox DROP CONSTRAINT scheduler_outbox_kind';
  EXECUTE 'ALTER TABLE public.scheduler_outbox ADD CONSTRAINT scheduler_outbox_kind ' || extended;
END $kinds$;

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('expense_amortization_templates', '0687_expense_amortization_schedules'),
  ('expense_amortization_schedules', '0687_expense_amortization_schedules'),
  ('expense_amortization_schedule_lines', '0687_expense_amortization_schedules'),
  ('expense_amortization_schedule_events', '0687_expense_amortization_schedules')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
