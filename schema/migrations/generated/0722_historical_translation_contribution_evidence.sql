-- Retain approved historical equity contribution layers against exact physical journal sources.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.historical_translation_contributions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 change_id uuid NOT NULL, source_line_id uuid NOT NULL, source_entry_id uuid NOT NULL,
 book_id uuid NOT NULL, account_id uuid NOT NULL, subsidiary_id uuid NOT NULL,
 measurement_currency text NOT NULL REFERENCES public.currencies(code),
 presentation_currency text NOT NULL REFERENCES public.currencies(code),
 source_amount numeric(19,4) NOT NULL CHECK(source_amount<>0), posting_date date NOT NULL,
 kind text NOT NULL CHECK(kind IN('contribution','opening','correction')),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),
 evidence_hash text NOT NULL CHECK(evidence_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL,
 UNIQUE(org_id,id), UNIQUE(org_id,change_id), UNIQUE(org_id,source_line_id,presentation_currency),
 FOREIGN KEY(org_id,change_id) REFERENCES public.financial_changes(org_id,id),
 FOREIGN KEY(org_id,source_line_id) REFERENCES public.journal_lines(org_id,id),
 FOREIGN KEY(org_id,source_entry_id) REFERENCES public.journal_entries(org_id,id),
 FOREIGN KEY(org_id,book_id) REFERENCES public.accounting_books(org_id,id),
 FOREIGN KEY(org_id,account_id) REFERENCES public.accounts(org_id,id),
 FOREIGN KEY(org_id,subsidiary_id) REFERENCES public.subsidiaries(org_id,id),
 FOREIGN KEY(created_by) REFERENCES public.users(id)
);
CREATE TABLE public.historical_translation_layers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 basis_id uuid NOT NULL, layer_number integer NOT NULL CHECK(layer_number BETWEEN 1 AND 200),
 amount numeric(19,4) NOT NULL CHECK(amount<>0), translated_amount numeric(38,14) NOT NULL,
 rate numeric(19,10) NOT NULL CHECK(rate>0),
 historical_date date NOT NULL, provenance text NOT NULL CHECK(length(btrim(provenance)) BETWEEN 8 AND 2000),
 source_file_id uuid NOT NULL, source_version_id uuid NOT NULL,
 source_hash text NOT NULL CHECK(source_hash ~ '^[a-f0-9]{64}$'),
 source_version_number integer NOT NULL CHECK(source_version_number>0), original_layer_id uuid,
 UNIQUE(org_id,id), UNIQUE(org_id,basis_id,layer_number), UNIQUE(org_id,basis_id,original_layer_id),
 FOREIGN KEY(org_id,basis_id) REFERENCES public.historical_translation_contributions(org_id,id),
 FOREIGN KEY(org_id,source_file_id) REFERENCES public.files(org_id,id),
 FOREIGN KEY(source_file_id,source_version_id) REFERENCES public.file_versions(file_id,id),
 FOREIGN KEY(org_id,original_layer_id) REFERENCES public.historical_translation_layers(org_id,id)
);
CREATE INDEX historical_translation_layers_original ON public.historical_translation_layers(org_id,original_layer_id)
 WHERE original_layer_id IS NOT NULL;

CREATE FUNCTION public.historical_translation_source_fingerprint(source_org uuid, source_line uuid) RETURNS jsonb
 LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $function$
 SELECT jsonb_build_object('orgId',line.org_id::text,'lineId',line.id::text,'entryId',line.entry_id::text,
   'bookId',entry.book_id::text,'accountId',line.account_id::text,'subsidiaryId',line.subsidiary_id::text,
   'amount',line.amount::text,'transactionCurrency',line.currency,'transactionAmount',line.txn_amount::text,
   'transactionRate',line.fx_rate::text,'postingDate',entry.posting_date::text,'origin',entry.origin,
   'reversesEntryId',entry.reverses_entry_id::text)
 FROM public.journal_lines line JOIN public.journal_entries entry ON entry.org_id=line.org_id AND entry.id=line.entry_id
 WHERE line.org_id=source_org AND line.id=source_line
 $function$;

