-- Period close moved from three columns on accounting_periods to scoped rows
-- in period_locks. Replace the kernel helpers in the same upgrade sequence so
-- there is never a deployment where posting references dropped columns.
create or replace function period_module_is_closed(
  p_org uuid,
  p_period uuid,
  p_book uuid,
  p_subsidiary uuid,
  p_module text
) returns boolean
language sql stable as $$
  select coalesce(
    (select case
       when state = 'closed' then true
       when state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now() then true
       else false
     end
       from period_locks
      where org_id = p_org and period_id = p_period and book_id = p_book
        and subsidiary_id = p_subsidiary and module = p_module),
    (select case
       when state = 'closed' then true
       when state = 'open' and reopen_expires_at is not null and reopen_expires_at <= now() then true
       else false
     end
       from period_locks
      where org_id = p_org and period_id = p_period and book_id = p_book
        and subsidiary_id is null and module = p_module),
    false
  )
$$;
--> statement-breakpoint
create or replace function je_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft'
       and coalesce(current_setting('openbooks.amend', true), 'off') <> 'on' then
      raise exception 'journal entry % is % and cannot be deleted', old.id, old.status;
    end if;
    return old;
  end if;

  if old.status = 'posted' and new.status = 'posted'
     and coalesce(current_setting('openbooks.amend', true), 'off') = 'on' then
    if period_module_is_closed(old.org_id, old.period_id, old.book_id, old.subsidiary_id, 'gl')
       or period_module_is_closed(new.org_id, new.period_id, new.book_id, new.subsidiary_id, 'gl') then
      raise exception 'period is closed for GL posting';
    end if;
    return new;
  end if;

  if old.status = 'posted' and new.status = 'posted' then
    raise exception 'journal entry % is posted and immutable', old.id;
  end if;
  if old.status = 'reversed' then
    raise exception 'journal entry % is reversed and immutable', old.id;
  end if;

  if old.status = 'draft' and new.status = 'posted' then
    if period_module_is_closed(new.org_id, new.period_id, new.book_id, new.subsidiary_id, 'gl')
       or exists (
         select 1 from journal_lines l
          where l.entry_id = new.id
            and period_module_is_closed(new.org_id, new.period_id, new.book_id, l.subsidiary_id, 'gl')
       ) then
      raise exception 'period is closed for GL posting';
    end if;
    new.posted_at := now();
  end if;
  return new;
end $$;
