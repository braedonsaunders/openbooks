-- Expense self-service, foreign-currency expense lines, and a second receipt
-- reading provider.
--
-- expenses.self lets an employee list, read, create, edit, scan receipts on
-- and submit only the expense reports whose employee is the person linked to
-- their login. The built-in employee roles that already enter their own time
-- gain it; org-wide expense grants are unchanged.
--
-- An expense line may be spent in another currency than its report. The line
-- keeps the original currency and amounts, the rate that converted them into
-- the report currency, and the rate's evidence: the dated rate from the
-- organization's exchange rates, an operator rate with its reason, or the
-- amount the card statement billed in the report currency (the effective rate
-- is derived from it). The converted amount remains the line amount that
-- totals and posts. Storage proves the evidence is complete and agrees with
-- the line's original currency and rate.
--
-- Expense FX policies are effective-dated, append-only organization policy:
-- whether an operator may replace the dated exchange rate with an explicit
-- rate and reason. Without a policy version the override is refused.
--
-- Receipts may also be read by the organization's AI model provider
-- (llm_vision) as well as Azure Document Intelligence.
--
-- Backfill: none. Existing lines carry no original currency, the policy
-- table starts empty (overrides refused), and existing captures keep their
-- provider. Only built-in role grants are extended.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

UPDATE public.app_roles SET permissions = permissions || '["expenses.self"]'::jsonb, updated_at = now()
 WHERE is_built_in
   AND key IN ('admin', 'production', 'sales_manager', 'sales_rep', 'buyer', 'cashier', 'project_coordinator')
   AND NOT (permissions ? 'expenses.self' OR permissions ? '*');

ALTER TABLE public.document_lines
 ADD COLUMN original_currency text,
 ADD COLUMN original_amount numeric(19,4),
 ADD COLUMN original_tax_amount numeric(19,4),
 ADD COLUMN original_fx_rate numeric(19,10),
 ADD COLUMN original_fx_evidence jsonb;

-- Every term is definite: a missing key or JSON null where a value is
-- required makes the predicate false, so incomplete evidence cannot pass.
ALTER TABLE public.document_lines
 ADD CONSTRAINT document_lines_original_currency_evidence CHECK (
  (original_currency IS NULL AND original_amount IS NULL AND original_tax_amount IS NULL
   AND original_fx_rate IS NULL AND original_fx_evidence IS NULL)
  OR COALESCE((
   original_currency ~ '^[A-Z]{3}$'
   AND original_amount IS NOT NULL
   AND original_fx_rate > 0
   AND jsonb_typeof(original_fx_evidence) = 'object'
   AND original_fx_evidence ?& ARRAY['version', 'method', 'rate', 'fromCurrency', 'toCurrency', 'rateDate', 'source',
                                     'reason', 'rateType', 'observationId', 'observationDate', 'digest', 'billedAmount']
   AND original_fx_evidence - ARRAY['version', 'method', 'rate', 'fromCurrency', 'toCurrency', 'rateDate', 'source',
                                    'reason', 'rateType', 'observationId', 'observationDate', 'digest', 'billedAmount'] = '{}'::jsonb
   AND original_fx_evidence->'version' = '1'::jsonb
   AND original_fx_evidence->>'method' IN ('rate_table', 'override', 'billed_amount')
   AND CASE WHEN (original_fx_evidence->>'rate') ~ '^[0-9]{1,9}(\.[0-9]{1,10})?$'
        THEN (original_fx_evidence->>'rate')::numeric = original_fx_rate
        ELSE false END
   AND original_fx_evidence->>'fromCurrency' = original_currency
   AND (original_fx_evidence->>'toCurrency') ~ '^[A-Z]{3}$'
   AND original_fx_evidence->>'toCurrency' <> original_currency
   AND (original_fx_evidence->>'rateDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND char_length(coalesce(original_fx_evidence->>'source', '')) BETWEEN 1 AND 120
   AND CASE original_fx_evidence->>'method'
        WHEN 'rate_table' THEN
         jsonb_typeof(original_fx_evidence->'rateType') = 'string'
         AND jsonb_typeof(original_fx_evidence->'observationId') = 'string'
         AND (original_fx_evidence->>'observationDate') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         AND (original_fx_evidence->>'digest') ~ '^[a-f0-9]{64}$'
         AND jsonb_typeof(original_fx_evidence->'reason') = 'null'
         AND jsonb_typeof(original_fx_evidence->'billedAmount') = 'null'
        WHEN 'override' THEN
         char_length(coalesce(original_fx_evidence->>'reason', '')) BETWEEN 8 AND 500
         AND original_fx_evidence->>'reason' = btrim(original_fx_evidence->>'reason')
         AND jsonb_typeof(original_fx_evidence->'billedAmount') = 'null'
        ELSE
         (original_fx_evidence->>'billedAmount') ~ '^-?[0-9]{1,15}(\.[0-9]{1,4})?$'
         AND jsonb_typeof(original_fx_evidence->'reason') = 'null'
       END
  ), false)
 );

COMMENT ON COLUMN public.document_lines.original_currency IS
 'Currency an expense line was spent in when it differs from its report; null for a line in the report currency.';
COMMENT ON COLUMN public.document_lines.original_amount IS
 'The line amount in its original currency, before conversion into the report currency.';
COMMENT ON COLUMN public.document_lines.original_tax_amount IS
 'The line tax shown on the receipt in its original currency; null when the tax is computed in the report currency.';
COMMENT ON COLUMN public.document_lines.original_fx_rate IS
 'Rate that converted the original amounts into the report currency.';
COMMENT ON COLUMN public.document_lines.original_fx_evidence IS
 'How the conversion rate was obtained: the dated exchange-rate observation, an operator rate with its reason, or the billed report-currency amount it was derived from.';

CREATE TABLE public.expense_fx_policies(id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(), org_id uuid NOT NULL REFERENCES public.orgs(id),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid, UNIQUE(org_id,id),
 effective_from date NOT NULL,
 allow_rate_override boolean NOT NULL DEFAULT false,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 2000),
 UNIQUE(org_id,effective_from));
ALTER TABLE public.expense_fx_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_fx_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.expense_fx_policies
 USING((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)))
 WITH CHECK((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting('app.current_org',true)));
COMMENT ON POLICY org_isolation ON public.expense_fx_policies IS 'openbooks:org_isolation:v1';
CREATE TRIGGER expense_fx_policies_immutable BEFORE UPDATE OR DELETE ON public.expense_fx_policies
 FOR EACH ROW EXECUTE FUNCTION public.financial_policy_version_immutable();
CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.expense_fx_policies
 FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence();

ALTER TABLE public.expense_receipt_captures DROP CONSTRAINT expense_receipt_captures_provider_check;
ALTER TABLE public.expense_receipt_captures ADD CONSTRAINT expense_receipt_captures_provider_check
 CHECK (provider IN ('azure_document_intelligence', 'llm_vision'));

INSERT INTO public.openbooks_query_catalog_relations(relation,added_in) VALUES
 ('expense_fx_policies','0739_expense_self_service_and_foreign_receipts');
SELECT public.openbooks_refresh_query_catalog();
