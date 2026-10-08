-- OpenBooks forward migration 0582_project_delivery_controls.
-- Project delivery controls: the budget a job is sold at, the progress it
-- makes against that budget, the cost expected to finish it, internal
-- billing between parts of the business, and the period-end accrual of
-- time-and-materials work performed but not yet invoiced.
--
-- * project_tasks gain a price budget and an optional budgeted production
--   quantity; the task row remains the one current budget.
-- * project_budget_baselines/_lines are immutable snapshots of that budget
--   (the original sold budget, and later revised baselines).
-- * projects record the quote they were awarded from, one project per quote.
-- * project_forecasts append estimate-to-complete evidence per task.
-- * project_progress_entries is the append-only installed-quantity ledger;
--   field_ticket_quantities hold a ticket's production until it is approved.
-- * document_lines carry an optional project task and the period the work
--   was performed; documents carry the date the invoiced work completed.
-- * internal_billing_rules are effective-dated accounting treatments for the
--   internal_billing document kind.
-- * project_revenue_accruals record each accrual of unbilled
--   time-and-materials revenue with its reversal.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

-- ---------------------------------------------------------------------------
-- Task budget: price and production quantity
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS project_tasks_org_id_id_unique
  ON public.project_tasks USING btree (org_id, id);

ALTER TABLE public.project_tasks
  ADD COLUMN estimated_price numeric(19,4),
  ADD COLUMN budget_quantity numeric(28,8),
  ADD COLUMN budget_unit text,
  ADD CONSTRAINT project_tasks_estimated_price_nonnegative
    CHECK (estimated_price IS NULL OR estimated_price >= 0),
  ADD CONSTRAINT project_tasks_budget_quantity_positive
    CHECK (budget_quantity IS NULL OR budget_quantity > 0),
  ADD CONSTRAINT project_tasks_budget_quantity_unit_pair
    CHECK ((budget_quantity IS NULL) = (budget_unit IS NULL)),
  ADD CONSTRAINT project_tasks_budget_unit_text
    CHECK (budget_unit IS NULL OR (budget_unit = btrim(budget_unit) AND length(budget_unit) BETWEEN 1 AND 32));

COMMENT ON COLUMN public.project_tasks.estimated_price IS
  'Current price (revenue) budget for the task. The sold budget is preserved in project_budget_baselines.';
COMMENT ON COLUMN public.project_tasks.budget_quantity IS
  'Budgeted production quantity for the task, in budget_unit. Installed quantities accumulate in project_progress_entries.';

-- ---------------------------------------------------------------------------
-- Award provenance
-- ---------------------------------------------------------------------------

ALTER TABLE public.projects
  ADD COLUMN awarded_from_document_id uuid,
  ADD COLUMN awarded_at timestamptz,
  ADD COLUMN awarded_by uuid,
  ADD CONSTRAINT projects_awarded_from_document_tenant_fk
    FOREIGN KEY (org_id, awarded_from_document_id) REFERENCES public.documents(org_id, id),
  ADD CONSTRAINT projects_award_provenance_complete
    CHECK ((awarded_from_document_id IS NULL) = (awarded_at IS NULL));

-- One project per awarded quote: an award replays to the same project.
CREATE UNIQUE INDEX projects_one_per_awarded_quote
  ON public.projects USING btree (org_id, awarded_from_document_id)
  WHERE awarded_from_document_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Budget baselines (immutable snapshots)
-- ---------------------------------------------------------------------------