CREATE FUNCTION public.historical_translation_basis_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
 DECLARE proposal public.financial_changes%ROWTYPE; physical public.journal_lines%ROWTYPE;
         entry public.journal_entries%ROWTYPE; instruction jsonb;
 BEGIN
  IF TG_OP<>'INSERT' THEN
   IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
     OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
   RAISE EXCEPTION 'Approved historical contribution evidence is immutable; preserve it and use governed source reversals.';
  END IF;
  SELECT * INTO STRICT physical FROM public.journal_lines WHERE org_id=NEW.org_id AND id=NEW.source_line_id FOR UPDATE;
  SELECT * INTO STRICT entry FROM public.journal_entries WHERE org_id=NEW.org_id AND id=physical.entry_id FOR SHARE;
  SELECT * INTO STRICT proposal FROM public.financial_changes WHERE org_id=NEW.org_id AND id=NEW.change_id FOR SHARE;
  instruction:=NEW.evidence->'instruction';
  IF EXISTS(SELECT 1 FROM public.historical_translation_contributions WHERE org_id=NEW.org_id AND source_line_id=NEW.source_line_id
    AND measurement_currency<>NEW.measurement_currency) THEN
   RAISE EXCEPTION 'An exact physical source cannot have contradictory measurement currencies across presentation certificates.';
  END IF;
  IF proposal.domain<>'consolidation' OR proposal.operation<>'historical_translation_contribution'
    OR proposal.status<>'approved' OR proposal.approved_by IS NULL
    OR (proposal.approved_by=proposal.submitted_by AND NOT public.financial_change_self_decision_authorized(NEW.org_id,proposal.id,proposal.submitted_by))
    OR proposal.subject_id IS DISTINCT FROM NEW.source_line_id OR proposal.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id
    OR proposal.effective_on IS DISTINCT FROM NEW.posting_date OR proposal.payload->'evidence' IS DISTINCT FROM NEW.evidence
    OR proposal.payload->>'evidenceHash' IS DISTINCT FROM NEW.evidence_hash
    OR proposal.payload->'requiredSubsidiaryIds' IS DISTINCT FROM jsonb_build_array(NEW.subsidiary_id::text)
    OR proposal.before_state IS DISTINCT FROM jsonb_build_object('sourceFingerprint',NEW.evidence->'sourceFingerprint',
      'originalLayerStates',NEW.evidence->'originalLayerStates') THEN
   RAISE EXCEPTION 'Historical contributions require the exact native approved source assessment and retained evidence.';
  END IF;
  IF entry.status NOT IN('posted','reversed') OR physical.entry_id IS DISTINCT FROM NEW.source_entry_id
    OR entry.book_id IS DISTINCT FROM NEW.book_id OR physical.account_id IS DISTINCT FROM NEW.account_id
    OR physical.subsidiary_id IS DISTINCT FROM NEW.subsidiary_id OR physical.amount IS DISTINCT FROM NEW.source_amount
    OR entry.posting_date IS DISTINCT FROM NEW.posting_date
    OR NOT EXISTS(SELECT 1 FROM public.accounts WHERE org_id=NEW.org_id AND id=NEW.account_id AND type='equity')
    OR NEW.evidence->'sourceFingerprint' IS DISTINCT FROM public.historical_translation_source_fingerprint(NEW.org_id,NEW.source_line_id)
    OR instruction->>'sourceLineId' IS DISTINCT FROM NEW.source_line_id::text
    OR instruction->>'measurementCurrency' IS DISTINCT FROM NEW.measurement_currency
    OR instruction->>'presentationCurrency' IS DISTINCT FROM NEW.presentation_currency
    OR instruction->>'kind' IS DISTINCT FROM NEW.kind
    OR jsonb_typeof(instruction->'layers') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.evidence->'retainedSources') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.evidence->'translatedAmounts') IS DISTINCT FROM 'array'
    OR jsonb_typeof(NEW.evidence->'originalLayerStates') IS DISTINCT FROM 'array'
    OR jsonb_array_length(instruction->'layers') NOT BETWEEN 1 AND 200
    OR jsonb_array_length(NEW.evidence->'retainedSources')<>jsonb_array_length(instruction->'layers')
    OR jsonb_array_length(NEW.evidence->'translatedAmounts')<>jsonb_array_length(instruction->'layers')
    OR jsonb_array_length(NEW.evidence->'originalLayerStates')<>CASE WHEN NEW.kind='correction' THEN jsonb_array_length(instruction->'layers') ELSE 0 END
    OR (NEW.kind='contribution' AND jsonb_array_length(instruction->'layers')<>1)
    OR (NEW.kind='opening' AND entry.origin NOT IN('opening','book_opening','migration'))
    OR (entry.reverses_entry_id IS NOT NULL AND NEW.kind<>'correction') THEN
   RAISE EXCEPTION 'Historical evidence must bind the exact posted equity line, book, entity, amount, date and explicit layer composition.';
  END IF;
  RETURN NEW;
 END $function$;

