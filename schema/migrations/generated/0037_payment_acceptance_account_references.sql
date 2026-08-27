-- OpenBooks forward migration 0037_payment_acceptance_account_references.
--
-- Hosted payment acceptance stores accounting references that are consumed by
-- a later provider webhook. The baseline columns were bare UUIDs: a direct
-- writer could point a provider config or payment link at another tenant, a
-- disabled/summary account, or a non-bank/non-income account. The preflight is
-- deliberately fail-closed and never rewrites financial history; once it
-- passes, composite foreign keys make tenant ownership unrepresentable and
-- triggers enforce the state/class invariants that a foreign key cannot carry.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $preflight$
DECLARE
  violation record;
BEGIN
  SELECT * INTO violation
    FROM (
      SELECT 'psp_provider_configs.default_bank_account_id'::text AS relationship,
             c.id AS child_id, c.org_id AS child_org, c.default_bank_account_id AS referenced_id,
             a.org_id AS referenced_org
        FROM public.psp_provider_configs c
        LEFT JOIN public.accounts a ON a.id = c.default_bank_account_id
       WHERE c.default_bank_account_id IS NOT NULL
         AND (a.org_id IS DISTINCT FROM c.org_id
              OR a.type IS DISTINCT FROM 'asset_bank'
              OR NOT a.is_active OR a.is_summary)
      UNION ALL
      SELECT 'psp_provider_configs.surcharge_rule_id', c.id, c.org_id, c.surcharge_rule_id, r.org_id
        FROM public.psp_provider_configs c
        LEFT JOIN public.payment_surcharge_rules r ON r.id = c.surcharge_rule_id
       WHERE c.surcharge_rule_id IS NOT NULL
         AND (r.org_id IS DISTINCT FROM c.org_id
              OR NOT r.is_active
              OR (r.provider IS NOT NULL AND r.provider IS DISTINCT FROM c.provider))
      UNION ALL
      SELECT 'payment_surcharge_rules.fee_income_account_id', r.id, r.org_id,
             r.fee_income_account_id, a.org_id
        FROM public.payment_surcharge_rules r
        LEFT JOIN public.accounts a ON a.id = r.fee_income_account_id
       WHERE a.org_id IS DISTINCT FROM r.org_id
          OR a.type IS DISTINCT FROM 'income'
             AND a.type IS DISTINCT FROM 'income_other'
          OR NOT a.is_active OR a.is_summary
      UNION ALL
      SELECT 'payment_links.document_id', l.id, l.org_id, l.document_id, d.org_id
        FROM public.payment_links l
        LEFT JOIN public.documents d ON d.id = l.document_id
       WHERE d.org_id IS DISTINCT FROM l.org_id
      UNION ALL
      SELECT 'payment_links.party_id', l.id, l.org_id, l.party_id, p.org_id
        FROM public.payment_links l
        LEFT JOIN public.parties p ON p.id = l.party_id
       WHERE p.org_id IS DISTINCT FROM l.org_id
      UNION ALL
      SELECT 'payment_links.subsidiary_id', l.id, l.org_id, l.subsidiary_id, s.org_id
        FROM public.payment_links l
        LEFT JOIN public.subsidiaries s ON s.id = l.subsidiary_id
       WHERE s.org_id IS DISTINCT FROM l.org_id
      UNION ALL
      SELECT 'payment_links.bank_account_id', l.id, l.org_id, l.bank_account_id, a.org_id
        FROM public.payment_links l
        LEFT JOIN public.accounts a ON a.id = l.bank_account_id
       WHERE a.org_id IS DISTINCT FROM l.org_id
          OR a.type IS DISTINCT FROM 'asset_bank'
          OR NOT a.is_active OR a.is_summary
    ) violations
   ORDER BY relationship, child_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'payment acceptance account-reference migration found invalid legacy data',
      DETAIL = format(
        'relationship=%s child_id=%s child_org=%s referenced_id=%s referenced_org=%s',
        violation.relationship,
        violation.child_id,
        violation.child_org,
        violation.referenced_id,
        violation.referenced_org
      ),
      HINT = 'Correct the identified configuration/link under an approved repair, then retry migration 0037; this migration never rewrites payment history.';
  END IF;
END
$preflight$;

