-- Record operator-supplied closing exchange rates for exact foreign-currency
-- monetary positions, and admit recorded rate evidence on settlement
-- documents as well as on invoices and bills.
--
-- A closing rate observation binds one account's foreign-currency position
-- in one legal entity, on one book, for one assigned period: the transaction
-- currency, the currency that book measures the entity in (which on a
-- secondary book can differ from the entity's functional currency), and the
-- period's final day as the rate date. Observations are append-only: the
-- first row for a position is its root and a governed correction appends a
-- successor version, so the current rate is the newest version while every
-- earlier quote remains immutable for the postings that consumed it.
-- Backfill: none. Positions without recorded evidence keep resolving their
-- period-end rate from the organization's exchange rates.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.fx_revaluation_rate_evidence (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 book_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL,
 period_id uuid NOT NULL,
 account_id uuid NOT NULL,
 transaction_currency text NOT NULL REFERENCES public.currencies(code),
 measurement_currency text NOT NULL REFERENCES public.currencies(code),
 rate_date date NOT NULL,
 rate numeric(19,10) NOT NULL CHECK (rate > 0),
 source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 120 AND source = btrim(source)),
 reason text NOT NULL CHECK (char_length(reason) BETWEEN 8 AND 500 AND reason = btrim(reason)),
 version integer NOT NULL CHECK (version >= 1),
 supersedes_id uuid,
 request_id uuid NOT NULL,
 request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL REFERENCES public.users(id),
 CONSTRAINT fx_revaluation_rate_evidence_org_id_unique UNIQUE (org_id, id),
 CONSTRAINT fx_revaluation_rate_evidence_book_fk
  FOREIGN KEY (org_id, book_id) REFERENCES public.accounting_books (org_id, id),
 CONSTRAINT fx_revaluation_rate_evidence_subsidiary_fk
  FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries (org_id, id),
 CONSTRAINT fx_revaluation_rate_evidence_period_fk
  FOREIGN KEY (org_id, period_id) REFERENCES public.accounting_periods (org_id, id),
 CONSTRAINT fx_revaluation_rate_evidence_account_fk
  FOREIGN KEY (org_id, account_id) REFERENCES public.accounts (org_id, id),
 CONSTRAINT fx_revaluation_rate_evidence_successor_fk
  FOREIGN KEY (org_id, supersedes_id) REFERENCES public.fx_revaluation_rate_evidence (org_id, id),
 CONSTRAINT fx_revaluation_rate_evidence_currencies CHECK (
  transaction_currency ~ '^[A-Z]{3}$' AND measurement_currency ~ '^[A-Z]{3}$'
  AND transaction_currency <> measurement_currency
 ),
 CONSTRAINT fx_revaluation_rate_evidence_version_shape CHECK (
  (version = 1 AND supersedes_id IS NULL) OR (version > 1 AND supersedes_id IS NOT NULL)
 )
);
CREATE UNIQUE INDEX fx_revaluation_rate_evidence_request_unique
 ON public.fx_revaluation_rate_evidence (org_id, request_id);
