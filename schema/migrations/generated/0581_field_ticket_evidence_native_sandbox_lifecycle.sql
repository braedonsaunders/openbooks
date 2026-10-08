-- Preserve Field Ticket labor revisions and signatures through native sandbox
-- copying and teardown. Ordinary evidence retention and updates stay guarded.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- The source lookup uses the document-number, snapshot-revision and line
-- sequence keys. Every stored field and rebased reference must match; copying
-- a retired revision cannot authorize new or altered historical labor.
CREATE FUNCTION public.field_ticket_historical_labor_line_matches(candidate public.field_ticket_labor_lines)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_catalog AS $function$
 SELECT EXISTS (
  SELECT 1 FROM public.orgs target
  JOIN public.sandboxes control ON control.org_id=target.id AND control.production_org_id=target.sandbox_of
  JOIN public.orgs source ON source.id=target.sandbox_of
  JOIN public.documents copied_ticket ON copied_ticket.org_id=target.id AND copied_ticket.id=(candidate).field_ticket_id
  JOIN public.documents original_ticket ON original_ticket.org_id=source.id
   AND original_ticket.kind='field_ticket' AND original_ticket.document_number=copied_ticket.document_number
  JOIN public.field_ticket_labor_snapshots copied_snapshot ON copied_snapshot.org_id=target.id
   AND copied_snapshot.id=(candidate).snapshot_id AND copied_snapshot.field_ticket_id=copied_ticket.id
  JOIN public.field_ticket_labor_snapshots original_snapshot ON original_snapshot.org_id=source.id
   AND original_snapshot.field_ticket_id=original_ticket.id AND original_snapshot.revision=copied_snapshot.revision
  JOIN public.field_ticket_labor_lines original ON original.org_id=source.id
   AND original.snapshot_id=original_snapshot.id AND original.sequence=(candidate).sequence
  WHERE public.openbooks_clone_authority() AND target.id=(candidate).org_id
   AND target.env_kind='sandbox' AND target.sandbox_seed IS NOT NULL
   AND public.ob_rebase(original_ticket.id,target.sandbox_seed)=copied_ticket.id
   AND original_snapshot.superseded_at IS NOT NULL
   AND to_jsonb(copied_snapshot)=to_jsonb(original_snapshot)||jsonb_build_object(
    'id',public.ob_rebase(original_snapshot.id,target.sandbox_seed),'org_id',target.id,
    'field_ticket_id',public.ob_rebase(original_snapshot.field_ticket_id,target.sandbox_seed),
    'captured_by',public.ob_rebase(original_snapshot.captured_by,target.sandbox_seed),
    'superseded_by',public.ob_rebase(original_snapshot.superseded_by,target.sandbox_seed))
   AND to_jsonb(candidate)=to_jsonb(original)||jsonb_build_object(
    'id',public.ob_rebase(original.id,target.sandbox_seed),'org_id',target.id,
    'snapshot_id',public.ob_rebase(original.snapshot_id,target.sandbox_seed),
    'field_ticket_id',public.ob_rebase(original.field_ticket_id,target.sandbox_seed),
    'employee_party_id',public.ob_rebase(original.employee_party_id,target.sandbox_seed),
    'item_id',public.ob_rebase(original.item_id,target.sandbox_seed),
    'time_type_id',public.ob_rebase(original.time_type_id,target.sandbox_seed),
    'project_task_id',public.ob_rebase(original.project_task_id,target.sandbox_seed),
    'time_entry_id',public.ob_rebase(original.time_entry_id,target.sandbox_seed),
    'created_by',public.ob_rebase(original.created_by,target.sandbox_seed))
 );
$function$;

CREATE OR REPLACE FUNCTION public.field_ticket_labor_line_integrity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
DECLARE
  linked_time time_entries%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM field_ticket_labor_snapshots snapshot
     WHERE snapshot.id = new.snapshot_id
       AND snapshot.org_id = new.org_id
       AND snapshot.field_ticket_id = new.field_ticket_id
       AND snapshot.superseded_at IS NULL
  ) AND NOT (TG_OP = 'INSERT' AND public.field_ticket_historical_labor_line_matches(NEW)) THEN
    RAISE EXCEPTION
      'field ticket labor line must belong to the current snapshot and ticket in the same organization'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM parties p
     WHERE p.id = new.employee_party_id AND p.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION 'field ticket labor employee must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;
  IF new.item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM items i WHERE i.id = new.item_id AND i.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION 'field ticket labor item must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;
  IF new.time_type_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM time_types tt
     WHERE tt.id = new.time_type_id AND tt.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION 'field ticket labor time type must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;
  IF new.project_task_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM project_tasks pt
      JOIN documents d
        ON d.id = new.field_ticket_id
       AND d.org_id = pt.org_id
       AND d.project_id = pt.project_id
     WHERE pt.id = new.project_task_id
       AND pt.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION 'field ticket labor task must belong to the ticket project'
      USING ERRCODE = '23514';
  END IF;
  IF new.created_by IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.id = new.created_by AND u.org_id = new.org_id
  ) THEN
    RAISE EXCEPTION 'field ticket labor line actor must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;

  -- An optional link means exact atomic provenance, not a fuzzy association.
  IF new.time_entry_id IS NOT NULL THEN
    SELECT * INTO linked_time
      FROM time_entries te
     WHERE te.id = new.time_entry_id
       AND te.org_id = new.org_id;
    IF NOT FOUND
       OR linked_time.field_ticket_id IS DISTINCT FROM new.field_ticket_id
       OR linked_time.employee_party_id IS DISTINCT FROM new.employee_party_id
       OR linked_time.item_id IS DISTINCT FROM new.item_id
       OR linked_time.time_type_id IS DISTINCT FROM new.time_type_id
       OR linked_time.project_task_id IS DISTINCT FROM new.project_task_id
       OR linked_time.worked_on IS DISTINCT FROM new.worked_on
       OR linked_time.hours IS DISTINCT FROM new.hours
    THEN
      RAISE EXCEPTION
        'field ticket labor time-entry provenance must be an exact line on the same ticket'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN new;
