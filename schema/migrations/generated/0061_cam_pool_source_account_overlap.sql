-- OpenBooks forward migration 0061_cam_pool_source_account_overlap.
--
-- CAM pools are per-property recovery buckets over a set of GL expense
-- accounts and an inclusive date window. finalizeCamPool independently sums
-- the full posted journal activity for whichever accounts the pool selects,
-- and billCamReconciliation invoices every reconciliation allocation — so two
-- non-cancelled pools for the same property whose windows overlap and whose
-- expense_account_ids intersect feed the SAME source expense into TWO tenant
-- reconciliations. The stored uniqueness (org, property, fiscal_year, name)
-- never prevented it: equally named windows and differently named duplicates
-- both pass. Under READ COMMITTED even a serial-looking SELECT EXISTS check in
-- the API is blind to a mutually uncommitted twin, exactly like the guards
-- retired by 0051 — an application-level read can never close that race.
--
-- The storage boundary therefore owns exclusivity, following the advisory-
-- serialization precedent of subsidiary_tree_guard (0045) and
-- segment_value_guard (0047): a BEFORE INSERT OR UPDATE trigger takes one
-- transaction-scoped advisory lock per (org, property) BEFORE reading, so any
-- racing create/create or update/create pair serializes on the fence and the
-- second writer's re-read sees the first writer's committed row under READ
-- COMMITTED. A GiST daterange exclusion constraint cannot express "windows
-- overlap AND jsonb account arrays intersect" without a normalized shadow
-- table; the locked trigger encodes the predicate directly and arbitrates
-- every writer — API, import, script, or direct SQL.
--
-- Semantics enforced everywhere:
--   * no two non-cancelled pools of one property may share any expense
--     account across overlapping windows;
--   * adjacent windows (day-gap successors such as July→August) remain valid;
--   * disjoint account sets may still share a window;
--   * retiring a pool to 'cancelled' always succeeds and frees its sources
--     for reuse;
--   * account identifiers compare case-insensitively so hand-copied UUID
--     casing cannot sneak past the fence.
--
-- Rollout order mirrors 0051: repair first, then install enforcement, so the
-- trigger is born on top of data it would itself accept.
--
-- Repair policy (non-destructive):
--   1. Conflict pairs where BOTH pools are financially committed (finalized,
--      invoiced, or carrying billed allocations) hold real recovery history in
--      both directions. Nothing is rewritten and nothing is guessed: the
--      migration aborts naming both pools for manual resolution, matching
--      0051's consolidation-used rule.
--   2. Every other losing pool still sits behind an editable commitment —
--      draft/open, or finalized-but-unbilled where no actuals reached tenant
--      documents yet. Cancelling it removes only its ability to bill: rows,
--      computed allocations, and audit history remain intact for review.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- 'cancelled' has been part of the product's pool lifecycle (schema enum and
-- cancelCamPool) since launch, but the baseline's status check constraint was
-- published without it: every cancel attempt failed with 23514 on main. The
-- overlap repair below relies on retiring shadows, so widen the domain first.
-- Widening accepts every row the table can already contain, so validation is
-- a no-op scan and never rewrites data.
ALTER TABLE public.cam_pools
  DROP CONSTRAINT cam_pools_status_chk;
ALTER TABLE public.cam_pools
  ADD CONSTRAINT cam_pools_status_chk
  CHECK (status = ANY (ARRAY['draft'::text, 'open'::text, 'finalized'::text, 'invoiced'::text, 'cancelled'::text])) NOT VALID;
ALTER TABLE public.cam_pools
  VALIDATE CONSTRAINT cam_pools_status_chk;

DO $cam_pool_source_overlap_repair$
DECLARE
  v_keep_id uuid;
  v_keep_name text;
  v_lose_id uuid;
  v_lose_name text;
  v_cancelled integer;
  v_total_cancelled integer := 0;
