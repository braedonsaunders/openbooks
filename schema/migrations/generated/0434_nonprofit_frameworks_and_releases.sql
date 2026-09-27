-- OpenBooks forward migration 0434_nonprofit_frameworks_and_releases.
-- Framework declarations and reviewed fund releases preserve their own tenant evidence.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE TABLE public.nonprofit_frameworks (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  framework text NOT NULL,
  set_at timestamp with time zone NOT NULL DEFAULT now(),
  set_by uuid NOT NULL,
  reason text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  CONSTRAINT nonprofit_frameworks_pkey PRIMARY KEY (id),
  CONSTRAINT nonprofit_frameworks_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT nonprofit_frameworks_one_per_org UNIQUE (org_id),
  CONSTRAINT nonprofit_frameworks_framework_check
    CHECK (framework IN ('us_asc958', 'ew_sorp_frs102')),
  CONSTRAINT nonprofit_frameworks_reason_nonblank
    CHECK (length(btrim(reason)) > 0),
  CONSTRAINT nonprofit_frameworks_org_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs (id) ON DELETE CASCADE,
  CONSTRAINT nonprofit_frameworks_set_by_fkey
    FOREIGN KEY (org_id, set_by) REFERENCES public.users (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT nonprofit_frameworks_created_by_fkey
    FOREIGN KEY (org_id, created_by) REFERENCES public.users (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT nonprofit_frameworks_updated_by_fkey
    FOREIGN KEY (org_id, updated_by) REFERENCES public.users (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE
);

ALTER TABLE public.nonprofit_frameworks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nonprofit_frameworks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.nonprofit_frameworks
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE OR REPLACE FUNCTION public.nonprofit_frameworks_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_line_count bigint;
  v_org_id uuid;
begin
  if tg_op = 'DELETE' and pg_catalog.pg_trigger_depth() > 1 then
    return old;
  end if;

  v_org_id := case when tg_op = 'DELETE' then old.org_id else new.org_id end;
  if tg_op = 'UPDATE' and new.org_id is distinct from old.org_id then
    raise exception 'a nonprofit framework cannot be moved to another organization'
      using errcode = '23514';
  end if;

  -- Fund line inserts use the same transaction lock, so a framework change
  -- cannot pass its history check while a fund posting is still in flight.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('openbooks:nonprofit-framework:' || v_org_id::text, 0)
  );

  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and new.framework is distinct from old.framework) then
    select count(*) into v_line_count
      from public.journal_lines jl
      join public.journal_entries je
        on je.org_id = jl.org_id and je.id = jl.entry_id
     where jl.org_id = v_org_id
       and jl.extra_dims ? 'fund'
       and je.status is distinct from 'draft';
    if v_line_count > 0 then
      raise exception 'nonprofit framework cannot change or be removed while % posted fund-tagged journal lines exist; continue with the current framework or use a separate organization',
        v_line_count
        using errcode = '23514',
              constraint = 'nonprofit_frameworks_history_guard';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

CREATE TRIGGER nonprofit_frameworks_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.nonprofit_frameworks
  FOR EACH ROW EXECUTE FUNCTION public.nonprofit_frameworks_guard();

CREATE OR REPLACE FUNCTION public.journal_lines_lock_nonprofit_framework() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if coalesce(new.extra_dims, '{}'::jsonb) ? 'fund' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('openbooks:nonprofit-framework:' || new.org_id::text, 0)
    );
  end if;
  return new;
end $$;

CREATE TRIGGER journal_lines_z_lock_nonprofit_framework
  BEFORE INSERT OR UPDATE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.journal_lines_lock_nonprofit_framework();

CREATE TABLE public.fund_releases (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  release_number text NOT NULL,
  from_fund_id uuid NOT NULL,
  to_fund_id uuid NOT NULL,
  release_account_id uuid NOT NULL,
  release_date date NOT NULL,
  amount numeric(19,4) NOT NULL,
  purpose text NOT NULL,
  satisfaction_ref text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  submitted_by uuid,
  submitted_at timestamp with time zone,
  flow_run_id uuid,
  posted_entry_id uuid,
  void_entry_id uuid,
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  CONSTRAINT fund_releases_pkey PRIMARY KEY (id),
  CONSTRAINT fund_releases_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT fund_releases_org_release_number_unique UNIQUE (org_id, release_number),
  CONSTRAINT fund_releases_org_posted_entry_unique UNIQUE (org_id, posted_entry_id),
  CONSTRAINT fund_releases_org_void_entry_unique UNIQUE (org_id, void_entry_id),
  CONSTRAINT fund_releases_distinct_funds_check
    CHECK (from_fund_id <> to_fund_id),
  CONSTRAINT fund_releases_positive_amount_check
    CHECK (amount > 0),
  CONSTRAINT fund_releases_purpose_nonblank
    CHECK (length(btrim(purpose)) > 0),
  CONSTRAINT fund_releases_satisfaction_ref_nonblank
    CHECK (length(btrim(satisfaction_ref)) > 0),
  CONSTRAINT fund_releases_status_check
    CHECK (status IN ('draft', 'pending_approval', 'posted', 'void')),
  CONSTRAINT fund_releases_lifecycle_check
    CHECK (
      (status = 'draft' AND posted_entry_id IS NULL AND void_entry_id IS NULL AND flow_run_id IS NULL)
      OR (status = 'pending_approval' AND posted_entry_id IS NULL AND void_entry_id IS NULL AND flow_run_id IS NOT NULL)
      OR (status = 'posted' AND posted_entry_id IS NOT NULL AND void_entry_id IS NULL)
      OR (status = 'void' AND posted_entry_id IS NOT NULL AND void_entry_id IS NOT NULL)
    ),
  CONSTRAINT fund_releases_org_fkey
    FOREIGN KEY (org_id) REFERENCES public.orgs (id) ON DELETE CASCADE,
  CONSTRAINT fund_releases_from_fund_fkey
    FOREIGN KEY (org_id, from_fund_id) REFERENCES public.funds (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fund_releases_to_fund_fkey
    FOREIGN KEY (org_id, to_fund_id) REFERENCES public.funds (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fund_releases_release_account_fkey
    FOREIGN KEY (org_id, release_account_id) REFERENCES public.accounts (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fund_releases_flow_run_fkey
    FOREIGN KEY (org_id, flow_run_id) REFERENCES public.flow_runs (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fund_releases_posted_entry_fkey
    FOREIGN KEY (org_id, posted_entry_id) REFERENCES public.journal_entries (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fund_releases_void_entry_fkey
    FOREIGN KEY (org_id, void_entry_id) REFERENCES public.journal_entries (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fund_releases_submitted_by_fkey
    FOREIGN KEY (org_id, submitted_by) REFERENCES public.users (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fund_releases_created_by_fkey
    FOREIGN KEY (org_id, created_by) REFERENCES public.users (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fund_releases_updated_by_fkey
    FOREIGN KEY (org_id, updated_by) REFERENCES public.users (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX fund_releases_org_status ON public.fund_releases (org_id, status);
CREATE INDEX fund_releases_org_from_fund ON public.fund_releases (org_id, from_fund_id);

ALTER TABLE public.fund_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fund_releases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.fund_releases
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('fund_releases', '0434'),
  ('nonprofit_frameworks', '0434')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
