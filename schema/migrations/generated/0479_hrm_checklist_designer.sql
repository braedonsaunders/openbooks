SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

-- Versioned checklist publication and execution evidence. Existing templates
-- remain usable until adopted by the designer; opened checklists retain history.
ALTER TABLE public.hrm_process_templates
  ADD COLUMN designer_managed boolean NOT NULL DEFAULT false,
  ADD COLUMN draft_document jsonb,
  ADD COLUMN draft_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN published_version integer NOT NULL DEFAULT 0,
  ADD COLUMN published_revision integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT hrm_process_templates_draft_revision CHECK (draft_revision >= 0 AND published_version >= 0 AND published_revision >= 0 AND published_revision <= draft_revision);
ALTER TABLE public.hrm_process_template_steps ADD COLUMN design jsonb NOT NULL DEFAULT '{}'::jsonb, ADD COLUMN is_current boolean NOT NULL DEFAULT true;
ALTER TABLE public.hrm_processes ADD COLUMN template_version integer NOT NULL DEFAULT 0;
ALTER TABLE public.hrm_process_steps
  ADD COLUMN design jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN response jsonb,
  ADD COLUMN approval_status text NOT NULL DEFAULT 'none' CHECK (approval_status IN ('none','pending','approved','rejected')),
  ADD COLUMN submitted_by uuid,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN flow_run_id uuid,
  ADD COLUMN reminder_sent_on date;
CREATE UNIQUE INDEX users_org_id_checklist_identity ON public.users(org_id,id);
CREATE UNIQUE INDEX flow_runs_org_id_checklist_identity ON public.flow_runs(org_id,id);
ALTER TABLE public.hrm_process_steps
  ADD CONSTRAINT hrm_checklist_submitter_org_fk FOREIGN KEY(org_id,submitted_by) REFERENCES public.users(org_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT hrm_checklist_flow_run_org_fk FOREIGN KEY(org_id,flow_run_id) REFERENCES public.flow_runs(org_id,id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX hrm_process_templates_org_id_identity ON public.hrm_process_templates(org_id,id);
CREATE TABLE public.hrm_process_template_versions (
  id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
  template_id uuid NOT NULL, version integer NOT NULL CHECK (version > 0), document jsonb NOT NULL,
  published_by uuid NOT NULL, published_at timestamptz NOT NULL DEFAULT now(), reason text NOT NULL CHECK(length(btrim(reason)) > 0),
  UNIQUE(org_id,template_id,version),
  FOREIGN KEY(org_id,published_by) REFERENCES public.users(org_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(org_id,template_id) REFERENCES public.hrm_process_templates(org_id,id) ON DELETE RESTRICT
);
ALTER TABLE public.hrm_process_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hrm_process_template_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.hrm_process_template_versions
  USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org',true)))
  WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.hrm_process_template_versions IS 'openbooks:org_isolation:v1';
CREATE FUNCTION public.hrm_checklist_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Published checklist versions are immutable. Publish a new revision instead.'; END $$;
CREATE TRIGGER hrm_checklist_version_immutable BEFORE UPDATE OR DELETE ON public.hrm_process_template_versions
  FOR EACH ROW EXECUTE FUNCTION public.hrm_checklist_version_immutable();
-- Generic Setup and legacy step endpoints cannot rewrite a designer publication.
-- The publication service marks its transaction after validating the whole draft.
CREATE FUNCTION public.hrm_checklist_publication_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE managed boolean;
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'hrm_process_templates' THEN
    managed := OLD.designer_managed;
    IF managed AND (NEW.kind,NEW.name,NEW.applies_to,NEW.is_active) IS DISTINCT FROM (OLD.kind,OLD.name,OLD.applies_to,OLD.is_active)
      AND current_setting('app.checklist_publish',true) IS DISTINCT FROM OLD.id::text THEN
      RAISE EXCEPTION 'Edit this checklist in HRM Checklist templates and publish its draft, or use Retire template there.';
    END IF;
    RETURN NEW;
  END IF;
  SELECT designer_managed INTO managed FROM public.hrm_process_templates
    WHERE org_id = COALESCE(NEW.org_id,OLD.org_id) AND id = COALESCE(NEW.template_id,OLD.template_id);
  IF managed AND current_setting('app.checklist_publish',true) IS DISTINCT FROM COALESCE(NEW.template_id,OLD.template_id)::text THEN
    RAISE EXCEPTION 'Edit steps in HRM Checklist templates and publish the complete draft instead.';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE TRIGGER hrm_checklist_publication_guard BEFORE UPDATE ON public.hrm_process_templates
  FOR EACH ROW EXECUTE FUNCTION public.hrm_checklist_publication_guard();
CREATE TRIGGER hrm_checklist_step_publication_guard BEFORE INSERT OR UPDATE OR DELETE ON public.hrm_process_template_steps
  FOR EACH ROW EXECUTE FUNCTION public.hrm_checklist_publication_guard();
CREATE INDEX hrm_checklist_pending_approval ON public.hrm_process_steps(org_id,approval_status) WHERE approval_status='pending';
COMMENT ON TABLE public.hrm_process_template_versions IS 'Immutable published checklist definitions. Drafts live on their template; execution snapshots live on each checklist.';

-- Execution instructions and reviewed evidence cannot be reinterpreted in place.
CREATE FUNCTION public.hrm_checklist_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF public.app_bypass_rls_active() AND coalesce(current_setting('openbooks.amend',true),'off')='on' THEN RETURN NEW; END IF;
  IF NEW.design IS DISTINCT FROM OLD.design THEN
    RAISE EXCEPTION 'Checklist instructions are a snapshot. Start a new checklist from a published template instead.';
  END IF;
  IF (OLD.status IN ('done','skipped') OR OLD.approval_status IN ('pending','approved')) AND
    (NEW.response,NEW.attachment_id,NEW.submitted_by,NEW.submitted_at) IS DISTINCT FROM (OLD.response,OLD.attachment_id,OLD.submitted_by,OLD.submitted_at) THEN
    IF OLD.approval_status='pending' AND OLD.status='pending' THEN
      RAISE EXCEPTION 'Submitted checklist evidence is immutable. Wait for a rejection before submitting corrected evidence.';
    END IF;
    RAISE EXCEPTION 'Reviewed or completed checklist evidence is immutable. Ask HR to cancel the open checklist and start a corrected one, or start a new checklist if it is closed.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hrm_checklist_execution_guard BEFORE UPDATE ON public.hrm_process_steps
  FOR EACH ROW EXECUTE FUNCTION public.hrm_checklist_execution_guard();