CREATE FUNCTION public.historical_translation_layer_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
 DECLARE basis public.historical_translation_contributions%ROWTYPE; original public.historical_translation_layers%ROWTYPE;
   original_basis public.historical_translation_contributions%ROWTYPE; approved_layer jsonb; retained jsonb; used numeric;
 BEGIN
  IF TG_OP<>'INSERT' THEN
   IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
     OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
   RAISE EXCEPTION 'Approved historical translation layers are immutable.';
  END IF;
  SELECT * INTO STRICT basis FROM public.historical_translation_contributions WHERE org_id=NEW.org_id AND id=NEW.basis_id FOR SHARE;
  approved_layer:=basis.evidence->'instruction'->'layers'->(NEW.layer_number-1);
  retained:=basis.evidence->'retainedSources'->(NEW.layer_number-1);
  IF approved_layer IS DISTINCT FROM jsonb_build_object('amount',NEW.amount::text,'rate',NEW.rate::text,
     'historicalDate',NEW.historical_date::text,'provenance',NEW.provenance,'originalLayerId',NEW.original_layer_id::text,
     'source',jsonb_build_object('fileId',NEW.source_file_id::text,'versionId',NEW.source_version_id::text,'contentHash',NEW.source_hash))
    OR retained IS DISTINCT FROM jsonb_build_object('fileId',NEW.source_file_id::text,'versionId',NEW.source_version_id::text,
      'contentHash',NEW.source_hash,'versionNumber',NEW.source_version_number)
    OR basis.evidence->'translatedAmounts'->>(NEW.layer_number-1) IS DISTINCT FROM NEW.translated_amount::text
    OR sign(NEW.amount)<>sign(basis.source_amount) OR NEW.historical_date>basis.posting_date
    OR (basis.measurement_currency=basis.presentation_currency AND NEW.rate<>1)
    OR (basis.kind='correction') IS DISTINCT FROM (NEW.original_layer_id IS NOT NULL)
    OR NOT EXISTS(SELECT 1 FROM public.files file JOIN public.file_versions version ON version.file_id=file.id
      WHERE file.org_id=NEW.org_id AND file.id=NEW.source_file_id AND version.id=NEW.source_version_id
        AND version.content_hash=NEW.source_hash AND version.version_number=NEW.source_version_number) THEN
   RAISE EXCEPTION 'Every historical layer must retain its exact approved amount, genuine rate, date, provenance and tenant-owned Cabinet version.';
  END IF;
  IF NEW.original_layer_id IS NOT NULL THEN
   SELECT * INTO STRICT original FROM public.historical_translation_layers WHERE org_id=NEW.org_id AND id=NEW.original_layer_id FOR UPDATE;
   SELECT * INTO STRICT original_basis FROM public.historical_translation_contributions WHERE org_id=NEW.org_id AND id=original.basis_id FOR SHARE;
   IF original_basis.posting_date>basis.posting_date OR original_basis.book_id<>basis.book_id OR original_basis.account_id<>basis.account_id
     OR original_basis.subsidiary_id<>basis.subsidiary_id OR original_basis.measurement_currency<>basis.measurement_currency
     OR original_basis.presentation_currency<>basis.presentation_currency OR original.rate<>NEW.rate
     OR original.historical_date<>NEW.historical_date OR original.provenance<>NEW.provenance
     OR original.source_file_id<>NEW.source_file_id OR original.source_version_id<>NEW.source_version_id
     OR original.source_hash<>NEW.source_hash OR original.source_version_number<>NEW.source_version_number
     OR sign(original.amount)=sign(NEW.amount)
     OR NOT EXISTS(SELECT 1 FROM public.financial_changes WHERE org_id=NEW.org_id AND id=original_basis.change_id AND status='applied')
     OR EXISTS(SELECT 1 FROM public.journal_entries entry WHERE entry.org_id=NEW.org_id AND entry.id=basis.source_entry_id
       AND entry.reverses_entry_id IS NOT NULL AND entry.reverses_entry_id<>original_basis.source_entry_id) THEN
    RAISE EXCEPTION 'A correction must explicitly bind an applied parent layer and preserve its genuine rate and source.';
   END IF;
   SELECT coalesce(sum(abs(amount)),0) INTO used FROM public.historical_translation_layers WHERE org_id=NEW.org_id AND original_layer_id=original.id;
   IF used+abs(NEW.amount)>abs(original.amount) THEN RAISE EXCEPTION 'Correction exceeds the remaining applied parent layer.'; END IF;
   IF basis.evidence->'originalLayerStates'->(NEW.layer_number-1) IS DISTINCT FROM
      jsonb_build_object('originalLayerId',original.id::text,'consumedAmount',used::numeric(19,4)::text)
     OR NEW.translated_amount IS DISTINCT FROM NEW.amount*NEW.rate THEN
    RAISE EXCEPTION 'Correction must retain its reviewed original allocation state and exact unrounded original-rate product.';
   END IF;
  ELSIF NEW.translated_amount IS DISTINCT FROM NEW.amount*NEW.rate THEN
   RAISE EXCEPTION 'A contribution layer must retain its exact genuine-rate translated amount.';
  END IF;
  RETURN NEW;
 END $function$;

