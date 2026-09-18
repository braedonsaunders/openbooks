-- OpenBooks forward migration 0178_crm_cost_and_stage_policy.
--
-- Applied exactly once by digest (scripts/bootstrap.ts reads every
-- schema/migrations/generated/*.sql in filename order inside one tracked
-- transaction). Written defensively: every statement tolerates re-execution.
--
-- Two independent CRM widenings that share one migration because they share
-- one governed-catalog rebuild.
--
-- 1. COST ON OPPORTUNITY LINES. An opportunity line has carried a price since
-- the baseline (quantity x unit_price = amount) and no cost, so nothing in the
-- pipeline could answer what a deal is worth after what it takes to deliver
-- it. unit_cost is the per-unit cost the seller expects to incur; cost_amount
-- is its derived extension, stored for the same reason amount is stored — a
-- reader must not have to re-multiply to reconcile, and the rounding must be
-- the writer's, not the reader's.
--
-- WHY NULLABLE, AND WHAT NULL MEANS. "Cost not recorded" and "cost is zero"
-- are different facts and they produce different margins: a zero cost reports
-- a 100% gross margin, which is a claim, while an absent cost reports no
-- margin at all, which is the truth about a line nobody costed. Every line
-- that exists today is uncosted, and defaulting them to 0 would assert a
-- 100% margin across the whole installed pipeline. So the columns are
-- NULLABLE with no backfill, NULL means "cost not recorded", and the header
-- rollup reports an indeterminate margin when any line is uncosted rather
-- than quietly reading absent cost as free delivery.
--
-- The pair is all-or-nothing: cost_amount is a stored derivation of unit_cost,
-- so a row carrying one without the other is a row whose derivation is a
-- guess. The CHECK enforces that, which also keeps a future reader from
-- inventing a unit cost by dividing a stray extension by a quantity.
--
-- Cost is NOT constrained to be at or below price. A deal sold below cost is a
-- real deal — often the one you most want a margin report to show you — and a
-- constraint forbidding it would push the loss into a note field where no
-- report can see it. Negative margin is representable on purpose.
--
-- Cost is denominated in the opportunity's currency, exactly like unit_price
-- and amount; there is no base-currency column on this table and this
-- migration does not invent one.
--
-- 2. STAGE-ENTRY POLICY ON OPPORTUNITY STATUSES. Deal desks gate stages:
-- nothing reaches Proposal without priced lines and a named contact, nothing
-- closes won at zero, nothing closes lost without a reason. Those rules were
-- not expressible, so the only one the product enforced was the loss reason,
-- hard-coded in the edit route as "closed and not won". That is a policy
-- wearing a schema flag's clothes: every organization got a single hard-coded answer,
-- and an organization that renamed or added stages got it anyway.
--
-- Each status now declares what entering it requires. The flags are the
-- declaration; a pure resolver in the engine
-- (validateOpportunityStageTransition) is the single enforcement point every
-- writer calls, so the board, the drawer, imports, scripts and the assistant
-- all refuse the same transitions for the same reason.
--
-- WHY false IS THE COLUMN DEFAULT BUT NOT THE INSTALLED BEHAVIOUR. A blanket
-- default of true would start refusing saves on stages nobody configured, so
-- the column default is false — a new status gates nothing until somebody
-- says it does. That would silently repeal today's loss-reason rule, so the
-- backfill below sets requires_win_loss_reason on every existing closed-and-
-- not-won status: installations keep the exact behaviour they have, and an
-- administrator who genuinely wants lost deals without a reason now has to
-- turn it off deliberately instead of discovering it was never optional.
-- Tenant bootstrap (engine ensureCrmDefaults) seeds the same flag on the
-- default Closed-lost status so a fresh organization matches an upgraded one.
--
-- No posted history is reinterpreted: opportunities are pre-ledger records and
-- nothing here touches journal lines, documents, or any stored total.
--
-- Forward-only: dropping the cost pair would strand margins already entered,
-- and dropping the policy flags would return every organization to the single
-- hard-coded rule this migration replaced.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

--
-- 1. Cost on opportunity lines.
--

ALTER TABLE public.crm_opportunity_lines
  ADD COLUMN IF NOT EXISTS unit_cost numeric(19,4);

ALTER TABLE public.crm_opportunity_lines
  ADD COLUMN IF NOT EXISTS cost_amount numeric(19,4);

ALTER TABLE public.crm_opportunity_lines DROP CONSTRAINT IF EXISTS crm_opportunity_line_cost;
ALTER TABLE public.crm_opportunity_lines ADD CONSTRAINT crm_opportunity_line_cost
  CHECK (
    (unit_cost IS NULL OR unit_cost >= (0)::numeric)
    AND (cost_amount IS NULL OR cost_amount >= (0)::numeric)
    AND ((unit_cost IS NULL) = (cost_amount IS NULL))
  );

COMMENT ON COLUMN public.crm_opportunity_lines.unit_cost IS
  'Expected cost per unit in the opportunity currency (0178). NULL = cost not recorded, which is not the same as zero: an uncosted line has no margin, a zero-cost line has a 100% margin. May exceed unit_price — a deal sold below cost is representable on purpose';

COMMENT ON COLUMN public.crm_opportunity_lines.cost_amount IS
  'quantity x unit_cost, extended and rounded by the writer (0178) exactly as amount extends unit_price, so a reader never re-derives it. NULL if and only if unit_cost is NULL';

COMMENT ON CONSTRAINT crm_opportunity_line_cost ON public.crm_opportunity_lines IS
  'Cost is non-negative and all-or-nothing (0178): cost_amount is a stored derivation of unit_cost, so a row carrying one without the other would carry a derivation nobody can reproduce';

--
-- 2. Stage-entry policy on opportunity statuses.
--

ALTER TABLE public.crm_opportunity_statuses
  ADD COLUMN IF NOT EXISTS requires_lines boolean DEFAULT false NOT NULL;

ALTER TABLE public.crm_opportunity_statuses
  ADD COLUMN IF NOT EXISTS requires_primary_contact boolean DEFAULT false NOT NULL;

ALTER TABLE public.crm_opportunity_statuses
  ADD COLUMN IF NOT EXISTS requires_positive_amount boolean DEFAULT false NOT NULL;

ALTER TABLE public.crm_opportunity_statuses
  ADD COLUMN IF NOT EXISTS requires_win_loss_reason boolean DEFAULT false NOT NULL;

-- Preserve the behaviour the hard-coded route rule already enforced. Narrowed
-- to rows that are not already set so a re-run is a no-op rather than an
-- administrator's deliberate opt-out being silently reinstated.
UPDATE public.crm_opportunity_statuses
   SET requires_win_loss_reason = true
 WHERE is_closed AND NOT is_won AND NOT requires_win_loss_reason;

COMMENT ON COLUMN public.crm_opportunity_statuses.requires_lines IS
  'Entering this stage requires at least one opportunity line (0178). Declared per status, enforced by the engine resolver validateOpportunityStageTransition on every write path';

COMMENT ON COLUMN public.crm_opportunity_statuses.requires_primary_contact IS
  'Entering this stage requires a primary contact on the opportunity (0178)';

COMMENT ON COLUMN public.crm_opportunity_statuses.requires_positive_amount IS
  'Entering this stage requires a projected amount strictly greater than zero (0178). The baseline CHECK already forbids a negative projected amount, so this is the "priced, not merely non-negative" gate';

COMMENT ON COLUMN public.crm_opportunity_statuses.requires_win_loss_reason IS
  'Entering this stage requires a win/loss reason (0178). Backfilled true on every existing closed-and-not-won status so upgrades keep the rule the edit route used to hard-code; a new status gates nothing until configured';

--
-- 3. Governed query catalog.
--
-- Both relations are in the refresh function's safe_relations list, so a
-- later full rebuild picks the new columns up on its own. Re-create the two
-- views now so the columns are readable without waiting for one. Re-create
-- rather than replace: an installation whose views were frozen by an older
-- refresh lists their columns in a different order than a fresh bootstrap,
-- and CREATE OR REPLACE VIEW refuses to reorder columns (0161 precedent).
-- Nothing depends on these views; the read role's grant is restored below
-- each rebuild.
--

DROP VIEW IF EXISTS openbooks_query.crm_opportunity_lines;
CREATE VIEW openbooks_query.crm_opportunity_lines WITH (security_barrier='true') AS
 SELECT id,
    org_id,
    opportunity_id,
    line_number,
    item_id,
    description,
    quantity,
    unit,
    unit_price,
    amount,
    probability,
    expected_amount,
    created_at,
    created_by,
    updated_at,
    updated_by,
    unit_cost,
    cost_amount
   FROM public.crm_opportunity_lines
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.crm_opportunity_lines TO openbooks_read;

DROP VIEW IF EXISTS openbooks_query.crm_opportunity_statuses;
CREATE VIEW openbooks_query.crm_opportunity_statuses WITH (security_barrier='true') AS
 SELECT id,
    org_id,
    key,
    name,
    description,
    sequence,
    probability,
    default_forecast_category,
    is_closed,
    is_won,
    is_default,
    is_active,
    created_at,
    created_by,
    updated_at,
    updated_by,
    requires_lines,
    requires_primary_contact,
    requires_positive_amount,
    requires_win_loss_reason
   FROM public.crm_opportunity_statuses
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.crm_opportunity_statuses TO openbooks_read;
