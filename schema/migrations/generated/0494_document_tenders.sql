-- OpenBooks forward migration 0494_document_tenders.
-- Paid-at-sale tenders move from documents.custom JSON into a typed table so
-- masked sandbox clones, tender reporting, and posting all read one source.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.document_tenders (
  id uuid DEFAULT public.uuid_generate_v7() PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.orgs(id),
  document_id uuid NOT NULL,
  position integer NOT NULL,
  kind text NOT NULL,
  method_label text NOT NULL,
  account_id uuid,
  stored_value_account_id uuid,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  reference text,
  external_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  UNIQUE(org_id, id),
  UNIQUE(org_id, document_id, position),
  CONSTRAINT document_tenders_kind CHECK (kind IN ('cash', 'card', 'bank_transfer', 'wallet', 'gateway', 'stored_value', 'other')),
  CONSTRAINT document_tenders_position CHECK (position >= 1),
  CONSTRAINT document_tenders_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT document_tenders_currency_valid CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT document_tenders_method_label CHECK (char_length(method_label) BETWEEN 1 AND 120),
  -- Clearing/bank money names its account; a stored-value redemption names
  -- the stored-value account instead and settles against the liability.
  CONSTRAINT document_tenders_account_required CHECK (
    (kind = 'stored_value' AND account_id IS NULL)
    OR (kind <> 'stored_value' AND account_id IS NOT NULL)),
  -- No foreign key to stored_value_accounts: that table lands in a higher
  -- ordinal (0495), so a 0494-time reference would fail on a fresh install.
  -- The tender writer locks the stored-value row instead of trusting the id.
  FOREIGN KEY (org_id, document_id) REFERENCES public.documents(org_id, id) ON DELETE CASCADE DEFERRABLE,
  FOREIGN KEY (org_id, account_id) REFERENCES public.accounts(org_id, id) DEFERRABLE
);
ALTER TABLE public.document_tenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_tenders FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.document_tenders
 USING(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true))
 WITH CHECK(public.app_bypass_rls_active() OR org_id::text=current_setting('app.current_org',true));
COMMENT ON POLICY org_isolation ON public.document_tenders IS 'openbooks:org_isolation:v1';
CREATE INDEX document_tenders_document ON public.document_tenders(org_id, document_id);
CREATE INDEX document_tenders_stored_value_account ON public.document_tenders(org_id, stored_value_account_id)
  WHERE stored_value_account_id IS NOT NULL;

-- Backfill every custom.tenders row before the lifecycle guard below is
-- installed: posted documents are not draft, so the guard would refuse
-- their rows. The preflight proves every element is well-formed first; the
-- guard block fails the upgrade loudly instead of dropping a tender.
DO $backfill$
DECLARE
  v_malformed integer;
