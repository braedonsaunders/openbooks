-- OpenBooks forward migration 0433_fund_balancing.
-- Balancing custom segments are enforced by the journal statement validator;
-- fund metadata remains attached to the fund segment value.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE UNIQUE INDEX segment_values_org_id_id_unique
  ON public.segment_values (org_id, id);
CREATE UNIQUE INDEX segment_definitions_org_id_id_unique
  ON public.segment_definitions (org_id, id);

ALTER TABLE public.segment_definitions
  ADD COLUMN is_balancing boolean NOT NULL DEFAULT false,
  ADD COLUMN default_value_id uuid,
  ADD COLUMN feature_key text;

ALTER TABLE public.segment_definitions
  ADD CONSTRAINT segment_definitions_default_value_fkey
    FOREIGN KEY (org_id, default_value_id)
    REFERENCES public.segment_values (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE;

CREATE OR REPLACE FUNCTION public.segment_definitions_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_value_segment uuid;
  v_line_count bigint;
begin
  if new.default_value_id is not null then
    select segment_id into v_value_segment
      from public.segment_values
     where org_id = new.org_id and id = new.default_value_id;
    if not found or v_value_segment is distinct from new.id then
      raise exception 'default value % does not belong to segment %', new.default_value_id, new.key
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.is_balancing and not new.is_balancing then
    select count(*) into v_line_count
      from public.journal_lines l
      join public.journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
     where l.org_id = old.org_id
       and l.extra_dims ? old.key
       and e.status is distinct from 'draft';
    if v_line_count > 0 then
      raise exception 'segment % cannot stop balancing while % posted journal lines carry it',
        old.key, v_line_count using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

CREATE TRIGGER segment_definitions_guard
  BEFORE INSERT OR UPDATE ON public.segment_definitions
  FOR EACH ROW EXECUTE FUNCTION public.segment_definitions_guard();

CREATE OR REPLACE FUNCTION public.validate_extra_dims(
  p_org_id uuid,
  p_dims jsonb,
  p_subsidiary_id uuid DEFAULT NULL::uuid
) RETURNS void
    LANGUAGE plpgsql STABLE
    AS $$
declare d record;
begin
  if jsonb_typeof(coalesce(p_dims, '{}'::jsonb)) <> 'object' then
    raise exception 'custom segment assignments must be an object' using errcode = '23514';
  end if;
  for d in
    select pair.key, pair.value, sd.feature_key, sv.subsidiary_id,
           sv.subsidiary_include_children
      from jsonb_each_text(coalesce(p_dims, '{}'::jsonb)) pair
      left join public.segment_definitions sd
        on sd.org_id = p_org_id and sd.key = pair.key
       and sd.source_kind = 'custom' and sd.is_active
      left join public.segment_values sv
        on sv.segment_id = sd.id and sv.org_id = sd.org_id
       and sv.id::text = pair.value and sv.is_active
  loop
    if d.subsidiary_include_children is null then
      raise exception 'invalid custom segment assignment for %', d.key using errcode = '23514';
    end if;
    if d.feature_key is not null and not exists (
      select 1 from public.orgs o
       where o.id = p_org_id
         and o.settings->'features'->d.feature_key = 'true'::jsonb
         and (d.feature_key <> 'fundAccounting'
              or o.settings->'features'->'nonprofit' = 'true'::jsonb)
    ) then
      raise exception 'custom segment % requires feature %; enable it in Company Settings → Features',
        d.key, d.feature_key using errcode = '23514';
    end if;
    if d.subsidiary_id is not null and p_subsidiary_id is not null and not (
      p_subsidiary_id = d.subsidiary_id or (
        d.subsidiary_include_children and exists (
          with recursive descendants as (
            select id from public.subsidiaries
             where id = d.subsidiary_id and org_id = p_org_id
            union all
            select s.id from public.subsidiaries s
             join descendants x on s.parent_id = x.id
             where s.org_id = p_org_id
          ) select 1 from descendants where id = p_subsidiary_id
        )
      )
    ) then
      raise exception 'custom segment value % is restricted to another subsidiary', d.value
        using errcode = '23514';
    end if;
  end loop;
end $$;

CREATE OR REPLACE FUNCTION public.journal_lines_check_balanced_entries(p_entry_ids uuid[]) RETURNS void
    LANGUAGE plpgsql
    AS $$
declare
  v_bad_entry uuid;
  v_bad_subsidiary uuid;
  v_bad_total numeric(19, 4);
  v_bad_segment text;
  v_bad_value text;
begin
  -- Whole-entry balance, one re-sum per touched entry (not per line).
  select e.id, sum(l.amount)
    into v_bad_entry, v_bad_total
    from unnest(p_entry_ids) t(entry_id)
    join journal_lines l on l.entry_id = t.entry_id
    join journal_entries e on e.id = t.entry_id
   where e.status is distinct from 'draft'
   group by e.id
  having sum(l.amount) <> 0
   limit 1;
  if found then
    raise exception 'journal entry % does not balance (sum = %)', v_bad_entry, v_bad_total
      using errcode = '23514';
  end if;
  -- Per-subsidiary balance for the same touched entries.
  select l.entry_id, l.subsidiary_id, sum(l.amount)
    into v_bad_entry, v_bad_subsidiary, v_bad_total
    from unnest(p_entry_ids) t(entry_id)
    join journal_lines l on l.entry_id = t.entry_id
    join journal_entries e on e.id = t.entry_id
   where e.status is distinct from 'draft'
   group by l.entry_id, l.subsidiary_id
  having sum(l.amount) <> 0
   limit 1;
  if found then
    raise exception 'journal entry % does not balance for subsidiary % (sum = %)',
      v_bad_entry, v_bad_subsidiary, v_bad_total using errcode = '23514';
  end if;
  -- Missing values remain a distinct group; only configured balancing
  -- segments participate, so orgs without one join no segment rows.
  select e.id, sd.key, l.extra_dims->>sd.key, sum(l.amount)
    into v_bad_entry, v_bad_segment, v_bad_value, v_bad_total
    from unnest(p_entry_ids) t(entry_id)
    join journal_lines l on l.entry_id = t.entry_id
    join journal_entries e on e.id = t.entry_id
    join segment_definitions sd
      on sd.org_id = e.org_id and sd.source_kind = 'custom' and sd.is_balancing
   where e.status is distinct from 'draft'
   group by e.id, sd.key, l.extra_dims->>sd.key
  having sum(l.amount) <> 0
   order by e.id, sd.key, l.extra_dims->>sd.key
   limit 1;
  if found then
    raise exception 'journal entry % does not balance for segment % value % (sum = %)',
      v_bad_entry, v_bad_segment, coalesce(v_bad_value, '<missing>'), v_bad_total
      using errcode = '23514';
  end if;
end $$;

-- The BEFORE INSERT row triggers on journal_lines run alphabetically:
-- jl_a_stamp_posting_date, jl_check_account, jl_check_required_dimensions,
-- jl_guard, jl_stamp_balancing_defaults, journal_lines_extra_dims_guard,
-- subsidiary_ref_guard. The remaining triggers at this schema version are
-- gl_activity_line, journal_line_open_balance, party_payment_stats_date,
-- journal_lines_balanced_stmt_ins, journal_lines_balanced_stmt_upd, and
-- journal_lines_balanced_stmt_del. Thus a required custom segment is checked
-- before this default stamp, and the stamped value is validated afterward.
CREATE OR REPLACE FUNCTION public.jl_stamp_balancing_defaults() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_segment record;
begin
  for v_segment in
    select key, default_value_id
      from public.segment_definitions
     where org_id = new.org_id and source_kind = 'custom'
       and is_balancing and default_value_id is not null
     order by key
  loop
    if not (coalesce(new.extra_dims, '{}'::jsonb) ? v_segment.key) then
      new.extra_dims := jsonb_set(
        coalesce(new.extra_dims, '{}'::jsonb),
        array[v_segment.key],
        to_jsonb(v_segment.default_value_id::text),
        true
      );
    end if;
  end loop;
  return new;
end $$;

CREATE TRIGGER jl_stamp_balancing_defaults
  BEFORE INSERT ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.jl_stamp_balancing_defaults();

CREATE TABLE public.funds (
  id uuid NOT NULL,
  org_id uuid NOT NULL,
  kind text NOT NULL,
  restriction_class text NOT NULL,
  budgetary_control text NOT NULL DEFAULT 'off',
  custom jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT funds_pkey PRIMARY KEY (id),
  CONSTRAINT funds_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT funds_kind_check
    CHECK (kind IN ('operating', 'restricted', 'endowment', 'plant', 'board_designated')),
  CONSTRAINT funds_budgetary_control_check
    CHECK (budgetary_control IN ('off', 'advisory', 'hard')),
  CONSTRAINT funds_segment_value_fkey
    FOREIGN KEY (org_id, id) REFERENCES public.segment_values (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT funds_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users (id) DEFERRABLE,
  CONSTRAINT funds_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users (id) DEFERRABLE
);

CREATE INDEX funds_org_restriction_class ON public.funds (org_id, restriction_class);
ALTER TABLE public.funds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.funds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.funds
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

CREATE OR REPLACE FUNCTION public.funds_segment_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_code text;
begin
  select sv.code into v_code
    from public.segment_values sv
    join public.segment_definitions sd
      on sd.org_id = sv.org_id and sd.id = sv.segment_id
   where sv.org_id = new.org_id and sv.id = new.id and sd.key = 'fund'
     and sd.source_kind = 'custom';
  if not found or v_code is null or btrim(v_code) = '' then
    raise exception 'fund % must reference a coded value in the fund segment', new.id
      using errcode = '23514';
  end if;
  return new;
end $$;

CREATE TRIGGER funds_segment_guard
  BEFORE INSERT OR UPDATE OF org_id, id ON public.funds
  FOR EACH ROW EXECUTE FUNCTION public.funds_segment_guard();

CREATE OR REPLACE FUNCTION public.funds_restriction_class_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_line_count bigint;
  v_code text;
begin
  if new.restriction_class is distinct from old.restriction_class then
    select count(*) into v_line_count
      from public.journal_lines l
      join public.journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
     where l.org_id = old.org_id and l.extra_dims->>'fund' = old.id::text
       and e.status is distinct from 'draft';
    if v_line_count > 0 then
      select code into v_code from public.segment_values
       where org_id = old.org_id and id = old.id;
      raise exception 'fund % restriction class cannot change while % posted journal lines carry it',
        coalesce(v_code, old.id::text), v_line_count using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

CREATE TRIGGER funds_restriction_class_guard
  BEFORE UPDATE OF restriction_class ON public.funds
  FOR EACH ROW EXECUTE FUNCTION public.funds_restriction_class_guard();

CREATE TABLE public.fund_pairs (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  from_fund_id uuid NOT NULL,
  to_fund_id uuid NOT NULL,
  due_from_account_id uuid NOT NULL,
  due_to_account_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  CONSTRAINT fund_pairs_pkey PRIMARY KEY (id),
  CONSTRAINT fund_pairs_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT fund_pairs_org_from_to_unique UNIQUE (org_id, from_fund_id, to_fund_id),
  CONSTRAINT fund_pairs_distinct_funds_check CHECK (from_fund_id <> to_fund_id),
  CONSTRAINT fund_pairs_from_fund_fkey
    FOREIGN KEY (org_id, from_fund_id) REFERENCES public.funds (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fund_pairs_to_fund_fkey
    FOREIGN KEY (org_id, to_fund_id) REFERENCES public.funds (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fund_pairs_due_from_account_fkey
    FOREIGN KEY (org_id, due_from_account_id) REFERENCES public.accounts (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fund_pairs_due_to_account_fkey
    FOREIGN KEY (org_id, due_to_account_id) REFERENCES public.accounts (org_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT fund_pairs_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users (id) DEFERRABLE,
  CONSTRAINT fund_pairs_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users (id) DEFERRABLE
);

CREATE INDEX fund_pairs_org_to_fund ON public.fund_pairs (org_id, to_fund_id);
ALTER TABLE public.fund_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fund_pairs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.fund_pairs
  USING (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active()
      OR org_id::text = current_setting('app.current_org', true));

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in)
  VALUES ('funds', '0433'), ('fund_pairs', '0433')
  ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();
