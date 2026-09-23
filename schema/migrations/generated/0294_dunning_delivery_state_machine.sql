-- OpenBooks forward migration 0294_dunning_delivery_state_machine.
--
-- Dunning wrote a dunning_log row ONLY for a successfully deferred letter.
-- A failed deferral and an unsendable notice (no billing email) wrote
-- nothing: the rung stayed open by accident of an empty slot, with zero
-- durable evidence of what had been attempted, and the next tick could not
-- tell "never tried" from "tried and failed". Worse, the status CHECK
-- admitted no in-flight state, so the log could not serve as the
-- concurrent-tick claim either — two racing ticks serialized on an advisory
-- lock alone, and a crash between the outbox deferral and the sent insert
-- left mail queued against a claim that never existed.
--
-- The log becomes the claim and the evidence in one row per (document,
-- stage). CHECK gains 'staged' (claimed, send not yet attempted) and
-- 'suppressed' (unsendable: the customer has no billing email on file).
-- The runner opens each rung as staged — the unique (document, stage)
-- index arbitrates rival ticks onto the one row — and the send attempt
-- moves it to sent, failed, or suppressed in the same transaction as the
-- outbox deferral. A later tick re-arms failed and suppressed rows back to
-- staged for retry once the cause is fixed. 'sent' rows are terminal
-- delivery evidence: the guard below refuses every other transition, and
-- DELETE stays refused, so the log reconciles exactly with what ran.
--
-- No backfill is needed: the new CHECK is a strict superset of the old one,
-- so every existing row already satisfies it, and 'staged' rows arise only
-- from runner claims written after this migration lands.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.dunning_log DROP CONSTRAINT dunning_log_status;
ALTER TABLE public.dunning_log
  ADD CONSTRAINT dunning_log_status
  CHECK ((status = ANY (ARRAY['sent'::text, 'failed'::text, 'skipped'::text, 'staged'::text, 'suppressed'::text])));

-- The lifecycle guard. INSERT opens a new (document, stage) slot — the
-- runner always opens 'staged'; terminal evidence may be opened directly by
-- a backfill — and every UPDATE must follow the machine: the send attempt
-- moves staged to its outcome, the runner re-arms failed/suppressed to
-- staged, sent and skipped rows are terminal. Anything else, including
-- DELETE, is refused by name.
CREATE OR REPLACE FUNCTION public.dunning_log_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if current_setting('app.bypass_rls', true) = 'on' then
    return coalesce(new, old);
  end if;
  if TG_OP = 'DELETE' then
    raise exception 'dunning_log is append-only: DELETE is refused; a rung''s lifecycle moves forward through staged/sent/failed/suppressed transitions only';
  end if;
  if TG_OP = 'INSERT' then
    return new;
  end if;
  if old.status = 'sent' or old.status = 'skipped' then
    raise exception 'dunning_log % rows are terminal delivery evidence and cannot be updated; failed and suppressed rows re-arm to staged, sent rows never move', old.status;
  end if;
  if old.status = 'staged' and new.status in ('sent', 'failed', 'suppressed') then
    return new;
  end if;
  if (old.status = 'failed' or old.status = 'suppressed') and new.status = 'staged' then
    return new;
  end if;
  raise exception 'dunning_log transition % to % is refused: the send attempt may move staged to sent/failed/suppressed, and the runner may re-arm failed/suppressed to staged', old.status, new.status;
end;
$$;
