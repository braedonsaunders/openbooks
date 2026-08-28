-- OpenBooks forward migration 0079_budget_subsidiary.
--
-- A budget cell is an accounting plan for one legal entity.  The old cell
-- identity omitted that entity, so copying actuals from two subsidiaries
-- merged their amounts into one row.  Add the entity to the durable key and
-- preserve existing tenant data by assigning legacy cells to each tenant's
-- active root subsidiary.

BEGIN;

ALTER TABLE public.budget_lines
  ADD COLUMN subsidiary_id uuid;

DO $budget_subsidiary_backfill$
DECLARE
  missing_root record;
BEGIN
  -- Never guess an entity when the tenant's root is absent.  Aborting leaves
  -- the table untouched so an operator can repair the tenant and retry.
  SELECT bl.org_id
    INTO missing_root
    FROM public.budget_lines bl
   WHERE NOT EXISTS (
           SELECT 1
             FROM public.subsidiaries s
            WHERE s.org_id = bl.org_id
              AND s.parent_id IS NULL
              AND s.is_active
              AND NOT s.is_elimination
         )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'budget subsidiary backfill found a tenant without an active root subsidiary',
      DETAIL = jsonb_build_object('org_id', missing_root.org_id)::text,
      HINT = 'Create or reactivate the tenant root subsidiary, then retry migration 0079; no budget rows were rewritten.';
  END IF;

  UPDATE public.budget_lines bl
     SET subsidiary_id = root.id
    FROM public.subsidiaries root
   WHERE root.org_id = bl.org_id
     AND root.parent_id IS NULL
     AND root.is_active
     AND NOT root.is_elimination
     AND bl.subsidiary_id IS NULL;
END;
$budget_subsidiary_backfill$;

ALTER TABLE public.budget_lines
  ALTER COLUMN subsidiary_id SET NOT NULL;

-- The governed read projection has an explicit column list in the baseline;
-- recreate it so query/report consumers can carry the legal entity through
-- without granting direct access to the tenant-owned table.
DROP VIEW openbooks_query.budget_lines;
CREATE VIEW openbooks_query.budget_lines WITH (security_barrier = true) AS
 SELECT id,
    org_id,
    scenario_id,
    account_id,
    period_id,
    subsidiary_id,
    department_id,
    project_id,
    location_id,
    class_id,
    amount,
    note,
    created_at,
    created_by,
    updated_at,
    updated_by
   FROM public.budget_lines
  WHERE (org_id = public.openbooks_query_org_id());
GRANT SELECT ON TABLE openbooks_query.budget_lines TO openbooks_read;

ALTER TABLE ONLY public.budget_lines
  DROP CONSTRAINT budget_lines_cell;

ALTER TABLE ONLY public.budget_lines
  ADD CONSTRAINT budget_lines_cell
  UNIQUE NULLS NOT DISTINCT
    (scenario_id, account_id, period_id, subsidiary_id,
     department_id, project_id, location_id, class_id);

-- Tenant coherence is enforced at the storage boundary, not by the route.
ALTER TABLE ONLY public.budget_lines
  ADD CONSTRAINT budget_lines_subsidiary_fk
  FOREIGN KEY (org_id, subsidiary_id)
  REFERENCES public.subsidiaries (org_id, id)
  DEFERRABLE;

CREATE INDEX budget_lines_org_subsidiary
  ON public.budget_lines USING btree (org_id, subsidiary_id);

-- Existing worksheet/import callers predate the entity column.  Resolve an
-- omitted entity to the legal entity represented by the tenant root before
-- NOT NULL/FK checks run; callers that provide an entity retain it exactly.
CREATE OR REPLACE FUNCTION public.openbooks_default_budget_subsidiary()
RETURNS trigger
LANGUAGE plpgsql
AS $func$
BEGIN
  IF NEW.subsidiary_id IS NULL THEN
    SELECT s.id
      INTO NEW.subsidiary_id
      FROM public.subsidiaries s
     WHERE s.org_id = NEW.org_id
       AND s.parent_id IS NULL
       AND s.is_active
       AND NOT s.is_elimination
     ORDER BY s.created_at, s.id
     LIMIT 1;
    IF NEW.subsidiary_id IS NULL THEN
      RAISE EXCEPTION 'budget line requires an active root subsidiary for organization %', NEW.org_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$func$;

COMMENT ON FUNCTION public.openbooks_default_budget_subsidiary() IS
  'openbooks:budget_subsidiary:v1 - resolves legacy omitted budget entities to the tenant root before the not-null and tenant-coherent FK checks';

CREATE TRIGGER budget_line_default_subsidiary
  BEFORE INSERT OR UPDATE OF org_id, subsidiary_id
  ON public.budget_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.openbooks_default_budget_subsidiary();

COMMIT;
