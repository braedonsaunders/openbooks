-- Require canonical Flow decisions for new close-run approvals and locking.
-- Retained closed periods and published evidence remain unchanged.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE FUNCTION public.close_run_flow_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
  IF NEW.status IN('approved','closed','published') THEN
   RAISE EXCEPTION 'Create the close run and submit its current evidence through Flows before release.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.status='approved' AND OLD.status IS DISTINCT FROM NEW.status THEN
  IF OLD.status<>'review' OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL
    OR NEW.approved_by IS DISTINCT FROM NEW.updated_by
    OR NOT public.flow_subject_decision_authorized(NEW.org_id,'close_run',NEW.id,NEW.approved_by,
      public.close_run_approval_fingerprint(OLD.org_id,OLD.id),'approved') THEN
   RAISE EXCEPTION 'Submit the close run and complete every configured Flow gate before approval.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status IN('approved','closed','published') AND (ROW(NEW.id,NEW.org_id,NEW.period_id,NEW.book_id,NEW.blueprint_id,NEW.scope,NEW.started_by)
    IS DISTINCT FROM ROW(OLD.id,OLD.org_id,OLD.period_id,OLD.book_id,OLD.blueprint_id,OLD.scope,OLD.started_by)
    OR NEW.status='approved' AND NEW.data_fingerprint IS DISTINCT FROM OLD.data_fingerprint) THEN
  RAISE EXCEPTION 'Revalidate the close run and submit its changed terms through Flows.' USING ERRCODE='23514';
 END IF;
 IF OLD.status='approved' AND NEW.status='approved' AND ROW(NEW.approved_by,NEW.approved_at)
    IS DISTINCT FROM ROW(OLD.approved_by,OLD.approved_at) THEN
  RAISE EXCEPTION 'The recorded close decision retains its actual actor and timestamp.' USING ERRCODE='23514';
 END IF;
 IF NEW.status='closed' AND OLD.status IS DISTINCT FROM NEW.status THEN
  IF OLD.status<>'approved' OR NEW.closed_by IS NULL OR NEW.closed_at IS NULL
    OR NEW.closed_by IS DISTINCT FROM NEW.updated_by
    OR NOT public.flow_subject_decision_authorized(OLD.org_id,'close_run',OLD.id,OLD.approved_by,
      public.close_run_approval_fingerprint(OLD.org_id,OLD.id),'approved') THEN
   RAISE EXCEPTION 'Lock only a close run with its retained current Flow approval.' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(NEW.scope->'subsidiaryIds')='array'
      AND jsonb_array_length(NEW.scope->'subsidiaryIds')>0 THEN NEW.scope->'subsidiaryIds' ELSE '[null]'::jsonb END) entity(id)
    CROSS JOIN unnest(ARRAY['ar','ap','banking','assets','tax','gl']) module(name)
    WHERE NOT EXISTS(SELECT 1 FROM public.period_locks l WHERE l.org_id=NEW.org_id AND l.period_id=NEW.period_id
      AND l.book_id=NEW.book_id AND l.subsidiary_id IS NOT DISTINCT FROM entity.id::uuid AND l.module=module.name
      AND l.state='closed' AND (l.reopen_expires_at IS NULL OR l.reopen_expires_at<=now()))) THEN
   RAISE EXCEPTION 'Close the run through its native command so every scoped subledger and GL lock seals atomically.' USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.status='published' AND OLD.status IS DISTINCT FROM NEW.status AND
    (OLD.status<>'closed' OR NEW.published_by IS NULL OR NEW.published_at IS NULL OR NEW.published_by IS DISTINCT FROM NEW.updated_by) THEN
  RAISE EXCEPTION 'Publish only the retained closed run through its native publication command.' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER close_run_flow_guard BEFORE INSERT OR UPDATE ON public.close_runs
 FOR EACH ROW EXECUTE FUNCTION public.close_run_flow_guard();
