-- OpenBooks forward migration 0009_posting_effect_idempotency_keys.
--
-- Posting-effect retries previously relied on check-then-write queries. These
-- keys move the final authority into PostgreSQL: even overlapping stale and
-- replacement workers cannot create the same subledger projection twice.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.inventory_movements
  ADD COLUMN IF NOT EXISTS idempotency_key text;

UPDATE public.inventory_movements
   SET idempotency_key = 'posting-effect:inventory:' || kind || ':document-line:' || document_line_id::text
 WHERE idempotency_key IS NULL
   AND document_line_id IS NOT NULL
   AND kind IN ('receipt', 'issue');

ALTER TABLE public.inventory_movements
  DROP CONSTRAINT IF EXISTS inventory_movements_idempotency_key;
ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inventory_movements_idempotency_key
  CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 1 AND 500);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_org_idempotency
  ON public.inventory_movements USING btree (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.revenue_contracts
  ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.performance_obligations
  ADD COLUMN IF NOT EXISTS idempotency_key text;

UPDATE public.performance_obligations
   SET idempotency_key = 'posting-effect:revenue-obligation:document-line:' || document_line_id::text
 WHERE idempotency_key IS NULL
   AND document_line_id IS NOT NULL;

WITH contract_sources AS (
  SELECT obligation.contract_id,
         min(line.document_id::text)::uuid AS document_id
    FROM public.performance_obligations obligation
    JOIN public.document_lines line
      ON line.id = obligation.document_line_id
     AND line.org_id = obligation.org_id
   WHERE obligation.document_line_id IS NOT NULL
   GROUP BY obligation.contract_id
  HAVING count(DISTINCT line.document_id) = 1
)
UPDATE public.revenue_contracts contract
   SET idempotency_key = 'posting-effect:revenue-contract:document:' || source.document_id::text
  FROM contract_sources source
 WHERE contract.id = source.contract_id
   AND contract.idempotency_key IS NULL;

ALTER TABLE public.revenue_contracts
  DROP CONSTRAINT IF EXISTS revenue_contracts_idempotency_key;
ALTER TABLE public.revenue_contracts
  ADD CONSTRAINT revenue_contracts_idempotency_key
  CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 1 AND 500);

ALTER TABLE public.performance_obligations
  DROP CONSTRAINT IF EXISTS performance_obligations_idempotency_key;
ALTER TABLE public.performance_obligations
  ADD CONSTRAINT performance_obligations_idempotency_key
  CHECK (idempotency_key IS NULL OR length(btrim(idempotency_key)) BETWEEN 1 AND 500);

CREATE UNIQUE INDEX IF NOT EXISTS revenue_contracts_org_idempotency
  ON public.revenue_contracts USING btree (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS performance_obligations_org_idempotency
  ON public.performance_obligations USING btree (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.inventory_movements.idempotency_key IS
  'Stable source-effect key; unique per organization when present.';
COMMENT ON COLUMN public.revenue_contracts.idempotency_key IS
  'Stable source-effect key; unique per organization when present.';
COMMENT ON COLUMN public.performance_obligations.idempotency_key IS
  'Stable source-effect key; unique per organization when present.';
