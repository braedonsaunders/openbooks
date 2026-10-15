-- Governed native Field Ticket source-identity certifications.
--
-- A certificate binds one exact native Field Ticket (UUID, document number
-- and revision at certification) to one exact external source ticket
-- (source system and external id). The pinned retained source file, its
-- exact version and hash, and the parsed source row establish which row a
-- human reviewer examined; file membership alone does not prove lineage.
-- The authenticated operator's attestation and reason supply the mapping
-- authority, and the reviewed basis names that honestly.
--
-- Certificates are append-only and certify identity metadata only. They
-- never certify hours, amounts, roles, rates or any later source-charge
-- admission, and the point-in-time native fingerprint is audit evidence,
-- not a freeze on later ordinary approval, billing or source-charge import.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.field_ticket_source_certifications (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 native_document_id uuid NOT NULL,
 native_document_number text NOT NULL,
 native_project_id uuid NOT NULL,
 native_subsidiary_id uuid NOT NULL,
 source_system text NOT NULL,
 source_external_id text NOT NULL,
 source_file_id uuid NOT NULL,
 source_version_id uuid NOT NULL,
 source_file_sha256 text NOT NULL CHECK (source_file_sha256 ~ '^[a-f0-9]{64}$'),
 source_row_sha256 text NOT NULL CHECK (source_row_sha256 ~ '^[a-f0-9]{64}$'),
 source_row_snapshot jsonb NOT NULL,
 attestation text NOT NULL,
 reason text NOT NULL,
 reviewed_basis text NOT NULL,
 reference_map jsonb NOT NULL,
 native_revision_at_certification bigint NOT NULL CHECK (native_revision_at_certification >= 0),
 native_point_in_time jsonb NOT NULL,
 native_fingerprint_sha256 text NOT NULL CHECK (native_fingerprint_sha256 ~ '^[a-f0-9]{64}$'),
 request_id uuid NOT NULL,
 request_payload_sha256 text NOT NULL CHECK (request_payload_sha256 ~ '^[a-f0-9]{64}$'),
 certified_by uuid NOT NULL REFERENCES public.users(id),
 certified_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT field_ticket_source_certifications_org_id_unique UNIQUE (org_id, id),
 CONSTRAINT field_ticket_source_certifications_document_fk
  FOREIGN KEY (org_id, native_document_id) REFERENCES public.documents (org_id, id),
 CONSTRAINT field_ticket_source_certifications_project_fk
  FOREIGN KEY (org_id, native_project_id) REFERENCES public.projects (org_id, id),
 CONSTRAINT field_ticket_source_certifications_subsidiary_fk
  FOREIGN KEY (org_id, native_subsidiary_id) REFERENCES public.subsidiaries (org_id, id),
 CONSTRAINT field_ticket_source_certifications_file_fk
  FOREIGN KEY (org_id, source_file_id) REFERENCES public.files (org_id, id),
 CONSTRAINT field_ticket_source_certifications_version_fk
  FOREIGN KEY (source_file_id, source_version_id) REFERENCES public.file_versions (file_id, id),
 CONSTRAINT field_ticket_source_certifications_identity CHECK (
  source_system ~* '^[a-z0-9][a-z0-9._-]{0,63}$'
  AND char_length(btrim(source_external_id)) BETWEEN 1 AND 200
  AND source_external_id = btrim(source_external_id)
  AND char_length(btrim(native_document_number)) BETWEEN 1 AND 200
 ),
 CONSTRAINT field_ticket_source_certifications_review CHECK (
  reviewed_basis = 'human_reviewed_crosswalk_operator_attestation'
  AND char_length(btrim(attestation)) BETWEEN 8 AND 2000
  AND char_length(btrim(reason)) BETWEEN 8 AND 2000
  AND jsonb_typeof(source_row_snapshot) = 'object'
  AND jsonb_typeof(reference_map) = 'object'
  AND jsonb_typeof(native_point_in_time) = 'object'
 )
);
CREATE UNIQUE INDEX field_ticket_source_certifications_source_unique
 ON public.field_ticket_source_certifications (org_id, source_system, source_external_id);
CREATE UNIQUE INDEX field_ticket_source_certifications_native_unique
 ON public.field_ticket_source_certifications (org_id, native_document_id);