CREATE FUNCTION public.historical_translation_completeness() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
 DECLARE target uuid; basis public.historical_translation_contributions%ROWTYPE; count_layers integer; total numeric; proposal public.financial_changes%ROWTYPE;
 BEGIN
  IF TG_TABLE_NAME='historical_translation_contributions' THEN target:=NEW.id; ELSE target:=NEW.basis_id; END IF;
  SELECT * INTO STRICT basis FROM public.historical_translation_contributions WHERE org_id=NEW.org_id AND id=target;
  SELECT count(*),sum(amount) INTO count_layers,total FROM public.historical_translation_layers WHERE org_id=NEW.org_id AND basis_id=target;
  SELECT * INTO STRICT proposal FROM public.financial_changes WHERE org_id=NEW.org_id AND id=basis.change_id;
  IF count_layers<>jsonb_array_length(basis.evidence->'instruction'->'layers') OR total IS DISTINCT FROM basis.source_amount
    OR proposal.status<>'applied' OR proposal.result IS DISTINCT FROM jsonb_build_object('basisId',basis.id::text) THEN
   RAISE EXCEPTION 'Record every exact approved historical layer and complete its native approval atomically.';
  END IF;
  RETURN NULL;
 END $function$;

CREATE FUNCTION public.historical_translation_source_retention() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
 BEGIN
  IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
    OR public.openbooks_sandbox_wipe_allowed(OLD.org_id)) THEN RETURN OLD; END IF;
  IF TG_TABLE_NAME='journal_lines' THEN
   IF EXISTS(SELECT 1 FROM public.historical_translation_contributions WHERE org_id=OLD.org_id AND source_line_id=OLD.id)
    AND (TG_OP='DELETE' OR ROW(NEW.org_id,NEW.id,NEW.entry_id,NEW.account_id,NEW.subsidiary_id,NEW.amount,NEW.currency,NEW.txn_amount,NEW.fx_rate)
     IS DISTINCT FROM ROW(OLD.org_id,OLD.id,OLD.entry_id,OLD.account_id,OLD.subsidiary_id,OLD.amount,OLD.currency,OLD.txn_amount,OLD.fx_rate)) THEN
    RAISE EXCEPTION 'Retain the physical historical contribution source; correct it through governed reversals.';
   END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM public.historical_translation_contributions WHERE org_id=OLD.org_id AND source_entry_id=OLD.id)
    AND (TG_OP='DELETE' OR ROW(NEW.org_id,NEW.id,NEW.book_id,NEW.posting_date,NEW.origin,NEW.reverses_entry_id)
     IS DISTINCT FROM ROW(OLD.org_id,OLD.id,OLD.book_id,OLD.posting_date,OLD.origin,OLD.reverses_entry_id)
     OR NEW.status NOT IN('posted','reversed')) THEN
    RAISE EXCEPTION 'Retain the posted historical contribution entry identity and measurement date.';
   END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END $function$;

