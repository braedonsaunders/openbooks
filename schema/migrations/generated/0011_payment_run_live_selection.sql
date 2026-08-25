-- OpenBooks forward migration 0011_payment_run_live_selection.
--
-- An open item was unique only within one payment run, so two operators (or
-- an operator and the scheduler) could reserve the same bill or credit in
-- overlapping live runs. Item status is the reservation lifecycle: selected
-- rows reserve their source line; paid, returned, reversed, and excluded rows
-- do not. PostgreSQL is the final authority for that cross-run invariant.
--
-- Item status also follows its instruction's lifecycle, so that fan-out is
-- fenced to the instruction's OWN run: a cross-run instruction reference —
-- a payment-run item pointing at another run's instruction — must never be
-- advanced or released by it. The composite key below makes such references
-- unrepresentable, and every instruction-driven repair and trigger update
-- predicates on the owning run as defense in depth.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Freeze all three lifecycle relations while historical item status is brought
-- in line with its instruction/run. Bootstrap applies this file in one
-- transaction, so no new selection can slip between the repair and the index.
LOCK TABLE public.payment_runs,
           public.payment_instructions,
           public.payment_run_items
  IN SHARE ROW EXCLUSIVE MODE;

UPDATE public.payment_run_items item
   SET status = CASE
         WHEN instruction.status IN ('sent', 'settled') THEN 'paid'
         WHEN instruction.status IN ('returned', 'rejected') THEN 'returned'
         WHEN instruction.status = 'reversed' THEN 'reversed'
         WHEN instruction.status = 'cancelled' THEN 'excluded'
         ELSE item.status
       END,
       exclusion_reason = CASE
         WHEN instruction.status = 'cancelled'
           THEN coalesce(nullif(btrim(item.exclusion_reason), ''), 'payment instruction cancelled')
         ELSE NULL
       END,
       updated_at = now(),
       updated_by = coalesce(instruction.updated_by, item.updated_by)
   FROM public.payment_instructions instruction
  WHERE instruction.id = item.payment_instruction_id
    AND instruction.org_id = item.org_id
    AND item.payment_run_id = instruction.payment_run_id
    AND item.status = 'selected'
    AND instruction.status IN ('sent', 'settled', 'returned', 'rejected', 'reversed', 'cancelled');

UPDATE public.payment_run_items item
   SET status = 'excluded',
       exclusion_reason = coalesce(
         nullif(btrim(item.exclusion_reason), ''),
         'payment run ' || replace(run.status, '_', ' ')
       ),
       updated_at = now(),
       updated_by = coalesce(run.updated_by, item.updated_by)
  FROM public.payment_runs run
 WHERE run.id = item.payment_run_id
   AND run.org_id = item.org_id
   AND item.status = 'selected'
   AND run.status IN ('cancelled', 'rejected', 'rolled_back');

-- Refuse to guess which genuinely live run should keep a reservation. Such a
-- choice changes an operator-approved payment population and must be resolved
-- explicitly before deployment.
DO $payment_run_live_selection_preflight$
DECLARE
  duplicate_org_id uuid;
  duplicate_open_line_id uuid;
  live_run_count integer;
BEGIN
  SELECT item.org_id, item.source_open_line_id, count(*)::integer
    INTO duplicate_org_id, duplicate_open_line_id, live_run_count
    FROM public.payment_run_items item
   WHERE item.status = 'selected'
   GROUP BY item.org_id, item.source_open_line_id
  HAVING count(*) > 1
   ORDER BY item.org_id, item.source_open_line_id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'cannot enforce live payment-run selection: org % open line % is reserved by % live runs',
      duplicate_org_id,
      duplicate_open_line_id,
      live_run_count
      USING
        ERRCODE = '23505',
        HINT = 'Cancel or resolve the duplicate payment runs, then rerun this migration.';
  END IF;
END
$payment_run_live_selection_preflight$;

-- A payment-run item may reference only an instruction of its own payment
-- run: the lifecycle fan-out below would otherwise let one run's instruction
-- advance or release another run's reservation. Refuse to guess which run a
-- stray item belongs to — that choice changes an operator-approved payment
-- population and must be resolved explicitly before deployment.
DO $payment_run_item_instruction_run_preflight$
DECLARE
  stray_org_id uuid;
  stray_item_id uuid;
BEGIN
  SELECT item.org_id, item.id
    INTO stray_org_id, stray_item_id
    FROM public.payment_run_items item
    JOIN public.payment_instructions instruction
      ON instruction.id = item.payment_instruction_id
     AND instruction.org_id = item.org_id
   WHERE instruction.payment_run_id <> item.payment_run_id
   ORDER BY item.org_id, item.id
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'cannot enforce live payment-run selection: org % payment-run item % references an instruction of another payment run',
      stray_org_id,
      stray_item_id
      USING
        ERRCODE = '23503',
        HINT = 'Re-point the item at an instruction of its own payment run (or clear the reference while its run is a draft), then rerun this migration.';
  END IF;
