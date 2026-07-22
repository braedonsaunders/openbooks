-- Canonical customer identity across the NetSuite and AdminApp2 imports.
-- Both sources use the NetSuite internal customer id. Collapse existing pairs,
-- preserve every foreign-key relationship, then enforce the identity in SQL.

set local app.bypass_rls = 'on';

create temp table _customer_party_merge (
  duplicate_id uuid primary key,
  canonical_id uuid not null,
  org_id uuid not null,
  external_id text not null
) on commit drop;

insert into _customer_party_merge (duplicate_id, canonical_id, org_id, external_id)
select admin_party.id,
       netsuite_party.id,
       admin_party.org_id,
       netsuite_party.custom->>'nsId'
  from parties admin_party
  join parties netsuite_party
    on netsuite_party.org_id = admin_party.org_id
   and netsuite_party.id <> admin_party.id
   and netsuite_party.custom->>'nsId' = admin_party.custom->'source'->>'externalId'
 where admin_party.custom->'source'->>'system' = 'adminapp2'
   and nullif(admin_party.custom->'source'->>'externalId', '') is not null;

do $$
begin
  if exists (
    select 1
      from _customer_party_merge merge_map
      join crm_account_profiles canonical_profile on canonical_profile.party_id = merge_map.canonical_id
      join crm_account_profiles duplicate_profile on duplicate_profile.party_id = merge_map.duplicate_id
  ) then
    raise exception 'canonical customer merge found two CRM profiles for one source customer';
  end if;
end $$;

-- Preserve the canonical NetSuite identity and enrich it with any source-only
-- values carried by the AdminApp2 row.
update parties canonical
   set kind = coalesce(canonical.kind, duplicate.kind),
       legal_name = coalesce(canonical.legal_name, duplicate.legal_name),
       short_code = coalesce(canonical.short_code, duplicate.short_code),
       email = coalesce(canonical.email, duplicate.email),
       phone = coalesce(canonical.phone, duplicate.phone),
       website = coalesce(canonical.website, duplicate.website),
       subsidiary_id = coalesce(canonical.subsidiary_id, duplicate.subsidiary_id),
       is_active = canonical.is_active or duplicate.is_active,
       tax_ids = duplicate.tax_ids || canonical.tax_ids,
       custom = duplicate.custom || canonical.custom,
       updated_at = now()
  from _customer_party_merge merge_map
  join parties duplicate on duplicate.id = merge_map.duplicate_id
 where canonical.id = merge_map.canonical_id;

-- customer_roles is one-to-one. Merge the role payload first, then remove the
-- redundant role so the remaining foreign keys can move without a conflict.
update customer_roles canonical
   set ar_account_id = coalesce(canonical.ar_account_id, duplicate.ar_account_id),
       payment_terms_id = coalesce(canonical.payment_terms_id, duplicate.payment_terms_id),
       credit_limit = coalesce(canonical.credit_limit, duplicate.credit_limit),
       currency = coalesce(canonical.currency, duplicate.currency),
       sales_rep_id = coalesce(canonical.sales_rep_id, duplicate.sales_rep_id),
       tax_code_id = coalesce(canonical.tax_code_id, duplicate.tax_code_id),
       is_active = canonical.is_active or duplicate.is_active,
       custom = duplicate.custom || canonical.custom,
       updated_at = now()
  from _customer_party_merge merge_map
  join customer_roles duplicate on duplicate.party_id = merge_map.duplicate_id
 where canonical.party_id = merge_map.canonical_id;

delete from customer_roles duplicate
 using _customer_party_merge merge_map
 where duplicate.party_id = merge_map.duplicate_id
   and exists (select 1 from customer_roles canonical where canonical.party_id = merge_map.canonical_id);

update customer_roles role
   set party_id = merge_map.canonical_id,
       updated_at = now()
  from _customer_party_merge merge_map
 where role.party_id = merge_map.duplicate_id;