CREATE UNIQUE INDEX fx_revaluation_rate_evidence_successor_unique
 ON public.fx_revaluation_rate_evidence (org_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
-- A position's identity is its book, legal entity, period, account and
-- transaction currency: exactly one root observation may open for it. The
-- measurement currency and rate date are facts each version is validated
-- against, not identity, so a successor may correct them when the book's
-- native measurement basis or the period itself has changed.
CREATE UNIQUE INDEX fx_revaluation_rate_evidence_root_unique
 ON public.fx_revaluation_rate_evidence (org_id, book_id, subsidiary_id, period_id, account_id, transaction_currency)
 WHERE supersedes_id IS NULL;
CREATE INDEX fx_revaluation_rate_evidence_position
 ON public.fx_revaluation_rate_evidence (org_id, book_id, subsidiary_id, period_id, account_id, transaction_currency);

-- A copied row is admitted only as the registered sandbox source's exact
-- projection: every uuid rebased to the destination identity, and in a
-- masked copy the authored source and reason redacted. This predicate
-- grants no authority of its own.
CREATE FUNCTION public.fx_revaluation_rate_evidence_clone_matches(candidate jsonb)
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
    FROM public.fx_revaluation_rate_evidence source
   WHERE source.org_id = target.sandbox_of
     AND public.ob_rebase(source.id, target.sandbox_seed) = (candidate->>'id')::uuid;
  IF original IS NULL THEN RETURN false; END IF;

  expected := original;
  FOR column_row IN
    SELECT attribute.attname, attribute.atttypid
      FROM pg_catalog.pg_attribute attribute
     WHERE attribute.attrelid = 'public.fx_revaluation_rate_evidence'::regclass
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
    IF target.masked AND column_row.attname IN ('source', 'reason')
      AND jsonb_typeof(original->column_row.attname) = 'string' THEN
      expected := jsonb_set(expected, ARRAY[column_row.attname], to_jsonb('REDACTED'::text));
    END IF;
  END LOOP;
  RETURN candidate = expected;
END
$function$;

-- Storage proves the position the rate was recorded for: an active posting
-- book, an active non-elimination legal entity, an active non-summary
-- monetary account, the assigned period whose final day is the rate date,
-- and the measurement currency the book natively declares for the entity.
-- A successor keeps its predecessor's exact position identity and adds one
-- version; no version may fork, and no row may be updated or deleted
-- outside the approved tenant-retirement and sandbox-wipe controls.
CREATE FUNCTION public.fx_revaluation_rate_evidence_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE
 period_row public.accounting_periods%ROWTYPE;
 predecessor public.fx_revaluation_rate_evidence%ROWTYPE;
 measured text;
BEGIN
 IF TG_OP = 'INSERT' AND public.fx_revaluation_rate_evidence_clone_matches(to_jsonb(NEW)) THEN
  RETURN NEW;
 END IF;
 IF TG_OP = 'DELETE' THEN
  IF tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD))
     OR public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN
   RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Closing exchange rate evidence is append-only; record a successor version with its reason instead of deleting a quote'
   USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  RAISE EXCEPTION 'Closing exchange rate evidence is append-only; record a successor version with its reason instead of replacing a quote'
   USING ERRCODE = '23514';
 END IF;
 -- One writer at a time per exact position, so root creation and successor
 -- appends cannot interleave into two current versions.
 PERFORM pg_advisory_xact_lock(hashtextextended(
  'fx-revaluation-evidence:' || NEW.org_id::text || ':' || NEW.book_id::text || ':'
  || NEW.subsidiary_id::text || ':' || NEW.period_id::text || ':' || NEW.account_id::text || ':'
  || NEW.transaction_currency, 0));
 IF NOT EXISTS (SELECT 1 FROM public.accounting_books
   WHERE org_id = NEW.org_id AND id = NEW.book_id AND is_active AND posts_gl) THEN
  RAISE EXCEPTION 'Closing exchange rate evidence requires an active posting book in this organization'
   USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.subsidiaries
   WHERE org_id = NEW.org_id AND id = NEW.subsidiary_id AND is_active AND NOT is_elimination) THEN
  RAISE EXCEPTION 'Closing exchange rate evidence requires an active legal entity in this organization'
   USING ERRCODE = '23514';
 END IF;
 SELECT * INTO period_row FROM public.accounting_periods
  WHERE org_id = NEW.org_id AND id = NEW.period_id;
 IF period_row.id IS NULL THEN
  RAISE EXCEPTION 'Closing exchange rate evidence requires an assigned accounting period in this organization'
   USING ERRCODE = '23514';
 END IF;
 IF period_row.ends_on IS DISTINCT FROM NEW.rate_date THEN
  RAISE EXCEPTION 'The closing exchange rate must be dated %, the final day of its assigned period', period_row.ends_on
   USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.accounts a
   WHERE a.org_id = NEW.org_id AND a.id = NEW.account_id AND a.is_active AND NOT a.is_summary
     AND (CASE
       WHEN a.monetary IS FALSE THEN false
       WHEN a.monetary IS TRUE THEN a.type NOT IN
         ('income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred', 'equity')
       ELSE a.type IN ('asset_bank', 'asset_receivable', 'liability_payable')
     END)) THEN
  RAISE EXCEPTION 'Closing exchange rate evidence requires an active monetary account in this organization'
   USING ERRCODE = '23514';
 END IF;
 measured := public.accounting_book_currency(NEW.org_id, NEW.book_id, NEW.subsidiary_id);
 IF measured IS NULL OR measured IS DISTINCT FROM NEW.measurement_currency THEN
  RAISE EXCEPTION 'The closing exchange rate must convert into %, the currency this book measures the legal entity in', measured
   USING ERRCODE = '23514';
 END IF;
 IF NEW.supersedes_id IS NULL THEN
  IF EXISTS (SELECT 1 FROM public.fx_revaluation_rate_evidence
    WHERE org_id = NEW.org_id AND book_id = NEW.book_id AND subsidiary_id = NEW.subsidiary_id
      AND period_id = NEW.period_id AND account_id = NEW.account_id
      AND transaction_currency = NEW.transaction_currency) THEN
   RAISE EXCEPTION 'This closing position already has recorded rate evidence; append a successor to its current version'
    USING ERRCODE = '23514';
  END IF;
 ELSE
  SELECT * INTO predecessor FROM public.fx_revaluation_rate_evidence
   WHERE org_id = NEW.org_id AND id = NEW.supersedes_id;
  IF predecessor.id IS NULL
     OR (predecessor.book_id, predecessor.subsidiary_id, predecessor.period_id, predecessor.account_id,
         predecessor.transaction_currency)
        IS DISTINCT FROM
        (NEW.book_id, NEW.subsidiary_id, NEW.period_id, NEW.account_id,
         NEW.transaction_currency)
     OR NEW.version <> predecessor.version + 1 THEN
   RAISE EXCEPTION 'A successor closing rate must keep its predecessor''s exact book, legal entity, period, account and transaction currency, and add one version'
    USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.fx_revaluation_rate_evidence
    WHERE org_id = NEW.org_id AND supersedes_id = NEW.supersedes_id) THEN
   RAISE EXCEPTION 'This closing rate version already has a successor; append to the current version instead'
    USING ERRCODE = '23514';
  END IF;
 END IF;
 RETURN NEW;
