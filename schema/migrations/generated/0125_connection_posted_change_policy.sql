-- Controller-owned disposition for authoritative-source changes to posted GL.
-- Automatic mode invokes only the guarded append-only reversal/replacement
-- workflow; it does not permit in-place mutation of journal history.

alter table connections
  add column if not exists posted_change_policy text not null default 'review_required',
  add column if not exists posted_change_authorized_by uuid,
  add column if not exists posted_change_authorized_at timestamptz;

alter table connections
  drop constraint if exists connections_posted_change_policy_check,
  add constraint connections_posted_change_policy_check check (
    (posted_change_policy = 'review_required'
      and posted_change_authorized_by is null
      and posted_change_authorized_at is null)
    or
    (posted_change_policy = 'append_only_automatic'
      and posted_change_authorized_by is not null
      and posted_change_authorized_at is not null)
  );