CREATE FUNCTION public.historical_translation_basis_audit() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
 BEGIN
  INSERT INTO public.audit_log(org_id,table_name,row_id,action,changes,actor_id)
    VALUES(NEW.org_id,'historical_translation_contributions',NEW.id,'insert',
      jsonb_build_object('before',NULL,'after',to_jsonb(NEW),'reason',(SELECT reason FROM public.financial_changes WHERE org_id=NEW.org_id AND id=NEW.change_id)),NEW.created_by);
  RETURN NEW;
 END $function$;
CREATE FUNCTION public.historical_translation_file_retention() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $function$
 DECLARE source_org uuid; source_version uuid;
 BEGIN
  IF TG_TABLE_NAME='file_versions' THEN
   source_version:=OLD.id;
   SELECT org_id INTO source_org FROM public.files WHERE id=OLD.file_id;
  ELSE
   source_version:=OLD.version_id;
   SELECT file.org_id INTO source_org FROM public.file_versions version JOIN public.files file ON file.id=version.file_id
    WHERE version.id=source_version;
  END IF;
  IF EXISTS(SELECT 1 FROM public.historical_translation_layers WHERE org_id=source_org AND source_version_id=source_version) THEN
   IF TG_OP='DELETE' AND (tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD))
     OR public.openbooks_sandbox_wipe_allowed(source_org)) THEN RETURN OLD; END IF;
   RAISE EXCEPTION 'Retain the immutable Cabinet version and original bytes supporting approved historical contribution evidence.';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END $function$;
CREATE TRIGGER historical_translation_basis_guard BEFORE INSERT OR UPDATE OR DELETE ON public.historical_translation_contributions
 FOR EACH ROW EXECUTE FUNCTION public.historical_translation_basis_guard();
CREATE TRIGGER historical_translation_layer_guard BEFORE INSERT OR UPDATE OR DELETE ON public.historical_translation_layers
 FOR EACH ROW EXECUTE FUNCTION public.historical_translation_layer_guard();
CREATE TRIGGER historical_translation_basis_audit AFTER INSERT ON public.historical_translation_contributions
 FOR EACH ROW EXECUTE FUNCTION public.historical_translation_basis_audit();
CREATE TRIGGER historical_translation_line_retention BEFORE UPDATE OR DELETE ON public.journal_lines
 FOR EACH ROW EXECUTE FUNCTION public.historical_translation_source_retention();
CREATE TRIGGER historical_translation_entry_retention BEFORE UPDATE OR DELETE ON public.journal_entries
 FOR EACH ROW EXECUTE FUNCTION public.historical_translation_source_retention();
CREATE TRIGGER historical_translation_version_retention BEFORE UPDATE OR DELETE ON public.file_versions
 FOR EACH ROW EXECUTE FUNCTION public.historical_translation_file_retention();
CREATE TRIGGER historical_translation_blob_retention BEFORE UPDATE OR DELETE ON public.file_blobs
 FOR EACH ROW EXECUTE FUNCTION public.historical_translation_file_retention();
DO $block$ DECLARE tbl text; BEGIN
 FOREACH tbl IN ARRAY ARRAY['historical_translation_contributions','historical_translation_layers'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER historical_translation_completeness AFTER INSERT ON public.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.historical_translation_completeness()',tbl);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tbl);
  EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()',tbl);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true))) WITH CHECK((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true)))',tbl);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''',tbl);
 END LOOP;
END $block$;
COMMENT ON TABLE public.historical_translation_contributions IS
 'Approved financial source assessments contain protected Cabinet provenance; access through native authorized source readers.';
COMMENT ON TABLE public.historical_translation_layers IS
 'Immutable genuine-rate products and protected Cabinet references; excluded from the generic governed-query catalog.';