END
$function$;

CREATE TRIGGER fx_revaluation_rate_evidence_guard
 BEFORE INSERT OR UPDATE OR DELETE ON public.fx_revaluation_rate_evidence
 FOR EACH ROW EXECUTE FUNCTION public.fx_revaluation_rate_evidence_guard();

CREATE FUNCTION public.fx_revaluation_rate_evidence_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 -- A copied row's provenance is its exact source match, not a new recording.
 IF public.openbooks_clone_authority() THEN RETURN NEW; END IF;
 INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id)
 VALUES (NEW.org_id, 'fx_revaluation_rate_evidence', NEW.id, 'insert',
   jsonb_build_object(
     'before', (SELECT to_jsonb(previous) FROM public.fx_revaluation_rate_evidence previous
                 WHERE previous.org_id = NEW.org_id AND previous.id = NEW.supersedes_id),
     'after', to_jsonb(NEW), 'reason', NEW.reason), NEW.created_by);
 RETURN NEW;
END
$function$;

CREATE TRIGGER fx_revaluation_rate_evidence_audit
 AFTER INSERT ON public.fx_revaluation_rate_evidence
 FOR EACH ROW EXECUTE FUNCTION public.fx_revaluation_rate_evidence_audit();

ALTER TABLE public.fx_revaluation_rate_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fx_revaluation_rate_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.fx_revaluation_rate_evidence
 USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
 WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.fx_revaluation_rate_evidence IS 'openbooks:org_isolation:v1';
CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.fx_revaluation_rate_evidence
 FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
COMMENT ON TABLE public.fx_revaluation_rate_evidence IS
 'Append-only closing exchange rate observations for exact book, legal entity, period and monetary account positions; native close readers own access, so the table stays out of the generic governed-query catalog. Sandbox copies retain the evidence with rebased identities and redacted source and reason.';

-- Settlement documents carry the same recorded-rate evidence as the invoice
-- or bill they settle. Every other term of the reviewed binding — exact key
-- set, rate equality with the document rate, trimmed source and reason,
-- currency and legal-entity equality — is preserved unchanged.
ALTER TABLE public.documents
 DROP CONSTRAINT documents_fx_rate_evidence_bound;
ALTER TABLE public.documents
 ADD CONSTRAINT documents_fx_rate_evidence_bound CHECK (
  document_fx_rate_evidence IS NULL OR COALESCE((
   kind IN ('customer_invoice', 'vendor_bill', 'customer_payment', 'vendor_payment')
   AND jsonb_typeof(document_fx_rate_evidence) = 'object'
   AND document_fx_rate_evidence ?& ARRAY['version', 'rate', 'source', 'reason', 'fromCurrency', 'toCurrency', 'rateDate', 'subsidiaryId']
   AND document_fx_rate_evidence - ARRAY['version', 'rate', 'source', 'reason', 'fromCurrency', 'toCurrency', 'rateDate', 'subsidiaryId'] = '{}'::jsonb
   AND document_fx_rate_evidence->'version' = '1'::jsonb
   AND jsonb_typeof(document_fx_rate_evidence->'rate') = 'string'
   AND jsonb_typeof(document_fx_rate_evidence->'source') = 'string'
   AND jsonb_typeof(document_fx_rate_evidence->'reason') = 'string'
   AND jsonb_typeof(document_fx_rate_evidence->'fromCurrency') = 'string'
   AND jsonb_typeof(document_fx_rate_evidence->'toCurrency') = 'string'
   AND jsonb_typeof(document_fx_rate_evidence->'rateDate') = 'string'
   AND jsonb_typeof(document_fx_rate_evidence->'subsidiaryId') = 'string'
   AND CASE WHEN (document_fx_rate_evidence->>'rate') ~ '^[0-9]{1,9}(\.[0-9]{1,10})?$'
        THEN (document_fx_rate_evidence->>'rate')::numeric > 0
         AND fx_rate = (document_fx_rate_evidence->>'rate')::numeric
        ELSE false END
   AND char_length(document_fx_rate_evidence->>'source') BETWEEN 1 AND 120
   AND document_fx_rate_evidence->>'source' = btrim(document_fx_rate_evidence->>'source')
   AND char_length(document_fx_rate_evidence->>'reason') BETWEEN 8 AND 500
   AND document_fx_rate_evidence->>'reason' = btrim(document_fx_rate_evidence->>'reason')
   AND (document_fx_rate_evidence->>'fromCurrency') ~ '^[A-Z]{3}$'
   AND (document_fx_rate_evidence->>'toCurrency') ~ '^[A-Z]{3}$'
   AND document_fx_rate_evidence->>'fromCurrency' <> document_fx_rate_evidence->>'toCurrency'
   AND currency = document_fx_rate_evidence->>'fromCurrency'
   AND (document_fx_rate_evidence->>'rateDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND subsidiary_id IS NOT NULL
   AND subsidiary_id::text = document_fx_rate_evidence->>'subsidiaryId'
  ), false)
 );

SELECT public.openbooks_refresh_query_catalog();