CREATE TABLE public.project_budget_baselines (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 project_id uuid NOT NULL,
 kind text NOT NULL,
 sequence integer NOT NULL,
 label text NOT NULL,
 reason text NOT NULL,
 source_document_id uuid,
 total_hours numeric(28,8) NOT NULL DEFAULT 0,
 total_cost numeric(19,4) NOT NULL DEFAULT 0,
 total_price numeric(19,4) NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id, id),
 CONSTRAINT project_budget_baselines_project_tenant_fk
   FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id),
 CONSTRAINT project_budget_baselines_source_tenant_fk
   FOREIGN KEY (org_id, source_document_id) REFERENCES public.documents(org_id, id),
 CONSTRAINT project_budget_baselines_kind_check CHECK (kind IN ('original', 'revised')),
 CONSTRAINT project_budget_baselines_sequence_positive CHECK (sequence >= 1),
 CONSTRAINT project_budget_baselines_original_first CHECK ((kind = 'original') = (sequence = 1)),
 CONSTRAINT project_budget_baselines_label_text CHECK (length(btrim(label)) BETWEEN 1 AND 120),
 CONSTRAINT project_budget_baselines_reason_text CHECK (length(btrim(reason)) >= 8)
);
CREATE UNIQUE INDEX project_budget_baselines_sequence
  ON public.project_budget_baselines USING btree (org_id, project_id, sequence);
CREATE INDEX project_budget_baselines_source
  ON public.project_budget_baselines USING btree (org_id, source_document_id)
  WHERE source_document_id IS NOT NULL;
COMMENT ON TABLE public.project_budget_baselines IS
  'Immutable snapshot of a project budget. Sequence 1 is the original (sold) budget; later sequences are revised baselines. The current working budget is the project_tasks row.';

CREATE TABLE public.project_budget_baseline_lines (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 baseline_id uuid NOT NULL,
 project_id uuid NOT NULL,
 project_task_id uuid NOT NULL,
 sequence integer NOT NULL,
 task_code text,
 task_name text NOT NULL,
 source_line_id uuid,
 item_id uuid,
 description text,
 hours numeric(28,8) NOT NULL DEFAULT 0,
 quantity numeric(28,8),
 unit text,
 cost numeric(19,4) NOT NULL DEFAULT 0,
 price numeric(19,4) NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 UNIQUE (org_id, id),
 CONSTRAINT project_budget_baseline_lines_baseline_tenant_fk
   FOREIGN KEY (org_id, baseline_id) REFERENCES public.project_budget_baselines(org_id, id),
 CONSTRAINT project_budget_baseline_lines_project_tenant_fk
   FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id),
 CONSTRAINT project_budget_baseline_lines_task_tenant_fk
   FOREIGN KEY (org_id, project_task_id) REFERENCES public.project_tasks(org_id, id),
 CONSTRAINT project_budget_baseline_lines_source_tenant_fk
   FOREIGN KEY (org_id, source_line_id) REFERENCES public.document_lines(org_id, id),
 CONSTRAINT project_budget_baseline_lines_item_tenant_fk
   FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id),
 CONSTRAINT project_budget_baseline_lines_amounts_nonnegative
   CHECK (hours >= 0 AND cost >= 0 AND price >= 0),
 CONSTRAINT project_budget_baseline_lines_quantity_unit_pair
   CHECK ((quantity IS NULL) = (unit IS NULL) AND (quantity IS NULL OR quantity > 0))
);
CREATE UNIQUE INDEX project_budget_baseline_lines_sequence
  ON public.project_budget_baseline_lines USING btree (org_id, baseline_id, sequence);
CREATE INDEX project_budget_baseline_lines_task
  ON public.project_budget_baseline_lines USING btree (org_id, project_task_id);

-- ---------------------------------------------------------------------------
-- Estimate-to-complete forecasts (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE public.project_forecasts (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 project_id uuid NOT NULL,
 project_task_id uuid NOT NULL,
 as_of_date date NOT NULL,
 method text NOT NULL,
 cost_to_complete numeric(19,4) NOT NULL,
 hours_to_complete numeric(28,8),
 note text,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 UNIQUE (org_id, id),
 CONSTRAINT project_forecasts_project_tenant_fk
   FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id),
 CONSTRAINT project_forecasts_task_tenant_fk
   FOREIGN KEY (org_id, project_task_id) REFERENCES public.project_tasks(org_id, id),
 CONSTRAINT project_forecasts_method_check
   CHECK (method IN ('manual', 'remaining_budget', 'units_productivity', 'cost_performance')),
 CONSTRAINT project_forecasts_nonnegative
   CHECK (cost_to_complete >= 0 AND (hours_to_complete IS NULL OR hours_to_complete >= 0))
);
CREATE INDEX project_forecasts_task_as_of
  ON public.project_forecasts USING btree (org_id, project_task_id, as_of_date DESC, created_at DESC);