BEGIN
  SELECT count(*) INTO v_malformed
    FROM public.documents d
    CROSS JOIN LATERAL jsonb_array_elements(d.custom->'tenders') WITH ORDINALITY AS t(t, pos)
   WHERE d.custom ? 'tenders'
     AND (jsonb_typeof(t.t) <> 'object'
       OR NOT (t.t->>'kind' IN ('cash', 'card', 'bank'))
       OR (t.t->>'accountId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR (t.t->>'amount') !~ '^[0-9]+(\.[0-9]{1,4})?$'
       OR (t.t->>'amount')::numeric <= 0
       OR (t.t->>'reference' IS NOT NULL AND jsonb_typeof(t.t->'reference') <> 'string'));
  IF v_malformed > 0 THEN
    RAISE EXCEPTION 'document_tenders backfill refused: % custom.tenders element(s) are malformed. Fix or remove the tenders on those draft documents, then retry the upgrade.', v_malformed
      USING ERRCODE = 'check_violation';
  END IF;
END $backfill$;

INSERT INTO public.document_tenders
  (org_id, document_id, position, kind, method_label, account_id, amount_minor, currency, reference, created_by, updated_by)
SELECT d.org_id, d.id, t.pos,
       CASE t.t->>'kind' WHEN 'bank' THEN 'bank_transfer' ELSE t.t->>'kind' END,
       CASE t.t->>'kind' WHEN 'bank' THEN 'bank_transfer' ELSE t.t->>'kind' END,
       (t.t->>'accountId')::uuid,
       ((t.t->>'amount')::numeric * 10000)::bigint,
       d.currency,
       NULLIF(t.t->>'reference', ''),
       d.created_by, d.updated_by
  FROM public.documents d
  CROSS JOIN LATERAL jsonb_array_elements(d.custom->'tenders') WITH ORDINALITY AS t(t, pos)
 WHERE d.custom ? 'tenders';

-- The table is now the single source: remove the JSON key in the same
-- migration so no second source survives.
UPDATE public.documents SET custom = custom - 'tenders' WHERE custom ? 'tenders';

-- Tender lifecycle matches document lines (0034): ordinary writes need a
-- draft parent, with the parent locked before its status is read. Two
-- tender-specific rules ride the same guard: a cash sale redeems an
-- existing balance, so its stored-value tenders must name the account at
-- draft time; a cash refund may mint the credit at settle, so its tenders
-- may leave the account empty until the post-commit effect fills it in.
-- That mint-fill is the only post-commit write the guard permits, and only
-- as a single-column NULL-to-value fill on a stored-value tender.
CREATE OR REPLACE FUNCTION public.document_tender_lifecycle_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_old_document_id uuid;
  v_new_document_id uuid;
  v_old_org_id uuid;
  v_new_org_id uuid;
  v_old_found boolean := false;
  v_new_found boolean := false;
  v_old_status text;
  v_new_status text;
  v_old_kind text;
  v_new_kind text;
  v_parent record;
  v_sandbox_wipe boolean;
  v_trusted_replay boolean;
  v_mint_fill boolean;
BEGIN
  v_old_document_id := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.document_id ELSE NULL END;
  v_new_document_id := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.document_id ELSE NULL END;
  v_old_org_id := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN OLD.org_id ELSE NULL END;
  v_new_org_id := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN NEW.org_id ELSE NULL END;

  v_sandbox_wipe :=
    TG_OP = 'DELETE'
    AND (v_old_org_id IS NULL OR public.openbooks_sandbox_wipe_allowed(v_old_org_id));
  IF v_sandbox_wipe THEN
    RETURN OLD;
  END IF;

  FOR v_parent IN
    SELECT d.id, d.org_id, d.status, d.kind
      FROM public.documents d
     WHERE d.id IN (v_old_document_id, v_new_document_id)
     ORDER BY d.id
     FOR UPDATE
  LOOP
    IF v_parent.id = v_old_document_id THEN
      v_old_found := true;
      IF v_parent.org_id IS DISTINCT FROM v_old_org_id THEN
        RAISE EXCEPTION
          'document % does not exist in organization %',
          v_old_document_id, v_old_org_id
          USING ERRCODE = 'foreign_key_violation';
      END IF;
      v_old_status := v_parent.status;
      v_old_kind := v_parent.kind;
    END IF;
    IF v_parent.id = v_new_document_id THEN
      v_new_found := true;
      IF v_parent.org_id IS DISTINCT FROM v_new_org_id THEN
        RAISE EXCEPTION
          'document % does not exist in organization %',
          v_new_document_id, v_new_org_id
          USING ERRCODE = 'foreign_key_violation';
      END IF;
      v_new_status := v_parent.status;
      v_new_kind := v_parent.kind;
    END IF;
  END LOOP;

  IF v_old_document_id IS NOT NULL AND NOT v_old_found THEN
    RAISE EXCEPTION
      'document % does not exist in organization %',
      v_old_document_id, v_old_org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF v_new_document_id IS NOT NULL AND NOT v_new_found THEN
    RAISE EXCEPTION
      'document % does not exist in organization %',
      v_new_document_id, v_new_org_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  v_trusted_replay :=
    coalesce(current_setting('openbooks.migration', true), 'off') = 'on'
    AND coalesce(current_setting('openbooks.amend', true), 'off') = 'on';
  IF v_trusted_replay THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- Mint-fill: the refund settle effect mints the store-credit account after
  -- posting and records it on the tender. Only this single-column fill passes
  -- on a non-draft parent; every other post-commit write is refused.
  v_mint_fill :=
    TG_OP = 'UPDATE'
    AND v_old_status IS DISTINCT FROM 'draft'
    AND OLD.kind = 'stored_value'
    AND OLD.stored_value_account_id IS NULL
    AND NEW.stored_value_account_id IS NOT NULL
    AND NEW.org_id IS NOT DISTINCT FROM OLD.org_id
    AND NEW.document_id IS NOT DISTINCT FROM OLD.document_id
    AND NEW.position IS NOT DISTINCT FROM OLD.position
    AND NEW.kind IS NOT DISTINCT FROM OLD.kind
    AND NEW.method_label IS NOT DISTINCT FROM OLD.method_label
    AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id
    AND NEW.amount_minor IS NOT DISTINCT FROM OLD.amount_minor
    AND NEW.currency IS NOT DISTINCT FROM OLD.currency
    AND NEW.reference IS NOT DISTINCT FROM OLD.reference
    AND NEW.external_ref IS NOT DISTINCT FROM OLD.external_ref;
  IF v_mint_fill THEN
    RETURN NEW;
  END IF;

  IF v_old_document_id IS NOT NULL AND v_old_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'document % is % — its tenders are immutable outside draft status',
      v_old_document_id, v_old_status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_new_document_id IS NOT NULL AND v_new_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION
      'document % is % — its tenders are immutable outside draft status',
      v_new_document_id, v_new_status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- A sale redeems an existing balance at posting, so the account must be
  -- resolved while the draft is still editable. A refund may mint the
  -- credit at settle instead.
  IF v_new_document_id IS NOT NULL AND TG_OP = 'INSERT'
     AND NEW.kind = 'stored_value' AND NEW.stored_value_account_id IS NULL
     AND v_new_kind = 'cash_sale' THEN
    RAISE EXCEPTION
      'cash sale tender % names no stored-value account — resolve the gift card or store credit being redeemed before posting',
      NEW.position
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

COMMENT ON FUNCTION public.document_tender_lifecycle_guard() IS
  'openbooks:document_tender_lifecycle:v1 - locks the tenant-owned parent document and permits ordinary tender writes only while it is draft; the refund mint-fill is the only post-commit write; sandbox wipe and paired migration/amend replay are explicit trusted paths';

DROP TRIGGER IF EXISTS document_tender_lifecycle ON public.document_tenders;
CREATE TRIGGER document_tender_lifecycle
  BEFORE INSERT OR DELETE OR UPDATE ON public.document_tenders
  FOR EACH ROW EXECUTE FUNCTION public.document_tender_lifecycle_guard();

insert into public.openbooks_query_catalog_relations (relation, added_in)
 values ('document_tenders', '0494_document_tenders') on conflict (relation) do nothing; -- expected on replay
select public.openbooks_refresh_query_catalog();
