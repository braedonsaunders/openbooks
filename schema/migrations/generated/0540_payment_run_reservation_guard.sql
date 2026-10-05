-- OpenBooks forward migration 0540_payment_run_reservation_guard.
-- A bill, expense report, receivable or credit selected into a live payment
-- run is reserved for that run: the run's file may already be at the bank,
-- so any other settlement of the same open item pays it twice. The payment
-- service refuses such settlements by name; this trigger holds the same line
-- for every other writer of applications.
--
-- An application touching a reserved line is accepted only while the
-- reserving run is posting (status 'processing') and the application is the
-- run's own: cash from the payment document of the reserving instruction, or
-- a credit the same run reserved and planned against that exact target.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE FUNCTION public.application_respects_run_reservation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_catalog
  AS $$
declare
  v_source_document uuid;
  v_reservation record;
begin
  -- Only a live application settles anything; unapplying never pays twice.
  if new.unapplied_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.unapplied_at is null
     and new.from_line_id = old.from_line_id
     and new.to_line_id = old.to_line_id then
    return new;
  end if;
  -- The deterministic sandbox clone copies posted history verbatim.
  if public.openbooks_clone_authority() then
    return new;
  end if;

  for v_reservation in
    select item.payment_run_id, item.payment_instruction_id,
           run.run_number, run.status as run_status,
           document.document_number
      from public.payment_run_items item
      join public.payment_runs run
        on run.id = item.payment_run_id and run.org_id = item.org_id
      left join public.documents document
        on document.id = item.source_document_id and document.org_id = item.org_id
     where item.org_id = new.org_id
       and item.status = 'selected'
       and item.source_open_line_id in (new.from_line_id, new.to_line_id)
     order by item.id
  loop
    if v_reservation.run_status = 'processing' then
      -- The run's own cash: the source line belongs to the payment document
      -- of the reserving run's instruction.
      if v_source_document is null then
        select entry.source_document_id into v_source_document
          from public.journal_lines line
          join public.journal_entries entry
            on entry.id = line.entry_id and entry.org_id = line.org_id
         where line.id = new.from_line_id and line.org_id = new.org_id;
      end if;
      if v_source_document is not null and exists (
        select 1 from public.payment_instructions instruction
         where instruction.id = v_reservation.payment_instruction_id
           and instruction.org_id = new.org_id
           and instruction.payment_run_id = v_reservation.payment_run_id
           and instruction.payment_document_id = v_source_document
      ) then
        continue;
      end if;
      -- The run's own credit: the same run reserved this credit line and
      -- planned it against this exact target.
      if exists (
        select 1 from public.payment_run_items credit
         where credit.org_id = new.org_id
           and credit.payment_run_id = v_reservation.payment_run_id
           and credit.kind = 'credit'
           and credit.status = 'selected'
           and credit.source_open_line_id = new.from_line_id
           and credit.credit_target_allocations @> jsonb_build_array(
                 jsonb_build_object('toLineId', new.to_line_id::text))
      ) then
        continue;
      end if;
    end if;
    raise exception '% is reserved by payment run % (%), which will pay it; settle it through that run, or cancel or roll back the run before settling it elsewhere',
      coalesce(v_reservation.document_number, 'this open item'),
      v_reservation.run_number,
      replace(v_reservation.run_status, '_', ' ')
      using errcode = '23514';
  end loop;
  return new;
end $$;

COMMENT ON FUNCTION public.application_respects_run_reservation() IS
  'Refuses an application that settles an open item reserved by a live payment run, unless it is that run''s own cash or planned credit written while the run posts.';

CREATE TRIGGER application_respects_run_reservation
  BEFORE INSERT OR UPDATE OF from_line_id, to_line_id, unapplied_at ON public.applications
  FOR EACH ROW
  EXECUTE FUNCTION public.application_respects_run_reservation();

-- The lookup above is served by payment_run_items_live_source
-- (org_id, source_open_line_id) where status = 'selected'.
COMMENT ON TRIGGER application_respects_run_reservation ON public.applications IS
  'A line reserved by a live payment run settles only through that run.';