CREATE INDEX project_forecasts_project
  ON public.project_forecasts USING btree (org_id, project_id, as_of_date);
COMMENT ON TABLE public.project_forecasts IS
  'Estimate-to-complete evidence per project task. The latest row on or before a date governs that date; a new estimate appends a row, history is never rewritten.';

-- ---------------------------------------------------------------------------
-- Installed-quantity ledger (append-only) and field-ticket production
-- ---------------------------------------------------------------------------

CREATE TABLE public.project_progress_entries (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 project_id uuid NOT NULL,
 project_task_id uuid NOT NULL,
 entry_date date NOT NULL,
 quantity numeric(28,8) NOT NULL,
 unit text NOT NULL,
 source text NOT NULL,
 source_document_id uuid,
 reverses_entry_id uuid,
 note text,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 UNIQUE (org_id, id),
 CONSTRAINT project_progress_entries_project_tenant_fk
   FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id),
 CONSTRAINT project_progress_entries_task_tenant_fk
   FOREIGN KEY (org_id, project_task_id) REFERENCES public.project_tasks(org_id, id),
 CONSTRAINT project_progress_entries_source_document_tenant_fk
   FOREIGN KEY (org_id, source_document_id) REFERENCES public.documents(org_id, id),
 CONSTRAINT project_progress_entries_reverses_tenant_fk
   FOREIGN KEY (org_id, reverses_entry_id) REFERENCES public.project_progress_entries(org_id, id),
 CONSTRAINT project_progress_entries_nonzero CHECK (quantity <> 0),
 CONSTRAINT project_progress_entries_unit_text
   CHECK (unit = btrim(unit) AND length(unit) BETWEEN 1 AND 32),
 CONSTRAINT project_progress_entries_source_check CHECK (source IN ('manual', 'field_ticket')),
 CONSTRAINT project_progress_entries_field_ticket_source
   CHECK (source <> 'field_ticket' OR source_document_id IS NOT NULL),
 CONSTRAINT project_progress_entries_not_self_reversing
   CHECK (reverses_entry_id IS NULL OR reverses_entry_id <> id)
);
CREATE UNIQUE INDEX project_progress_entries_one_reversal
  ON public.project_progress_entries USING btree (org_id, reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;
CREATE INDEX project_progress_entries_task_date
  ON public.project_progress_entries USING btree (org_id, project_task_id, entry_date);
CREATE INDEX project_progress_entries_project_date
  ON public.project_progress_entries USING btree (org_id, project_id, entry_date);
CREATE INDEX project_progress_entries_source_document
  ON public.project_progress_entries USING btree (org_id, source_document_id)
  WHERE source_document_id IS NOT NULL;
COMMENT ON TABLE public.project_progress_entries IS
  'Append-only installed quantities per project task. Corrections append an exact reversing row; recorded progress is never edited or deleted.';

CREATE TABLE public.field_ticket_quantities (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 field_ticket_id uuid NOT NULL,
 project_task_id uuid NOT NULL,
 quantity numeric(28,8) NOT NULL,
 unit text NOT NULL,
 note text,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id, id),
 CONSTRAINT field_ticket_quantities_ticket_tenant_fk
   FOREIGN KEY (org_id, field_ticket_id) REFERENCES public.documents(org_id, id),
 CONSTRAINT field_ticket_quantities_task_tenant_fk
   FOREIGN KEY (org_id, project_task_id) REFERENCES public.project_tasks(org_id, id),
 CONSTRAINT field_ticket_quantities_positive CHECK (quantity > 0),
 CONSTRAINT field_ticket_quantities_unit_text
   CHECK (unit = btrim(unit) AND length(unit) BETWEEN 1 AND 32)
);
CREATE INDEX field_ticket_quantities_ticket
  ON public.field_ticket_quantities USING btree (org_id, field_ticket_id);
