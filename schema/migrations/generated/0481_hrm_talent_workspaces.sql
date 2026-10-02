-- Persist review authoring drafts and capture the published configuration at launch.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.hrm_review_templates
  ADD COLUMN draft_document jsonb,
  ADD COLUMN published_document jsonb,
  ADD COLUMN published_version integer NOT NULL DEFAULT 0 CHECK (published_version >= 0),
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE public.hrm_review_cycles
  ADD COLUMN require_manager_reviews boolean NOT NULL DEFAULT false,
  ADD COLUMN template_version integer,
  ADD COLUMN rating_scale_snapshot jsonb,
  ADD COLUMN template_document_snapshot jsonb,
  ADD COLUMN reviewer_assignments jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE public.hrm_reviews
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  ADD COLUMN draft_saved_at timestamptz;
-- Historical answers already contain captured prompts. The scale used by the
-- previous service was the current template scale; freeze that effective scale
-- at the upgrade boundary, with explicit evidence of its provenance.
UPDATE public.hrm_review_cycles c SET rating_scale_snapshot = t.rating_scale,
  template_document_snapshot = jsonb_build_object('sections',
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'title',s.title,'kind',s.kind,'weight',s.weight::text,'competencyId',s.competency_id,'position',s.position) ORDER BY s.position),'[]'::jsonb)
     FROM public.hrm_review_template_sections s WHERE s.org_id=c.org_id AND s.template_id=c.template_id))
FROM public.hrm_review_templates t
WHERE t.org_id = c.org_id AND t.id = c.template_id AND c.status <> 'draft';
INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
SELECT org_id, 'hrm_review_cycles', id, 'update',
  jsonb_build_object('event','review_scale_frozen_at_upgrade',
    'before',jsonb_build_object('ratingScaleSnapshot',NULL),
    'after',jsonb_build_object('ratingScaleSnapshot',rating_scale_snapshot,'templateDocumentSnapshot',template_document_snapshot),
    'reason','Freeze the scale previously resolved from the template; original launch-time scale and competency mapping were not stored.'), NULL
FROM public.hrm_review_cycles WHERE status <> 'draft';

ALTER TABLE public.hrm_review_events DROP CONSTRAINT hrm_review_events_kind;
ALTER TABLE public.hrm_review_events ADD CONSTRAINT hrm_review_events_kind
  CHECK (kind IN ('instantiated','submitted','calibrated','shared','acknowledged','reopened','draft_saved'));
