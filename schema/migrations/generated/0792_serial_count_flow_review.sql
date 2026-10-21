-- Bind posted serial-count observations to the tenant's retained Flow review policy.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE OR REPLACE FUNCTION public.inventory_serial_count_posted_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=public,pg_catalog AS $$
BEGIN
 IF NEW.serial_id IS NULL OR NEW.adjustment_movement_id IS NULL THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' AND public.openbooks_clone_authority() THEN
  IF public.inventory_serial_count_clone_line_matches(NEW) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Copied serial count evidence must retain its exact registered source identity and observations';
 END IF;
 IF TG_OP='UPDATE' AND NEW.adjustment_movement_id IS NOT DISTINCT FROM OLD.adjustment_movement_id THEN RETURN NEW; END IF;
 IF NOT public.inventory_serial_count_line_matches(NEW.org_id,NEW.id,NEW.adjustment_movement_id,true)
    OR NOT EXISTS(
     SELECT 1 FROM public.stock_count_lines line
     JOIN public.stock_counts count ON count.org_id=line.org_id AND count.id=line.stock_count_id
     JOIN public.inventory_movements movement ON movement.org_id=line.org_id AND movement.id=line.adjustment_movement_id
     JOIN public.audit_log audit ON audit.org_id=count.org_id AND audit.table_name='stock_counts' AND audit.row_id=count.id
     WHERE line.org_id=NEW.org_id AND line.id=NEW.id AND movement.id=NEW.adjustment_movement_id
      AND movement.xmin=(pg_current_xact_id()::text::bigint % 4294967296)::text::xid
      AND audit.xmin=movement.xmin AND audit.changes->>'operation'='post'
      AND audit.actor_id=movement.created_by AND audit.changes->'review'->>'postedBy'=audit.actor_id::text
      AND count.updated_by=audit.actor_id AND count.review_released
      AND audit.changes->'review'->'policy'=count.submission_policy
      AND EXISTS(SELECT 1 FROM public.flow_submissions submission
        WHERE submission.org_id=count.org_id AND submission.subject_kind='stock_count'
          AND submission.subject_id=count.id AND submission.policy=count.submission_policy
          AND ((submission.policy->>'kind'='ungated' AND
            public.flow_ungated_submission_authorized(submission.org_id,submission.subject_kind,submission.subject_id,count.submitted_by))
           OR (submission.policy->>'kind'='gated' AND
            public.flow_submission_approved(submission.org_id,submission.subject_kind,submission.subject_id,submission.id))))
    ) THEN
  RAISE EXCEPTION 'Serial count adjustment requires exact posted count, journal and tenant Flow review evidence';
 END IF;
 RETURN NEW;
END $$;
