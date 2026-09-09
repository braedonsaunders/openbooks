-- Cached document balances are denominated in the document currency, not the
-- functional currency of its journal. Only the posted_entry_id representation
-- contributes; parallel books must never be added together.
-- Run in the migration runner's transaction. The bounded fence drains existing
-- document/application writers before replacing the trigger calculation and
-- healing projections. On lock or statement timeout, roll back and retry during
-- a quieter window. No journal/application evidence is rewritten.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
LOCK TABLE public.documents, public.applications IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.document_open_balance_amount(
  p_org uuid, p_entry uuid, p_currency text, p_status text
) RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count bigint;
  v_valid boolean;
  v_balance numeric;
BEGIN
  IF p_status = 'voided' OR p_entry IS NULL THEN RETURN NULL; END IF;
  SELECT count(jl.id),
         bool_and(jl.currency = p_currency),
         sum(abs(jl.txn_amount)) - coalesce(sum(ap.applied), 0)
    INTO v_count, v_valid, v_balance
    FROM public.journal_lines jl
    LEFT JOIN LATERAL (
      SELECT sum(CASE WHEN a.from_line_id = jl.id
                      THEN a.source_transaction_amount
                      ELSE a.target_transaction_amount END) AS applied
        FROM public.applications a
       WHERE a.org_id = p_org AND a.unapplied_at IS NULL
         AND (a.from_line_id = jl.id OR a.to_line_id = jl.id)
    ) ap ON true
   WHERE jl.entry_id = p_entry AND jl.org_id = p_org AND jl.is_open_item;
  IF v_count = 0 THEN RETURN NULL; END IF;
  IF v_valid IS NOT TRUE THEN
    RAISE EXCEPTION 'document open-item currency mismatch: org %, posted entry %, expected currency %',
      p_org, p_entry, p_currency
      USING ERRCODE = '23514';
  END IF;
  RETURN v_balance;
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_document_open_balance(p_doc uuid)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Different open lines can receive applications concurrently. Acquire the
  -- shared document lock BEFORE starting the calculation statement so its
  -- READ COMMITTED snapshot includes the previous lock holder's settlement.
  PERFORM d.id FROM public.documents d WHERE d.id = p_doc FOR UPDATE;
  UPDATE public.documents d
     SET open_balance = public.document_open_balance_amount(
       d.org_id, d.posted_entry_id, d.currency, d.status::text)
   WHERE d.id = p_doc;
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_document_open_balances(p_org uuid)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ids uuid[];
  v_healed integer;
BEGIN
  -- Fence exactly the existing projections selected for this repair. New
  -- documents committed after this statement remain owned by their triggers;
  -- including an unlocked newcomer in the next statement would reintroduce
  -- the stale-snapshot race. Lock order is deterministic across bulk repairs.
  SELECT array_agg(locked.id) INTO v_ids
    FROM (
      SELECT d.id FROM public.documents d
       WHERE d.org_id = p_org
         AND (d.posted_entry_id IS NOT NULL OR d.open_balance IS NOT NULL)
       ORDER BY d.id FOR UPDATE
    ) locked;
  WITH balances AS MATERIALIZED (
    SELECT d.id, public.document_open_balance_amount(
             d.org_id, d.posted_entry_id, d.currency, d.status::text) AS balance
      FROM public.documents d
     WHERE d.org_id = p_org AND d.id = ANY(v_ids)
  )
  UPDATE public.documents d SET open_balance = b.balance
    FROM balances b
   WHERE d.id = b.id AND d.org_id = p_org
     AND d.open_balance IS DISTINCT FROM b.balance;
  GET DIAGNOSTICS v_healed = ROW_COUNT;
  RETURN v_healed;
END;
$$;

-- MATERIALIZED evaluates the indexed per-entry calculation once per document.
-- Update only drifted caches, including stale voided/no-open-item projections.
WITH balances AS MATERIALIZED (
  SELECT d.id, d.org_id,
         public.document_open_balance_amount(
           d.org_id, d.posted_entry_id, d.currency, d.status::text) AS balance
    FROM public.documents d
   WHERE d.posted_entry_id IS NOT NULL OR d.open_balance IS NOT NULL
)
UPDATE public.documents d
   SET open_balance = b.balance
  FROM balances b
 WHERE d.id = b.id AND d.org_id = b.org_id
   AND d.open_balance IS DISTINCT FROM b.balance;