-- PostgreSQL requires an exact unique key for each composite foreign key. The
-- later ledger/document coherence migrations create some of these too; the
-- names are shared so each forward path is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_org_id_id_unique
  ON public.accounts (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS documents_org_id_id_unique
  ON public.documents (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS parties_org_id_id_unique
  ON public.parties (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS subsidiaries_org_id_id_unique
  ON public.subsidiaries (org_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS payment_surcharge_rules_org_id_id_unique
  ON public.payment_surcharge_rules (org_id, id);

ALTER TABLE public.psp_provider_configs
  DROP CONSTRAINT IF EXISTS psp_provider_configs_default_bank_account_fkey,
  DROP CONSTRAINT IF EXISTS psp_provider_configs_surcharge_rule_fkey;

ALTER TABLE public.psp_provider_configs
  ADD CONSTRAINT psp_provider_configs_default_bank_account_fkey
    FOREIGN KEY (org_id, default_bank_account_id)
    REFERENCES public.accounts (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT psp_provider_configs_surcharge_rule_fkey
    FOREIGN KEY (org_id, surcharge_rule_id)
    REFERENCES public.payment_surcharge_rules (org_id, id) DEFERRABLE NOT VALID;

ALTER TABLE public.payment_surcharge_rules
  DROP CONSTRAINT IF EXISTS payment_surcharge_rules_fee_income_account_fkey;

ALTER TABLE public.payment_surcharge_rules
  ADD CONSTRAINT payment_surcharge_rules_fee_income_account_fkey
    FOREIGN KEY (org_id, fee_income_account_id)
    REFERENCES public.accounts (org_id, id) DEFERRABLE NOT VALID;

ALTER TABLE public.payment_links
  DROP CONSTRAINT IF EXISTS payment_links_document_fkey,
  DROP CONSTRAINT IF EXISTS payment_links_party_fkey,
  DROP CONSTRAINT IF EXISTS payment_links_subsidiary_fkey,
  DROP CONSTRAINT IF EXISTS payment_links_bank_account_fkey;

ALTER TABLE public.payment_links
  ADD CONSTRAINT payment_links_document_fkey
    FOREIGN KEY (org_id, document_id)
    REFERENCES public.documents (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT payment_links_party_fkey
    FOREIGN KEY (org_id, party_id)
    REFERENCES public.parties (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT payment_links_subsidiary_fkey
    FOREIGN KEY (org_id, subsidiary_id)
    REFERENCES public.subsidiaries (org_id, id) DEFERRABLE NOT VALID,
  ADD CONSTRAINT payment_links_bank_account_fkey
    FOREIGN KEY (org_id, bank_account_id)
    REFERENCES public.accounts (org_id, id) DEFERRABLE NOT VALID;

ALTER TABLE public.psp_provider_configs VALIDATE CONSTRAINT psp_provider_configs_default_bank_account_fkey;
ALTER TABLE public.psp_provider_configs VALIDATE CONSTRAINT psp_provider_configs_surcharge_rule_fkey;
ALTER TABLE public.payment_surcharge_rules VALIDATE CONSTRAINT payment_surcharge_rules_fee_income_account_fkey;
ALTER TABLE public.payment_links VALIDATE CONSTRAINT payment_links_document_fkey;
ALTER TABLE public.payment_links VALIDATE CONSTRAINT payment_links_party_fkey;
ALTER TABLE public.payment_links VALIDATE CONSTRAINT payment_links_subsidiary_fkey;
ALTER TABLE public.payment_links VALIDATE CONSTRAINT payment_links_bank_account_fkey;

CREATE OR REPLACE FUNCTION public.payment_acceptance_account_reference_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  account_row record;
  rule_row record;
BEGIN
  IF TG_TABLE_NAME = 'psp_provider_configs' THEN
    IF NEW.default_bank_account_id IS NOT NULL THEN
      SELECT org_id, type, is_active, is_summary
        INTO account_row
        FROM public.accounts
       WHERE id = NEW.default_bank_account_id;
      IF NOT FOUND OR account_row.org_id IS DISTINCT FROM NEW.org_id
         OR account_row.type IS DISTINCT FROM 'asset_bank'
         OR NOT account_row.is_active OR account_row.is_summary THEN
        RAISE EXCEPTION 'provider default bank account must be an active, postable asset_bank account owned by the provider organization'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.surcharge_rule_id IS NOT NULL THEN
      SELECT org_id, is_active, provider
        INTO rule_row
        FROM public.payment_surcharge_rules
       WHERE id = NEW.surcharge_rule_id;
      IF NOT FOUND OR rule_row.org_id IS DISTINCT FROM NEW.org_id
         OR NOT rule_row.is_active
         OR (rule_row.provider IS NOT NULL AND rule_row.provider IS DISTINCT FROM NEW.provider) THEN
        RAISE EXCEPTION 'provider surcharge rule must be active, provider-compatible, and owned by the provider organization'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'payment_surcharge_rules' THEN
    SELECT org_id, type, is_active, is_summary
      INTO account_row
      FROM public.accounts
     WHERE id = NEW.fee_income_account_id;
    IF NOT FOUND OR account_row.org_id IS DISTINCT FROM NEW.org_id
       OR account_row.type NOT IN ('income', 'income_other')
       OR NOT account_row.is_active OR account_row.is_summary THEN
      RAISE EXCEPTION 'surcharge fee account must be an active, postable income account owned by the rule organization'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'payment_links' THEN
    SELECT org_id, type, is_active, is_summary
      INTO account_row
      FROM public.accounts
     WHERE id = NEW.bank_account_id;
    IF NOT FOUND OR account_row.org_id IS DISTINCT FROM NEW.org_id
       OR account_row.type IS DISTINCT FROM 'asset_bank'
       OR NOT account_row.is_active OR account_row.is_summary THEN
      RAISE EXCEPTION 'payment link bank account must be an active, postable asset_bank account owned by the link organization'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS psp_provider_configs_acceptance_account_guard ON public.psp_provider_configs;
CREATE TRIGGER psp_provider_configs_acceptance_account_guard
  BEFORE INSERT OR UPDATE OF org_id, provider, default_bank_account_id, surcharge_rule_id
  ON public.psp_provider_configs
  FOR EACH ROW EXECUTE FUNCTION public.payment_acceptance_account_reference_guard();

DROP TRIGGER IF EXISTS payment_surcharge_rules_acceptance_account_guard ON public.payment_surcharge_rules;
CREATE TRIGGER payment_surcharge_rules_acceptance_account_guard
  BEFORE INSERT OR UPDATE OF org_id, fee_income_account_id
  ON public.payment_surcharge_rules
  FOR EACH ROW EXECUTE FUNCTION public.payment_acceptance_account_reference_guard();

DROP TRIGGER IF EXISTS payment_links_acceptance_account_guard ON public.payment_links;
CREATE TRIGGER payment_links_acceptance_account_guard
  BEFORE INSERT OR UPDATE OF org_id, bank_account_id
  ON public.payment_links
  FOR EACH ROW EXECUTE FUNCTION public.payment_acceptance_account_reference_guard();

COMMENT ON FUNCTION public.payment_acceptance_account_reference_guard() IS
  'openbooks:payment_acceptance_account_references:v1 - tenant, active, postable, and account-class guards for hosted payment acceptance references';