-- Avoid collisions on the party/subsidiary uniqueness constraint.
delete from party_subsidiaries duplicate
 using _customer_party_merge merge_map
 where duplicate.party_id = merge_map.duplicate_id
   and exists (
     select 1 from party_subsidiaries canonical
      where canonical.party_id = merge_map.canonical_id
        and canonical.subsidiary_id = duplicate.subsidiary_id
   );

update party_subsidiaries relation
   set party_id = merge_map.canonical_id,
       updated_at = now()
  from _customer_party_merge merge_map
 where relation.party_id = merge_map.duplicate_id;

-- CRM account links are polymorphic, so they are intentionally not foreign
-- keys and need an explicit conflict-safe move.
insert into crm_activity_links
  (org_id, activity_id, subject_kind, subject_id, created_at, created_by, updated_at, updated_by)
select link.org_id, link.activity_id, link.subject_kind, merge_map.canonical_id,
       link.created_at, link.created_by, now(), link.updated_by
  from crm_activity_links link
  join _customer_party_merge merge_map on merge_map.duplicate_id = link.subject_id
 where link.subject_kind = 'account'
on conflict (activity_id, subject_kind, subject_id) do nothing;

delete from crm_activity_links link
 using _customer_party_merge merge_map
 where link.subject_kind = 'account'
   and link.subject_id = merge_map.duplicate_id;

-- Move every declared foreign key to parties. Role/subsidiary rows were handled
-- above because they carry one-to-one or unique constraints.
do $$
declare
  reference record;
begin
  for reference in
    select namespace.nspname as schema_name,
           relation.relname as table_name,
           attribute.attname as column_name
      from pg_constraint constraint_row
      join pg_class relation on relation.oid = constraint_row.conrelid
      join pg_namespace namespace on namespace.oid = relation.relnamespace
      join unnest(constraint_row.conkey) with ordinality key_column(attnum, ordinal) on true
      join pg_attribute attribute
        on attribute.attrelid = relation.oid
       and attribute.attnum = key_column.attnum
     where constraint_row.contype = 'f'
       and constraint_row.confrelid = 'parties'::regclass
       and array_length(constraint_row.conkey, 1) = 1
       and not (relation.relname = 'customer_roles' and attribute.attname = 'party_id')
       and not (relation.relname = 'party_subsidiaries' and attribute.attname = 'party_id')
  loop
    execute format(
      'update %I.%I target set %I = merge_map.canonical_id from _customer_party_merge merge_map where target.%I = merge_map.duplicate_id',
      reference.schema_name,
      reference.table_name,
      reference.column_name,
      reference.column_name
    );
  end loop;
end $$;

-- These logical party references exist in installations that predate their FK
-- constraints. Update them when the table/column is present.
do $$
declare
  reference record;
begin
  for reference in
    select * from (values
      ('contacts', 'party_id'),
      ('dunning_log', 'party_id'),
      ('subscriptions', 'customer_id'),
      ('users', 'party_id'),
      ('projects', 'foreman_id'),
      ('projects', 'manager_id')
    ) as logical_reference(table_name, column_name)
  loop
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = reference.table_name
         and column_name = reference.column_name
    ) then
      execute format(
        'update public.%I target set %I = merge_map.canonical_id from _customer_party_merge merge_map where target.%I = merge_map.duplicate_id',
        reference.table_name,
        reference.column_name,
        reference.column_name
      );
    end if;
  end loop;
end $$;

delete from parties duplicate
 using _customer_party_merge merge_map
 where duplicate.id = merge_map.duplicate_id;

create unique index if not exists parties_org_netsuite_customer_identity
  on parties (
    org_id,
    (coalesce(
      nullif(custom->>'nsId', ''),
      case when custom->'source'->>'system' = 'adminapp2'
           then nullif(custom->'source'->>'externalId', '')
      end
    ))
  )
  where coalesce(
    nullif(custom->>'nsId', ''),
    case when custom->'source'->>'system' = 'adminapp2'
         then nullif(custom->'source'->>'externalId', '')
    end
  ) is not null;