END
$payment_run_item_instruction_run_preflight$;

CREATE UNIQUE INDEX payment_run_items_live_source
  ON public.payment_run_items USING btree (org_id, source_open_line_id)
  WHERE status = 'selected';

COMMENT ON INDEX public.payment_run_items_live_source IS
  'One live payment-run reservation per organization and source open line.';

-- Make cross-run instruction references unrepresentable at write time: an
-- item's (org, run) must equal its instruction's (org, run). MATCH SIMPLE
-- keeps draft-run assembly working — items may carry a null instruction until
-- their run associates one of its own.
CREATE UNIQUE INDEX payment_instructions_run_identity
  ON public.payment_instructions USING btree (org_id, payment_run_id, id);

ALTER TABLE public.payment_run_items
  ADD CONSTRAINT payment_run_items_instruction_run
  FOREIGN KEY (org_id, payment_run_id, payment_instruction_id)
  REFERENCES public.payment_instructions (org_id, payment_run_id, id)
  DEFERRABLE;

COMMENT ON INDEX public.payment_instructions_run_identity IS
  'Referenced key of payment_run_items_instruction_run; id alone is already unique, so this adds no restriction of its own.';

COMMENT ON CONSTRAINT payment_run_items_instruction_run ON public.payment_run_items IS
  'A payment-run item references only an instruction of its own payment run and organization; cross-run instruction references are unrepresentable.';

-- Keep the denormalized item lifecycle authoritative no matter which engine
-- path advances an instruction (outbound payment, direct debit, settlement,
-- return, or cancellation). Every branch predicates on the instruction's own
-- run, so a cross-run reference can never move another run's reservation —
-- the composite key above makes those unrepresentable anyway; this is the
-- trigger holding the same line.
CREATE FUNCTION public.payment_run_item_instruction_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status in ('sent', 'settled') then
    update public.payment_run_items
       set status = 'paid', exclusion_reason = null,
           updated_at = now(), updated_by = new.updated_by
     where org_id = new.org_id
       and payment_run_id = new.payment_run_id
       and payment_instruction_id = new.id
       and status = 'selected';
  elsif new.status in ('returned', 'rejected') then
    update public.payment_run_items
       set status = 'returned', exclusion_reason = null,
           updated_at = now(), updated_by = new.updated_by
     where org_id = new.org_id
       and payment_run_id = new.payment_run_id
       and payment_instruction_id = new.id
       and status in ('selected', 'paid');
  elsif new.status = 'reversed' then
    update public.payment_run_items
       set status = 'reversed', exclusion_reason = null,
           updated_at = now(), updated_by = new.updated_by
     where org_id = new.org_id
       and payment_run_id = new.payment_run_id
       and payment_instruction_id = new.id
       and status in ('selected', 'paid', 'returned');
  elsif new.status = 'cancelled' then
    update public.payment_run_items
       set status = 'excluded',
           exclusion_reason = coalesce(
             nullif(btrim(exclusion_reason), ''),
             'payment instruction cancelled'
           ),
           updated_at = now(), updated_by = new.updated_by
     where org_id = new.org_id
       and payment_run_id = new.payment_run_id
       and payment_instruction_id = new.id
       and status = 'selected';
  end if;

  return new;
end $$;

CREATE TRIGGER payment_run_item_instruction_lifecycle
  AFTER UPDATE OF status ON public.payment_instructions
  FOR EACH ROW
  EXECUTE FUNCTION public.payment_run_item_instruction_lifecycle();

-- Rejection and rollback occur in the payment-operations service while draft
-- cancellation occurs in payments. A run-level trigger releases every one of
-- those non-posted terminal populations consistently. Posted/returned items
-- advance only from their instruction state above, so inconsistent legacy data
-- remains reserved for explicit repair instead of being guessed into "paid".
CREATE FUNCTION public.payment_run_item_run_lifecycle() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if new.status in ('cancelled', 'rejected', 'rolled_back') then
    update public.payment_run_items
       set status = 'excluded',
           exclusion_reason = coalesce(
             nullif(btrim(exclusion_reason), ''),
             'payment run ' || replace(new.status, '_', ' ')
           ),
           updated_at = now(), updated_by = new.updated_by
     where org_id = new.org_id
       and payment_run_id = new.id
       and status = 'selected';
  end if;

  return new;
end $$;

CREATE TRIGGER payment_run_item_run_lifecycle
  AFTER UPDATE OF status ON public.payment_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.payment_run_item_run_lifecycle();