END
$function$;

CREATE OR REPLACE FUNCTION public.field_ticket_labor_line_immutable_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND public.openbooks_sandbox_wipe_allowed(OLD.org_id)
     AND current_setting('openbooks.migration', true) = 'on'
     AND current_setting('openbooks.amend', true) = 'on'
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname = current_user AND rolbypassrls)
     AND EXISTS (SELECT 1 FROM public.orgs target
                  JOIN public.sandboxes control
                    ON control.org_id = target.id
                   AND control.production_org_id = target.sandbox_of
                  JOIN public.orgs source ON source.id = target.sandbox_of
                 WHERE target.id = OLD.org_id AND target.env_kind = 'sandbox') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'field ticket labor snapshot lines are append-only evidence';
END
$function$;

CREATE OR REPLACE FUNCTION public.field_ticket_labor_snapshot_retention_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND public.openbooks_sandbox_wipe_allowed(OLD.org_id)
     AND current_setting('openbooks.migration', true) = 'on'
     AND current_setting('openbooks.amend', true) = 'on'
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname = current_user AND rolbypassrls)
     AND EXISTS (SELECT 1 FROM public.orgs target
                  JOIN public.sandboxes control
                    ON control.org_id = target.id
                   AND control.production_org_id = target.sandbox_of
                  JOIN public.orgs source ON source.id = target.sandbox_of
                 WHERE target.id = OLD.org_id AND target.env_kind = 'sandbox') THEN
    RETURN OLD;
  END IF;
  IF tg_op = 'DELETE' THEN
    RAISE EXCEPTION 'field ticket labor snapshots are retained evidence';
  END IF;
  IF row(new.org_id, new.field_ticket_id, new.revision, new.evidence_basis,
         new.reason, new.source_system, new.source_payload_hash, new.currency,
         new.captured_by, new.captured_at)
     IS DISTINCT FROM
     row(old.org_id, old.field_ticket_id, old.revision, old.evidence_basis,
         old.reason, old.source_system, old.source_payload_hash, old.currency,
         old.captured_by, old.captured_at)
  THEN
    RAISE EXCEPTION 'field ticket labor snapshot evidence is immutable';
  END IF;
  IF old.superseded_at IS NOT NULL
     AND row(new.superseded_at, new.superseded_by)
         IS DISTINCT FROM row(old.superseded_at, old.superseded_by)
  THEN
    RAISE EXCEPTION 'field ticket labor snapshot supersession is immutable once recorded';
  END IF;
  IF old.superseded_at IS NULL
     AND (new.superseded_at IS NULL OR new.superseded_by IS NULL)
  THEN
    RAISE EXCEPTION 'field ticket labor snapshot may only change through a complete supersession';
  END IF;
  RETURN new;
END
$function$;

CREATE OR REPLACE FUNCTION public.field_ticket_signature_immutable_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_catalog AS $function$
begin
  IF TG_OP = 'DELETE'
     AND public.openbooks_sandbox_wipe_allowed(OLD.org_id)
     AND current_setting('openbooks.migration', true) = 'on'
     AND current_setting('openbooks.amend', true) = 'on'
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                  WHERE rolname = current_user AND rolbypassrls)
     AND EXISTS (SELECT 1 FROM public.orgs target
                  JOIN public.sandboxes control
                    ON control.org_id = target.id
                   AND control.production_org_id = target.sandbox_of
                  JOIN public.orgs source ON source.id = target.sandbox_of
                 WHERE target.id = OLD.org_id AND target.env_kind = 'sandbox') THEN
    RETURN OLD;
  END IF;
  raise exception 'field ticket signatures are append-only evidence';
end $function$;

