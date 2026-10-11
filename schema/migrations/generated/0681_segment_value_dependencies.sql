-- OpenBooks forward migration 0681_segment_value_dependencies.
--
-- Segment value dependencies: a dependent value of one segment (custom or
-- built-in: subsidiary, department, class, location, project) is allowed
-- only together with the listed values of a controlling segment — for
-- example class X only with department A or B. Each row allows one
-- controlling value; the active rows effective on a date for one dependent
-- value and controlling segment form its allowed set, and a value with no
-- such rows stays unrestricted. Rows are optionally effective-dated and the
-- same pairing cannot overlap itself in time. The guard keeps every named
-- value inside its own segment (custom values in segment_values, built-in
-- values in their domain tables). Enforcement happens where documents are
-- saved and journals are posted; posted history is unaffected.
--
-- Backfill: none. The table starts empty, so nothing is restricted until a
-- rule is created.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE IF NOT EXISTS public.segment_value_dependencies (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  segment_id uuid NOT NULL,
  value_id uuid NOT NULL,
  controlling_segment_id uuid NOT NULL,
  allowed_value_id uuid NOT NULL,
  effective_from date,
  effective_to date,
  is_active boolean NOT NULL DEFAULT true,
  description text CHECK (description IS NULL OR length(description) <= 2000),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE (org_id, id),
  CONSTRAINT segment_value_dependencies_distinct_segments CHECK (segment_id <> controlling_segment_id),
  CONSTRAINT segment_value_dependencies_window CHECK (
    effective_from IS NULL OR effective_to IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT segment_value_dependencies_segment_fkey FOREIGN KEY (org_id, segment_id)
    REFERENCES public.segment_definitions(org_id, id) DEFERRABLE,
  CONSTRAINT segment_value_dependencies_controlling_fkey FOREIGN KEY (org_id, controlling_segment_id)
    REFERENCES public.segment_definitions(org_id, id) DEFERRABLE,
  CONSTRAINT segment_value_dependencies_one_pairing EXCLUDE USING gist (
    org_id WITH =, segment_id WITH =, value_id WITH =, controlling_segment_id WITH =, allowed_value_id WITH =,
    daterange(coalesce(effective_from, '-infinity'::date), coalesce(effective_to + 1, 'infinity'::date), '[)') WITH &&
  ) WHERE (is_active)
);
CREATE INDEX IF NOT EXISTS segment_value_dependencies_value
  ON public.segment_value_dependencies (org_id, segment_id, value_id) WHERE is_active;
COMMENT ON TABLE public.segment_value_dependencies IS 'Allowed pairings: a segment value is allowed only with the controlling-segment values its active, effective rows list.';

-- True when the value belongs to the segment definition: custom values in
-- segment_values, built-in values in the domain table named by the
-- definition's storage column.
CREATE OR REPLACE FUNCTION public.segment_definition_has_value(p_org uuid, p_segment uuid, p_value uuid)
 RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = public, pg_catalog AS $$
DECLARE
  v_kind text;
  v_storage text;
BEGIN
  SELECT source_kind, storage_column INTO v_kind, v_storage
    FROM public.segment_definitions WHERE org_id = p_org AND id = p_segment;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_kind = 'custom' THEN
    RETURN EXISTS (SELECT 1 FROM public.segment_values WHERE org_id = p_org AND segment_id = p_segment AND id = p_value);
  END IF;
  RETURN CASE v_storage
    WHEN 'department_id' THEN EXISTS (SELECT 1 FROM public.departments WHERE org_id = p_org AND id = p_value)
    WHEN 'class_id' THEN EXISTS (SELECT 1 FROM public.classes WHERE org_id = p_org AND id = p_value)
    WHEN 'location_id' THEN EXISTS (SELECT 1 FROM public.locations WHERE org_id = p_org AND id = p_value)
    WHEN 'project_id' THEN EXISTS (SELECT 1 FROM public.projects WHERE org_id = p_org AND id = p_value)
    WHEN 'subsidiary_id' THEN EXISTS (SELECT 1 FROM public.subsidiaries WHERE org_id = p_org AND id = p_value)
    ELSE false
  END;
END;
$$;

CREATE OR REPLACE FUNCTION public.segment_value_dependency_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path = public, pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' AND public.openbooks_clone_authority() THEN
    RETURN NEW;
  END IF;
  IF NOT public.segment_definition_has_value(NEW.org_id, NEW.segment_id, NEW.value_id) THEN
    RAISE EXCEPTION 'segment value dependency names value % that does not belong to its segment', NEW.value_id
      USING ERRCODE = '23514';
  END IF;
  IF NOT public.segment_definition_has_value(NEW.org_id, NEW.controlling_segment_id, NEW.allowed_value_id) THEN
    RAISE EXCEPTION 'segment value dependency allows value % that does not belong to the controlling segment', NEW.allowed_value_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS segment_value_dependency_guard ON public.segment_value_dependencies;
CREATE TRIGGER segment_value_dependency_guard
  BEFORE INSERT OR UPDATE OF segment_id, value_id, controlling_segment_id, allowed_value_id ON public.segment_value_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.segment_value_dependency_guard();

ALTER TABLE public.segment_value_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.segment_value_dependencies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON public.segment_value_dependencies;
CREATE POLICY org_isolation ON public.segment_value_dependencies
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));
COMMENT ON POLICY org_isolation ON public.segment_value_dependencies IS 'openbooks:org_isolation:v1';

INSERT INTO public.openbooks_query_catalog_relations(relation, added_in)
 VALUES ('segment_value_dependencies', '0681_segment_value_dependencies')
 ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
