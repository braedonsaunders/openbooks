-- Admit authenticated connector correction through its original source module.
-- Require the live, scoped controller grant while preserving every period lock.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

DO $admission$
DECLARE digest text;
BEGIN
 SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') INTO digest
 FROM pg_catalog.pg_proc WHERE oid='public.je_guard()'::regprocedure;
 IF digest NOT IN ('a2ab4792639530e9886f32cb76b77734bb1bc3f55e512c2995ce25a47d0bc853','81264b8d4c0b65a49d18fcda3fc0c4c97a3964b5d12cabed457d4c01b0485190') THEN
  RAISE EXCEPTION 'The journal guard differs from its published contract. Review its installed definition before upgrading.';
 END IF;
END $admission$;

CREATE OR REPLACE FUNCTION public.je_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_module text;
  v_replay_auth uuid;
begin
  IF TG_OP = 'DELETE' AND tenant_retirement.openbooks_tenant_retirement_delete_allowed(TG_TABLE_NAME, to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;

  if tg_op = 'DELETE' and public.openbooks_sandbox_wipe_allowed(old.org_id) then
    return old;
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'journal entry % is % and cannot be deleted', old.id, old.status;
    end if;
    perform period_posting_fence(old.org_id, old.period_id, old.book_id);
    if period_module_blocks_write(old.org_id, old.period_id, old.book_id,
         nullif(to_jsonb(old)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on') then
      raise exception 'period is closed for GL posting';
    end if;
    return old;
  end if;

  if old.status = 'posted' and new.status = 'posted' then
    raise exception 'journal entry % is posted and immutable: corrections append a reversal through the ledger API instead of editing history', old.id;
  end if;
  if old.status = 'posted' and new.status <> 'reversed' then
    raise exception 'journal entry % is posted and can only be reversed, not set to %', old.id, new.status;
  end if;
  if old.status = 'posted' and new.status = 'reversed' then
    if to_jsonb(old) - 'status' - 'updated_at' - 'updated_by' - 'posted_at'
       is distinct from
       to_jsonb(new) - 'status' - 'updated_at' - 'updated_by' - 'posted_at' then
      raise exception 'journal entry % is posted and can only be reversed without other changes', old.id;
    end if;
    if not exists (
      select 1
        from journal_entries reversal
       where reversal.org_id = old.org_id
         and reversal.book_id = old.book_id
         and reversal.reverses_entry_id = old.id
         and reversal.status = 'posted'
         and public.openbooks_reversal_mirrors(old.org_id, old.id, reversal.id)
    ) then
      raise exception 'journal entry % cannot be reversed without a posted mirror reversal in the same book', old.id;
    end if;
    return new;
  end if;
  if old.status = 'reversed' then
    raise exception 'journal entry % is reversed and immutable', old.id;
  end if;

  if old.status = 'draft' and new.status = 'posted' then
    perform period_posting_fence(new.org_id, new.period_id, new.book_id);
    if period_module_blocks_write(new.org_id, new.period_id, new.book_id,
         nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, 'gl',
         coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       or exists (
         select 1 from journal_lines l
          where l.entry_id = new.id
            and l.org_id = new.org_id
            and period_module_blocks_write(new.org_id, new.period_id, new.book_id,
              nullif(to_jsonb(l)->>'subsidiary_id', '')::uuid, 'gl',
              coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
       ) then
      begin
        v_replay_auth := nullif(current_setting('openbooks.connector_replay_authorization', true), '')::uuid;
      exception when invalid_text_representation then
        v_replay_auth := null;
      end;
      if not public.openbooks_connector_replay_authorized(new.org_id, v_replay_auth, new.period_id) then
        raise exception 'period is closed for GL posting';
      end if;
    end if;
    if new.source_document_id is not null then
      select public.document_close_module(d.kind) into v_module
        from public.documents d
       where d.id = new.source_document_id;
      if v_module is not null and v_module <> 'gl'
         and (period_module_blocks_write(new.org_id, new.period_id, new.book_id,
                nullif(to_jsonb(new)->>'subsidiary_id', '')::uuid, v_module,
                coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
              or exists (
                select 1 from journal_lines l
                 where l.entry_id = new.id
                   and l.org_id = new.org_id
                   and period_module_blocks_write(new.org_id, new.period_id, new.book_id,
                     nullif(to_jsonb(l)->>'subsidiary_id', '')::uuid, v_module,
                     coalesce(current_setting('openbooks.migration', true), 'off') = 'on')
              )) then
        begin
          v_replay_auth := nullif(current_setting('openbooks.connector_replay_authorization', true), '')::uuid;
        exception when invalid_text_representation then
          v_replay_auth := null;
        end;
        if not public.openbooks_connector_replay_authorized(new.org_id, v_replay_auth, new.period_id)
           or not public.connector_historical_replay_authorized(new.org_id) then
          raise exception 'period is closed for % posting', upper(v_module);
        end if;
      end if;
    end if;
    new.posted_at := now();
  end if;
  return new;
end $function$