CREATE UNIQUE INDEX field_ticket_source_certifications_request_unique
 ON public.field_ticket_source_certifications (org_id, request_id);
CREATE INDEX field_ticket_source_certifications_native
 ON public.field_ticket_source_certifications (org_id, native_document_id);
CREATE INDEX field_ticket_source_certifications_file
 ON public.field_ticket_source_certifications (org_id, source_file_id, source_version_id);

-- A copied row is admitted only as the registered sandbox source's exact
-- projection: every uuid rebased to the destination identity, its retained
-- evidence rebased through the native clone projection, and in a masked
-- copy the operator's attestation and reason redacted. This predicate
-- grants no authority of its own.
CREATE FUNCTION public.field_ticket_source_certifications_clone_matches(candidate jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target record;
  original jsonb;
  expected jsonb;
  column_row record;
BEGIN
  IF NOT public.openbooks_clone_authority() THEN RETURN false; END IF;
  SELECT org.sandbox_of, org.sandbox_seed, sandbox.masked
    INTO target
    FROM public.orgs org
    JOIN public.sandboxes sandbox
      ON sandbox.org_id = org.id AND sandbox.production_org_id = org.sandbox_of
    JOIN public.orgs production ON production.id = org.sandbox_of AND production.id <> org.id
   WHERE org.id = (candidate->>'org_id')::uuid
     AND org.env_kind = 'sandbox'
     AND org.sandbox_seed IS NOT NULL
     AND sandbox.status IN ('provisioning', 'refreshing');
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT to_jsonb(source)
    INTO original
    FROM public.field_ticket_source_certifications source
   WHERE source.org_id = target.sandbox_of
     AND public.ob_rebase(source.id, target.sandbox_seed) = (candidate->>'id')::uuid;
  IF original IS NULL THEN RETURN false; END IF;

  expected := original;
  FOR column_row IN
    SELECT attribute.attname, attribute.atttypid
      FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid = 'public.field_ticket_source_certifications'::regclass
       AND attribute.attnum > 0 AND NOT attribute.attisdropped
  LOOP
    IF column_row.attname = 'org_id' THEN
      expected := jsonb_set(expected, ARRAY[column_row.attname], to_jsonb((candidate->>'org_id')::uuid));
    ELSIF column_row.atttypid = 'uuid'::regtype
      AND jsonb_typeof(original->column_row.attname) = 'string' THEN
      expected := jsonb_set(expected, ARRAY[column_row.attname], to_jsonb(public.ob_rebase(
        (original->>column_row.attname)::uuid, target.sandbox_seed
      )));
    END IF;
  END LOOP;
  expected := jsonb_set(expected, '{source_row_snapshot}', public.field_ticket_source_certification_clone_evidence(
    original->'source_row_snapshot', target.sandbox_seed, 'source_row_snapshot',
    (candidate->>'org_id')::uuid, target.masked));
  expected := jsonb_set(expected, '{reference_map}', public.field_ticket_source_certification_clone_evidence(
    original->'reference_map', target.sandbox_seed, 'reference_map',
    (candidate->>'org_id')::uuid, target.masked));
  expected := jsonb_set(expected, '{native_point_in_time}', public.field_ticket_source_certification_clone_evidence(
    original->'native_point_in_time', target.sandbox_seed, 'native_point_in_time',
    (candidate->>'org_id')::uuid, target.masked));
  IF target.masked THEN
    expected := jsonb_set(expected, '{attestation}', to_jsonb('REDACTED'::text));
    expected := jsonb_set(expected, '{reason}', to_jsonb('REDACTED'::text));
  END IF;
  RETURN candidate = expected;
END
$function$;

-- The one authoritative clone projection for a certification's retained
-- evidence. The source-row snapshot is external evidence, never a native
-- reference: an unmasked copy retains it exactly, and a masked copy only
-- redacts its prose through the native mask, so a connector's own ticket
-- identity stays byte-identical to the certified external id and row hash.
-- Native evidence rebases through the native evidence projection. A
-- masked copy carries no native point-in-time before-image at all: the
-- whole embedded native snapshot (documents, labor lines and person
-- fields) is tombstoned as masked evidence, while the certificate's
-- fingerprint column keeps its attribution to the original source
-- fingerprint and is never recomputed from the tombstone.
CREATE FUNCTION public.field_ticket_source_certification_clone_evidence(value jsonb, seed uuid, field_name text, target_org uuid, masked boolean)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_catalog
AS $function$
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 IF field_name = 'source_row_snapshot' THEN
  RETURN CASE WHEN masked THEN public.production_mask_evidence(value) ELSE value END;
 END IF;
 IF masked AND field_name = 'native_point_in_time' THEN
  RETURN jsonb_build_object(
   'maskedEvidence', 'REDACTED',
   'fingerprintAttribution', 'native_fingerprint_sha256 retains the original source fingerprint; this masked copy carries no native point-in-time before-image');
 END IF;
 RETURN public.production_clone_safe_evidence(value, seed, field_name, target_org, masked);
END
$function$;

-- Storage proves the certificate names the native ticket it certifies: a
-- Field Ticket document with the same number, project and legal entity, a
-- native Field Ticket header, and the exact retained file version whose
-- recorded hash is the pinned file hash. The governing service re-reads the
-- actual bytes and the parsed row; this guard keeps direct storage writes
-- from certifying a ticket or file that does not cohere. No row may be
-- updated or deleted outside the approved tenant-retirement and
-- sandbox-wipe controls.
CREATE FUNCTION public.field_ticket_source_certification_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 IF TG_OP = 'INSERT' AND public.field_ticket_source_certifications_clone_matches(to_jsonb(NEW)) THEN
  RETURN NEW;
 END IF;
 IF TG_OP = 'DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
     OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
   RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Field Ticket source-identity certifications are append-only; a certification cannot be deleted'
   USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  RAISE EXCEPTION 'Field Ticket source-identity certifications are append-only; a certification cannot be replaced'
   USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.documents
   WHERE org_id = NEW.org_id AND id = NEW.native_document_id AND kind = 'field_ticket'
     AND document_number = NEW.native_document_number
     AND project_id = NEW.native_project_id
     AND subsidiary_id = NEW.native_subsidiary_id) THEN
  RAISE EXCEPTION 'A Field Ticket source-identity certification requires the exact native ticket, number, project and legal entity in this organization'
   USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.field_tickets
   WHERE org_id = NEW.org_id AND document_id = NEW.native_document_id) THEN
  RAISE EXCEPTION 'A Field Ticket source-identity certification requires the native Field Ticket header in this organization'
   USING ERRCODE = '23514';
 END IF;
 IF EXISTS (SELECT 1 FROM public.documents
   WHERE org_id = NEW.org_id AND kind = 'field_ticket' AND id <> NEW.native_document_id
     AND custom->'source'->>'system' = NEW.source_system
     AND custom->'source'->>'externalId' = NEW.source_external_id) THEN
  RAISE EXCEPTION 'This source ticket is already represented by another native Field Ticket; reconcile the duplicate source representation before certifying'
   USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.files file
   JOIN public.file_versions version ON version.file_id = file.id
   WHERE file.org_id = NEW.org_id AND file.id = NEW.source_file_id AND NOT file.is_inactive
     AND version.id = NEW.source_version_id AND version.content_hash = NEW.source_file_sha256) THEN
  RAISE EXCEPTION 'A Field Ticket source-identity certification requires the exact active retained source file version and hash in this organization'
   USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END
