-- Stored value carries its legal entity and both currencies: the account
-- records the issuing subsidiary, and every entry records the card-currency
-- amount alongside its functional-currency equivalent and the rate used.
-- Previously a foreign-currency card posted at par, misstating the
-- liability, and subsidiary-scoped close and reports could not filter
-- stored-value balances because they ran org-wide.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- The issuing legal entity: the source document's subsidiary, else the
-- org's root subsidiary, else the org's sole subsidiary. Any account still
-- unattributed afterwards stops the upgrade below by name.
ALTER TABLE public.stored_value_accounts ADD COLUMN subsidiary_id uuid;

UPDATE public.stored_value_accounts a
   SET subsidiary_id = COALESCE(
     (SELECT d.subsidiary_id
        FROM public.documents d
       WHERE d.org_id = a.org_id AND d.id = a.source_document_id),
     (SELECT r.id
        FROM public.subsidiaries r
       WHERE r.org_id = a.org_id AND r.parent_id IS NULL),
     (SELECT s.id
        FROM public.subsidiaries s
       WHERE s.org_id = a.org_id
         AND (SELECT count(*) FROM public.subsidiaries s2 WHERE s2.org_id = a.org_id) = 1
       ORDER BY s.id LIMIT 1)
   )
 WHERE a.subsidiary_id IS NULL;

-- Every entry carries the functional equivalent and the rate behind it: par
-- by definition when the card currency is the subsidiary's own, else the
-- source document's rate, else the rate the source journal actually posted
-- at. Entries with neither are refused below, never priced at 1.0 silently.
ALTER TABLE public.stored_value_entries ADD COLUMN functional_amount_minor bigint;
ALTER TABLE public.stored_value_entries ADD COLUMN fx_rate numeric(19,10);

-- The one-time backfill writes posted rows, which the immutability trigger
-- below otherwise forbids. The trigger is re-enabled before this migration
-- commits, so no live write ever bypasses it.
ALTER TABLE public.stored_value_entries DISABLE TRIGGER stored_value_entries_immutable_trigger;

WITH attributed AS (
  SELECT e.id AS entry_id,
         e.amount_minor AS amount_minor,
         e.currency AS currency,
         sub.base_currency AS base_currency,
         d.fx_rate AS doc_rate,
         (SELECT jl.fx_rate
            FROM public.journal_lines jl
           WHERE jl.org_id = e.org_id
             AND jl.entry_id = e.journal_entry_id
             AND jl.currency = e.currency
             AND jl.fx_rate <> 1
           LIMIT 1) AS journal_rate
    FROM public.stored_value_entries e
    JOIN public.stored_value_accounts a
      ON a.org_id = e.org_id AND a.id = e.account_id
    JOIN public.subsidiaries sub
      ON sub.org_id = a.org_id AND sub.id = a.subsidiary_id
    LEFT JOIN public.documents d
      ON d.org_id = e.org_id AND d.id = e.document_id
   WHERE e.functional_amount_minor IS NULL
)
UPDATE public.stored_value_entries e
   SET fx_rate = x.rate,
       functional_amount_minor = round(e.amount_minor::numeric * x.rate)::bigint
  FROM (SELECT entry_id,
               CASE
                 WHEN currency = base_currency THEN numeric '1'
                 WHEN doc_rate IS NOT NULL AND doc_rate <> 1 THEN doc_rate
                 ELSE journal_rate
               END AS rate
          FROM attributed) x
 WHERE e.id = x.entry_id
   AND x.rate IS NOT NULL;

ALTER TABLE public.stored_value_entries ENABLE TRIGGER stored_value_entries_immutable_trigger;

-- A stored-value liability is a monetary item (a fixed foreign-currency
-- obligation), so accounts carrying one join the period-end FX revaluation
-- like any other monetary balance outside the default types. Only an unset
-- flag is upgraded; an explicit operator opt-out is never overridden.
UPDATE public.accounts a
   SET monetary = true
 WHERE a.monetary IS NULL
   AND a.type IN ('liability_payable', 'liability_current_other')
   AND (EXISTS (SELECT 1
                  FROM public.stored_value_programs p
                 WHERE p.org_id = a.org_id AND p.liability_account_id = a.id)
     OR EXISTS (SELECT 1
                  FROM public.stored_value_accounts sa
                 WHERE sa.org_id = a.org_id AND sa.liability_account_id = a.id)
     OR EXISTS (SELECT 1
                  FROM public.orgs o
                 WHERE o.id = a.org_id
                   AND (o.settings->'controlAccounts'->>'storedValueLiability') = a.id::text));

-- Fail closed: an unattributed account or an unpriced entry stops the
-- upgrade with the remedy instead of posting history at par. The preflight
-- probe reports the same rows before the upgrade runs.
DO $stored_value_entity_fx$
DECLARE
  bad_accounts integer;
  bad_entries integer;
  bad_orgs text;
  bad_entry_orgs text;
BEGIN
  SELECT count(*),
         string_agg(DISTINCT left(a.org_id::text, 8), ', ' ORDER BY left(a.org_id::text, 8))
    INTO bad_accounts, bad_orgs
    FROM public.stored_value_accounts a
   WHERE a.subsidiary_id IS NULL;
  IF bad_accounts > 0 THEN
    RAISE EXCEPTION 'Stored-value upgrade 0527 cannot attribute % account(s) (orgs %) to a legal entity: set the issuing document''s subsidiary, or give the organization a root subsidiary, then retry the upgrade',
      bad_accounts, bad_orgs
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*),
         string_agg(DISTINCT left(e.org_id::text, 8), ', ' ORDER BY left(e.org_id::text, 8))
    INTO bad_entries, bad_entry_orgs
    FROM public.stored_value_entries e
   WHERE e.functional_amount_minor IS NULL;
  IF bad_entries > 0 THEN
    RAISE EXCEPTION 'Stored-value upgrade 0527 cannot price % entry ledger row(s) (orgs %) in the subsidiary functional currency: the card currency differs and neither the source document nor its journal carries a rate, so set the source document rate and retry the upgrade rather than posting at par',
      bad_entries, bad_entry_orgs
      USING ERRCODE = 'check_violation';
  END IF;
END
$stored_value_entity_fx$;

ALTER TABLE public.stored_value_accounts ALTER COLUMN subsidiary_id SET NOT NULL;
ALTER TABLE public.stored_value_entries ALTER COLUMN functional_amount_minor SET NOT NULL;
ALTER TABLE public.stored_value_entries ALTER COLUMN fx_rate SET NOT NULL;

ALTER TABLE public.stored_value_accounts
  ADD CONSTRAINT stored_value_accounts_subsidiary_id_fkey
  FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id);
CREATE INDEX stored_value_accounts_subsidiary
  ON public.stored_value_accounts(org_id, subsidiary_id);
