-- Expense receipt captures: one scanned receipt on one expense report.
--
-- A capture retains the receipt file, its content hash, the provider run that
-- read it (model and API version), the normalized reading with per-field
-- confidence and page evidence, the review issues, and the draft line offered
-- to the reviewer. A reading never becomes an expense line by itself: the
-- confirmation, written in the same transaction as the report's line save,
-- records who confirmed which line with which account, amount, merchant and
-- transaction date. Confirmed history feeds the merchant category suggestion
-- and duplicate warnings.
--
-- merchant_key, transaction_date and total identify the receipt for duplicate
-- detection: the confident reading after extraction, the reviewer's values
-- after confirmation.
--
-- Deleting a draft report detaches its captures (document_id becomes null);
-- purging a discarded capture's file clears file_id. Both keep the capture's
-- reading and actor history.
--
-- Backfill: none. The table starts empty.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.expense_receipt_captures (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 document_id uuid,
 file_id uuid,
 content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
 original_filename text NOT NULL CHECK (char_length(btrim(original_filename)) BETWEEN 1 AND 240),
 status text NOT NULL CHECK (status IN ('extracting', 'extracted', 'failed', 'confirmed', 'discarded')),
 attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
 provider text NOT NULL CHECK (provider IN ('azure_document_intelligence')),
 model text NOT NULL,
 api_version text NOT NULL,
 normalized jsonb,
 evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
 issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(issues) = 'array'),
 draft jsonb,
 overall_confidence numeric(5,4) CHECK (overall_confidence BETWEEN 0 AND 1),
 merchant_key text,
 merchant_party_id uuid,
 transaction_date date,
 currency text CHECK (currency ~ '^[A-Z]{3}$'),
 total numeric(19,4),
 last_error text,
 confirmed_line_number integer CHECK (confirmed_line_number >= 1),
 confirmed_account_id uuid,
 confirmed_amount numeric(19,4),
 confirmed_tax_amount numeric(19,4),
 confirmed_merchant_name text,
 confirmed_by uuid REFERENCES public.users(id),
 confirmed_at timestamptz,
 discarded_by uuid REFERENCES public.users(id),
 discarded_at timestamptz,
 created_by uuid REFERENCES public.users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES public.users(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT expense_receipt_captures_org_id_unique UNIQUE (org_id, id),
 CONSTRAINT expense_receipt_captures_document_fk
  FOREIGN KEY (org_id, document_id) REFERENCES public.documents (org_id, id) ON DELETE SET NULL (document_id),
 CONSTRAINT expense_receipt_captures_file_fk
  FOREIGN KEY (org_id, file_id) REFERENCES public.files (org_id, id) ON DELETE SET NULL (file_id),
 CONSTRAINT expense_receipt_captures_merchant_party_fk
  FOREIGN KEY (org_id, merchant_party_id) REFERENCES public.parties (org_id, id),
 CONSTRAINT expense_receipt_captures_confirmed_account_fk
  FOREIGN KEY (org_id, confirmed_account_id) REFERENCES public.accounts (org_id, id),
 CONSTRAINT expense_receipt_captures_read CHECK (
  status NOT IN ('extracted', 'confirmed') OR (normalized IS NOT NULL AND draft IS NOT NULL)
 ),
 CONSTRAINT expense_receipt_captures_failed CHECK (
  status <> 'failed' OR char_length(btrim(coalesce(last_error, ''))) > 0
 ),
 CONSTRAINT expense_receipt_captures_confirmed CHECK (
  status <> 'confirmed' OR (
   confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_line_number IS NOT NULL
   AND confirmed_account_id IS NOT NULL AND confirmed_amount IS NOT NULL
   AND char_length(btrim(coalesce(confirmed_merchant_name, ''))) > 0
   AND transaction_date IS NOT NULL AND total IS NOT NULL
  )
 ),
 CONSTRAINT expense_receipt_captures_discarded CHECK (
  status <> 'discarded' OR (discarded_at IS NOT NULL AND discarded_by IS NOT NULL)
 )
);
CREATE INDEX expense_receipt_captures_document
 ON public.expense_receipt_captures (org_id, document_id);
CREATE INDEX expense_receipt_captures_content_hash
 ON public.expense_receipt_captures (org_id, content_hash);
CREATE INDEX expense_receipt_captures_receipt_identity
 ON public.expense_receipt_captures (org_id, merchant_key, transaction_date);
CREATE INDEX expense_receipt_captures_merchant_history
 ON public.expense_receipt_captures (org_id, merchant_key, confirmed_at DESC)
 WHERE status = 'confirmed';
CREATE INDEX expense_receipt_captures_file
 ON public.expense_receipt_captures (org_id, file_id);

ALTER TABLE public.expense_receipt_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_receipt_captures FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.expense_receipt_captures
 USING ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)))
 WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text = (SELECT current_setting('app.current_org', true)));
COMMENT ON POLICY org_isolation ON public.expense_receipt_captures IS 'openbooks:org_isolation:v1';
CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.expense_receipt_captures
 FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();
COMMENT ON TABLE public.expense_receipt_captures IS
 'Scanned expense receipts: retained file, provider reading with confidence and evidence, review issues, the draft line, and the reviewer''s confirmation. Candidate readings report through the confirmed expense lines on documents, so the table stays out of the generic governed-query catalog.';