BEGIN
  -- Committed-vs-committed conflicts carry billing history on both sides;
  -- resolving them automatically would rewrite recovery decisions. Refuse
  -- loudly with the offending pools named, like 0051 does for ownership.
  SELECT keeper.id::text, keeper.name, loser.id::text, loser.name
    INTO v_keep_id, v_keep_name, v_lose_id, v_lose_name
    FROM public.cam_pools keeper
    JOIN public.cam_pools loser
      ON loser.org_id = keeper.org_id
     AND loser.property_id = keeper.property_id
     AND loser.id <> keeper.id
     AND loser.period_starts_on <= keeper.period_ends_on
     AND loser.period_ends_on >= keeper.period_starts_on
    WHERE keeper.status <> 'cancelled'
      AND loser.status <> 'cancelled'
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(keeper.expense_account_ids) ka
         WHERE lower(ka) IN (SELECT lower(la) FROM jsonb_array_elements_text(loser.expense_account_ids) la)
      )
      AND (keeper.status IN ('finalized', 'invoiced')
           OR EXISTS (SELECT 1 FROM public.cam_allocations a
                       WHERE a.org_id = keeper.org_id AND a.pool_id = keeper.id
                         AND a.invoice_document_id IS NOT NULL))
      AND (loser.status IN ('finalized', 'invoiced')
           OR EXISTS (SELECT 1 FROM public.cam_allocations a
                       WHERE a.org_id = loser.org_id AND a.pool_id = loser.id
                         AND a.invoice_document_id IS NOT NULL))
    LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'cam_pools repair: financially committed CAM pools "%" (%) and "%" (%) share expense accounts over overlapping windows - resolve them manually before migrating',
      v_keep_name, v_keep_id, v_lose_name, v_lose_id;
  END IF;

  -- Retire every still-editable loser that a surviving conflict out-ranks:
  -- committed pools beat editable ones, otherwise earlier creation keeps the
  -- sources (created_at/id tiebreak makes the winner relation a total order,
  -- so pass results never flip-flop; cancelled rows leave the join and the
  -- loop converges within one pass per pool depth).
  LOOP
    WITH pools AS (
      SELECT p.*,
             (p.status IN ('finalized', 'invoiced')
              OR EXISTS (SELECT 1 FROM public.cam_allocations a
                          WHERE a.org_id = p.org_id AND a.pool_id = p.id
                            AND a.invoice_document_id IS NOT NULL)) AS committed
        FROM public.cam_pools p
       WHERE p.status <> 'cancelled'
    ), doomed AS (
      SELECT DISTINCT loser.id
        FROM pools keeper
        JOIN pools loser
          ON loser.org_id = keeper.org_id
         AND loser.property_id = keeper.property_id
         AND loser.id <> keeper.id
         AND loser.period_starts_on <= keeper.period_ends_on
         AND loser.period_ends_on >= keeper.period_starts_on
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(loser.expense_account_ids) la
            WHERE lower(la) IN (
              SELECT lower(ka) FROM jsonb_array_elements_text(keeper.expense_account_ids) ka
            )
         )
       WHERE NOT loser.committed
         AND (keeper.committed
              OR ((keeper.created_at, keeper.id) < (loser.created_at, loser.id)))
    )
    UPDATE public.cam_pools cp
       SET status = 'cancelled', updated_at = now()
      FROM doomed
     WHERE cp.id = doomed.id;
    GET DIAGNOSTICS v_cancelled = ROW_COUNT;
    EXIT WHEN v_cancelled = 0;
    v_total_cancelled := v_total_cancelled + v_cancelled;
  END LOOP;

  RAISE NOTICE 'cam_pools repair: % shadow pool(s) cancelled because a surviving pool out-ranked them over shared sources in overlapping windows',
    v_total_cancelled;
END
$cam_pool_source_overlap_repair$;

CREATE FUNCTION public.cam_pool_source_account_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_conflict public.cam_pools%ROWTYPE;
BEGIN
  -- Retiring a pool always succeeds and releases its sources for reuse.
  IF new.status = 'cancelled' THEN
    RETURN new;
  END IF;

  -- Serialize this property's pool lifecycle BEFORE reading, so mutually
  -- uncommitted writers cannot each pass the overlap check: under READ
  -- COMMITTED every statement takes its snapshot after acquiring the lock,
  -- and the second writer therefore sees the first writer's row.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('cam-pool:' || new.org_id::text || ':' || new.property_id::text, 0)
  );

  SELECT other.*
    INTO v_conflict
    FROM public.cam_pools other
   WHERE other.org_id = new.org_id
     AND other.property_id = new.property_id
     AND (TG_OP = 'INSERT' OR other.id <> new.id)
     AND other.status <> 'cancelled'
     AND other.period_starts_on <= new.period_ends_on
     AND other.period_ends_on >= new.period_starts_on
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(new.expense_account_ids) wanted(account)
        WHERE lower(account) IN (
          SELECT lower(shared) FROM jsonb_array_elements_text(other.expense_account_ids) shared
        )
     )
   ORDER BY other.created_at, other.id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'CAM pools cannot overlap periods while sharing any expense account: pool "%" (% to %) already bills these sources for this property over an overlapping window',
      v_conflict.name, v_conflict.period_starts_on::text, v_conflict.period_ends_on::text;
  END IF;

  RETURN new;
END $$;

CREATE TRIGGER cam_pool_source_account_guard
    BEFORE INSERT OR UPDATE ON public.cam_pools
    FOR EACH ROW EXECUTE FUNCTION public.cam_pool_source_account_guard();

COMMENT ON FUNCTION public.cam_pool_source_account_guard() IS
  'openbooks:cam_pool_source_account_guard:v1 - at most one non-cancelled CAM pool per property may bill a given expense account across an overlapping window; a per-(org,property) transaction advisory fence serializes racing create/update writers so neither can claim shared sources twice';