$function$;

CREATE TRIGGER field_ticket_source_certification_guard
 BEFORE INSERT OR UPDATE OR DELETE ON public.field_ticket_source_certifications
 FOR EACH ROW EXECUTE FUNCTION public.field_ticket_source_certification_guard();

CREATE FUNCTION public.field_ticket_source_certification_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 -- A copied row's provenance is its exact source match, not a new certification.
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
 VALUES (NEW.org_id, 'field_ticket_source_certifications', NEW.id, 'insert',
   jsonb_build_object('after', to_jsonb(NEW), 'reason', NEW.reason,
     'basis', NEW.reviewed_basis, 'requestId', NEW.request_id), NEW.certified_by);
 RETURN NEW;
END
$function$;

CREATE TRIGGER field_ticket_source_certification_audit
 AFTER INSERT ON public.field_ticket_source_certifications
 FOR EACH ROW EXECUTE FUNCTION public.field_ticket_source_certification_audit();

-- The stored source marker on a Field Ticket document may be set, but
-- never removed, partially set, or moved to another source identity,
-- except as the exact projection of a governed certification for that
-- ticket. Source-born documents created by the native importer are
-- inserted with their marker and are not affected; every other custom
-- change passes unchanged.
CREATE FUNCTION public.field_ticket_source_projection_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE
 old_system text;
 old_external text;
 new_system text;
 new_external text;