COMMENT ON TABLE public.field_ticket_quantities IS
  'Production quantities reported on a field ticket. Approval records them in project_progress_entries.';

-- ---------------------------------------------------------------------------
-- Line task, work period and work-completed date
-- ---------------------------------------------------------------------------

ALTER TABLE public.document_lines
  ADD COLUMN project_task_id uuid,
  ADD COLUMN work_from date,
  ADD COLUMN work_to date,
  ADD CONSTRAINT document_lines_project_task_tenant_fk
    FOREIGN KEY (org_id, project_task_id) REFERENCES public.project_tasks(org_id, id),
  ADD CONSTRAINT document_lines_work_period_order
    CHECK (work_from IS NULL OR work_to IS NULL OR work_to >= work_from);
CREATE INDEX document_lines_project_task
  ON public.document_lines USING btree (org_id, project_task_id)
  WHERE project_task_id IS NOT NULL;

ALTER TABLE public.documents
  ADD COLUMN work_completed_on date;
COMMENT ON COLUMN public.documents.work_completed_on IS
  'Date the work an invoice charges for was completed. Generated invoices take the latest work date of their source lines.';

-- ---------------------------------------------------------------------------
-- Internal billing
-- ---------------------------------------------------------------------------

CREATE TABLE public.internal_billing_rules (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 code text NOT NULL,
 name text NOT NULL,
 method text NOT NULL,
 debit_account_id uuid NOT NULL,
 credit_account_id uuid NOT NULL,
 billable_by_default boolean NOT NULL DEFAULT false,
 description text,
 effective_from date NOT NULL,
 effective_to date,
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid,
 UNIQUE (org_id, id),
 CONSTRAINT internal_billing_rules_debit_tenant_fk
   FOREIGN KEY (org_id, debit_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT internal_billing_rules_credit_tenant_fk
   FOREIGN KEY (org_id, credit_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT internal_billing_rules_method_check
   CHECK (method IN ('revenue_credit', 'cost_transfer', 'intercompany_sale')),
 CONSTRAINT internal_billing_rules_code_text
   CHECK (code = btrim(code) AND length(code) BETWEEN 1 AND 40),
 CONSTRAINT internal_billing_rules_name_text CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 CONSTRAINT internal_billing_rules_window_valid
   CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
ALTER TABLE public.internal_billing_rules
  ADD CONSTRAINT internal_billing_rules_no_active_overlap
  EXCLUDE USING gist (
    org_id WITH =,
    code WITH =,
    (daterange(effective_from, COALESCE(effective_to, 'infinity'::date), '[]')) WITH &&
  )
  WHERE (is_active);
COMMENT ON CONSTRAINT internal_billing_rules_no_active_overlap
  ON public.internal_billing_rules IS
  'openbooks:internal_billing_rules_no_active_overlap:v1 - one active version of a rule code per date; NULL effective_to is open-ended';
CREATE INDEX internal_billing_rules_code
  ON public.internal_billing_rules USING btree (org_id, code, effective_from);
COMMENT ON TABLE public.internal_billing_rules IS
  'Effective-dated accounting treatment for internal billing. The receiving side is debited and the providing side credited; the method states how the movement stays out of consolidated revenue and cost.';

ALTER TABLE public.documents
  ADD COLUMN internal_billing_rule_id uuid,
  ADD CONSTRAINT documents_internal_billing_rule_tenant_fk
    FOREIGN KEY (org_id, internal_billing_rule_id) REFERENCES public.internal_billing_rules(org_id, id),
  ADD CONSTRAINT documents_internal_billing_rule_kind
    CHECK (internal_billing_rule_id IS NULL OR kind = 'internal_billing');
CREATE INDEX documents_internal_billing_rule
  ON public.documents USING btree (org_id, internal_billing_rule_id)
  WHERE internal_billing_rule_id IS NOT NULL;

INSERT INTO public.openbooks_document_close_modules (kind, close_module, added_in)
VALUES ('internal_billing', 'gl', '0582_project_delivery_controls');

-- ---------------------------------------------------------------------------
-- Unbilled time-and-materials revenue accruals
-- ---------------------------------------------------------------------------

CREATE TABLE public.project_revenue_accruals (
 id uuid DEFAULT public.uuid_generate_v7() NOT NULL PRIMARY KEY,
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 run_id uuid NOT NULL,
 project_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL,
 period_id uuid NOT NULL,
 accrual_date date NOT NULL,
 reversal_date date NOT NULL,
 amount numeric(19,4) NOT NULL,
 currency_code text NOT NULL,
 unbilled_account_id uuid NOT NULL,
 revenue_account_id uuid NOT NULL,
 accrual_entry_id uuid NOT NULL,
 reversal_entry_id uuid NOT NULL,
 basis jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
 UNIQUE (org_id, id),
 CONSTRAINT project_revenue_accruals_project_tenant_fk
   FOREIGN KEY (org_id, project_id) REFERENCES public.projects(org_id, id),
 CONSTRAINT project_revenue_accruals_subsidiary_tenant_fk
   FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT project_revenue_accruals_period_tenant_fk
   FOREIGN KEY (org_id, period_id) REFERENCES public.accounting_periods(org_id, id),
 CONSTRAINT project_revenue_accruals_unbilled_tenant_fk
   FOREIGN KEY (org_id, unbilled_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT project_revenue_accruals_revenue_tenant_fk
   FOREIGN KEY (org_id, revenue_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT project_revenue_accruals_accrual_entry_tenant_fk
   FOREIGN KEY (org_id, accrual_entry_id) REFERENCES public.journal_entries(org_id, id),
 CONSTRAINT project_revenue_accruals_reversal_entry_tenant_fk
   FOREIGN KEY (org_id, reversal_entry_id) REFERENCES public.journal_entries(org_id, id),
 CONSTRAINT project_revenue_accruals_nonzero CHECK (amount <> 0),
 CONSTRAINT project_revenue_accruals_reversal_after CHECK (reversal_date > accrual_date),
 CONSTRAINT project_revenue_accruals_currency CHECK (currency_code ~ '^[A-Z]{3}$')
);
CREATE INDEX project_revenue_accruals_period
  ON public.project_revenue_accruals USING btree (org_id, period_id, project_id);
CREATE INDEX project_revenue_accruals_run
  ON public.project_revenue_accruals USING btree (org_id, run_id);
COMMENT ON TABLE public.project_revenue_accruals IS
  'Accrual of time-and-materials revenue performed in a period but not invoiced by its end, posted with its reversal on the first day of the next period. A rerun appends the change since the last run.';

-- ---------------------------------------------------------------------------
-- Immutability guards
-- ---------------------------------------------------------------------------

-- Baselines, forecasts, progress and accrual evidence are retained exactly as
-- recorded. Corrections append (a revised baseline, a newer forecast, a
-- reversing progress entry, a delta accrual).
CREATE FUNCTION public.project_delivery_evidence_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
   IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
 END IF;
 RAISE EXCEPTION '% is retained as recorded; append a correcting record instead of changing or deleting it', TG_TABLE_NAME
   USING ERRCODE = '23514';
END $$;

CREATE TRIGGER project_budget_baselines_evidence_guard
 BEFORE UPDATE OR DELETE ON public.project_budget_baselines
 FOR EACH ROW EXECUTE FUNCTION public.project_delivery_evidence_guard();
CREATE TRIGGER project_budget_baseline_lines_evidence_guard
 BEFORE UPDATE OR DELETE ON public.project_budget_baseline_lines
 FOR EACH ROW EXECUTE FUNCTION public.project_delivery_evidence_guard();
CREATE TRIGGER project_forecasts_evidence_guard
 BEFORE UPDATE OR DELETE ON public.project_forecasts
 FOR EACH ROW EXECUTE FUNCTION public.project_delivery_evidence_guard();
CREATE TRIGGER project_progress_entries_evidence_guard
 BEFORE UPDATE OR DELETE ON public.project_progress_entries
 FOR EACH ROW EXECUTE FUNCTION public.project_delivery_evidence_guard();
CREATE TRIGGER project_revenue_accruals_evidence_guard
 BEFORE UPDATE OR DELETE ON public.project_revenue_accruals
 FOR EACH ROW EXECUTE FUNCTION public.project_delivery_evidence_guard();

-- A rule version keeps its accounting facts. Closing its window or
-- deactivating it stays possible; changing the treatment takes a new version.
CREATE FUNCTION public.internal_billing_rules_history_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
 IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on' THEN
   IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP = 'DELETE' THEN
   RAISE EXCEPTION 'Internal billing rule history is preserved; deactivate the version instead of deleting it in Setup → Internal billing'
   USING ERRCODE = '23514';
 END IF;
 IF ROW(OLD.org_id, OLD.id, OLD.code, OLD.method, OLD.debit_account_id, OLD.credit_account_id,
        OLD.effective_from, OLD.created_at, OLD.created_by)
    IS DISTINCT FROM
    ROW(NEW.org_id, NEW.id, NEW.code, NEW.method, NEW.debit_account_id, NEW.credit_account_id,
        NEW.effective_from, NEW.created_at, NEW.created_by) THEN
   RAISE EXCEPTION 'Internal billing rule versions keep their accounting treatment; close the window and add a new version in Setup → Internal billing'
   USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER internal_billing_rules_history_guard
 BEFORE UPDATE OR DELETE ON public.internal_billing_rules
 FOR EACH ROW EXECUTE FUNCTION public.internal_billing_rules_history_guard();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE public.project_budget_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_budget_baselines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.project_budget_baselines
 USING (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.project_budget_baselines IS 'openbooks:org_isolation:v1';

ALTER TABLE public.project_budget_baseline_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_budget_baseline_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.project_budget_baseline_lines
 USING (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.project_budget_baseline_lines IS 'openbooks:org_isolation:v1';

ALTER TABLE public.project_forecasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_forecasts FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.project_forecasts
 USING (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.project_forecasts IS 'openbooks:org_isolation:v1';

ALTER TABLE public.project_progress_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_progress_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.project_progress_entries
 USING (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.project_progress_entries IS 'openbooks:org_isolation:v1';

ALTER TABLE public.field_ticket_quantities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_ticket_quantities FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.field_ticket_quantities
 USING (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.field_ticket_quantities IS 'openbooks:org_isolation:v1';

ALTER TABLE public.internal_billing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_billing_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.internal_billing_rules
 USING (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.internal_billing_rules IS 'openbooks:org_isolation:v1';

ALTER TABLE public.project_revenue_accruals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_revenue_accruals FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.project_revenue_accruals
 USING (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true))
 WITH CHECK (public.app_bypass_rls_active()
     OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.project_revenue_accruals IS 'openbooks:org_isolation:v1';

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES ('project_budget_baselines', '0582_project_delivery_controls'),
       ('project_budget_baseline_lines', '0582_project_delivery_controls'),
       ('project_forecasts', '0582_project_delivery_controls'),
       ('project_progress_entries', '0582_project_delivery_controls'),
       ('field_ticket_quantities', '0582_project_delivery_controls'),
       ('internal_billing_rules', '0582_project_delivery_controls'),
       ('project_revenue_accruals', '0582_project_delivery_controls')
ON CONFLICT (relation) DO NOTHING; -- expected on replay

SELECT public.openbooks_refresh_query_catalog();
