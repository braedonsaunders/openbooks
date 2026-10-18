-- Existing organizations' standard close checklists gain the two equity
-- period steps the standard checklist now defines: post stock compensation
-- through period end, and accrue convertible note interest through period end.
-- Backfill: every active standard checklist gains each step it lacks, placed
-- after its prepaid amortization step, with the standard dependencies (each
-- follows the drafts check; the variance review and the period-end journals
-- follow each). The steps apply to a close only while Equity & cap table is
-- on. Custom checklists and close runs already started are not changed.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

WITH standard AS (
  SELECT b.id AS blueprint_id, b.org_id,
         coalesce((SELECT s.sort_order FROM public.close_blueprint_steps s
                    WHERE s.blueprint_id = b.id AND s.key = 'prepaid-amortized'),
                  (SELECT max(s.sort_order) FROM public.close_blueprint_steps s WHERE s.blueprint_id = b.id), 0) AS after_order
    FROM public.close_blueprints b
   WHERE b.is_active AND b.name = 'close.defaultData.blueprint.name'
), step (key, offset_order) AS (
  VALUES ('equity-compensation-posted', 1), ('equity-interest-accrued', 2)
)
INSERT INTO public.close_blueprint_steps
  (org_id, blueprint_id, key, title, description, workstream, task_type, completion_mode, gate_type,
   due_offset_business_days, evidence_required, sort_order, applicability)
SELECT standard.org_id, standard.blueprint_id, step.key,
       'close.defaultSteps.' || step.key || '.title', 'close.defaultSteps.' || step.key || '.description',
       'gl', 'journal', 'computed', 'hard', 2, true, standard.after_order + step.offset_order, '{}'::jsonb
  FROM standard CROSS JOIN step
-- A checklist that already holds the step keeps it as it stands.
ON CONFLICT (blueprint_id, key) DO NOTHING;

WITH edge (step_key, depends_on_key) AS (
  VALUES
    ('equity-compensation-posted', 'drafts-cleared'),
    ('equity-interest-accrued', 'drafts-cleared'),
    ('variance-review', 'equity-compensation-posted'),
    ('variance-review', 'equity-interest-accrued'),
    ('period-end-journals', 'equity-compensation-posted'),
    ('period-end-journals', 'equity-interest-accrued')
)
INSERT INTO public.close_blueprint_dependencies (org_id, blueprint_id, step_id, depends_on_step_id)
SELECT b.org_id, b.id, step.id, depends_on.id
  FROM public.close_blueprints b
  JOIN edge ON true
  JOIN public.close_blueprint_steps step ON step.blueprint_id = b.id AND step.org_id = b.org_id AND step.key = edge.step_key
  JOIN public.close_blueprint_steps depends_on ON depends_on.blueprint_id = b.id AND depends_on.org_id = b.org_id AND depends_on.key = edge.depends_on_key
 WHERE b.is_active AND b.name = 'close.defaultData.blueprint.name'
-- An edge the checklist already records stays as recorded.
ON CONFLICT (step_id, depends_on_step_id) DO NOTHING;