BEGIN
 IF NEW.kind <> 'field_ticket' AND OLD.kind <> 'field_ticket' THEN RETURN NEW; END IF;
 old_system := CASE WHEN jsonb_typeof(OLD.custom->'source') = 'object' THEN OLD.custom->'source'->>'system' END;
 old_external := CASE WHEN jsonb_typeof(OLD.custom->'source') = 'object' THEN OLD.custom->'source'->>'externalId' END;
 new_system := CASE WHEN jsonb_typeof(NEW.custom->'source') = 'object' THEN NEW.custom->'source'->>'system' END;
 new_external := CASE WHEN jsonb_typeof(NEW.custom->'source') = 'object' THEN NEW.custom->'source'->>'externalId' END;
 IF (new_system, new_external) IS NOT DISTINCT FROM (old_system, old_external) THEN RETURN NEW; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.field_ticket_source_certifications
   WHERE org_id = NEW.org_id AND native_document_id = NEW.id
     AND source_system = new_system AND source_external_id = new_external) THEN
  RAISE EXCEPTION 'Field Ticket source identity may be set only from its governed source-identity certification; certify the ticket through the native certification command before projecting a source marker'
   USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END
$function$;

CREATE TRIGGER field_ticket_source_projection_guard
 BEFORE UPDATE OF custom ON public.documents
 FOR EACH ROW EXECUTE FUNCTION public.field_ticket_source_projection_guard();

-- The certificate is inserted before its projection, so coherence is
-- judged at commit: by then the native ticket must carry the exact
-- certified source marker and the governed document audit for this
-- request. A copied certification is admitted by its exact sandbox
-- projection above and is exempt from this service-order check.
CREATE FUNCTION public.field_ticket_source_certification_projection_commit() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 IF public.openbooks_clone_authority() THEN RETURN NULL; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.documents
   WHERE org_id = NEW.org_id AND id = NEW.native_document_id AND kind = 'field_ticket'
     AND custom->'source'->>'system' = NEW.source_system
     AND custom->'source'->>'externalId' = NEW.source_external_id) THEN
  RAISE EXCEPTION 'A Field Ticket source-identity certification must commit with its exact source projection on the native ticket'
   USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.audit_log
   WHERE org_id = NEW.org_id AND table_name = 'documents' AND row_id = NEW.native_document_id
     AND action = 'update' AND actor_id = NEW.certified_by AND request_id = NEW.request_id::text
     AND changes->>'reason' = 'field_ticket_source_identity_certification'
     AND changes->>'certificationId' = NEW.id::text) THEN
  RAISE EXCEPTION 'A Field Ticket source-identity certification must commit with its governed document audit'
   USING ERRCODE = '23514';
 END IF;
 RETURN NULL;
END
$function$;

CREATE CONSTRAINT TRIGGER field_ticket_source_certification_projection_commit
 AFTER INSERT ON public.field_ticket_source_certifications
 DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.field_ticket_source_certification_projection_commit();

ALTER TABLE public.field_ticket_source_certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.field_ticket_source_certifications FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.field_ticket_source_certifications
 USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
 WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.field_ticket_source_certifications IS 'openbooks:org_isolation:v1';
CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.field_ticket_source_certifications
 FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
COMMENT ON TABLE public.field_ticket_source_certifications IS
 'Append-only human-reviewed bindings between native Field Tickets and exact external source tickets, pinned to a retained source file version and parsed row; native certification readers own access, so the table stays out of the generic governed-query catalog. Sandbox copies retain the binding with rebased identities and redacted attestation and reason.';

SELECT public.openbooks_refresh_query_catalog();
