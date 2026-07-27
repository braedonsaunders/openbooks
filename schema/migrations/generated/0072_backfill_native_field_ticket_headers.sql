-- Upgrade every pre-native Field Ticket document, in every tenant, to the
-- first-class one-to-one header. The migration reads legacy JSON only as an
-- input and never writes native state back to custom fields.
with candidates as (
  select
    document.id as document_id,
    document.org_id,
    case
      when document.custom->'fieldTicket'->>'period'
             in ('shift', 'daily', 'weekly')
        then document.custom->'fieldTicket'->>'period'
      when document.custom->'legacy'->>'periodBegin' is not null
        then 'weekly'
      when time_window.min_worked_on = time_window.max_worked_on
        then 'daily'
      else 'weekly'
    end as period,
    coalesce(
      case
        when document.custom->'fieldTicket'->>'periodStart'
               ~ '^\d{4}-\d{2}-\d{2}$'
          then (document.custom->'fieldTicket'->>'periodStart')::date
      end,
      case
        when document.custom->'legacy'->>'periodBegin'
               ~ '^\d{4}-\d{2}-\d{2}$'
          then (document.custom->'legacy'->>'periodBegin')::date
      end,
      time_window.min_worked_on,
      document.document_date
    ) as period_start,
    coalesce(
      case
        when document.custom->'fieldTicket'->>'periodEnd'
               ~ '^\d{4}-\d{2}-\d{2}$'
          then (document.custom->'fieldTicket'->>'periodEnd')::date
      end,
      case
        when document.custom->'legacy'->>'periodEnd'
               ~ '^\d{4}-\d{2}-\d{2}$'
          then (document.custom->'legacy'->>'periodEnd')::date
      end,
      time_window.max_worked_on,
      document.document_date
    ) as period_end,
    coalesce(json_foreman.id, source_foreman.id, project.foreman_id,
             creator.party_id) as foreman_party_id,
    json_charge.id as charge_document_id,
    submitter.id as submitted_by,
    case
      when document.custom->'fieldTicket'->>'submittedAt'
             ~ '^\d{4}-\d{2}-\d{2}T'
        then (document.custom->'fieldTicket'->>'submittedAt')::timestamptz
    end as submitted_at,
    nullif(document.custom->'fieldTicket'->>'rejectionReason', '')
      as rejection_reason,
    document.created_by,
    document.updated_by
  from documents document
  left join projects project
    on project.id = document.project_id
   and project.org_id = document.org_id
  left join users creator
    on creator.id = document.created_by
   and creator.org_id = document.org_id
  left join lateral (
    select min(entry.worked_on) as min_worked_on,
           max(entry.worked_on) as max_worked_on
      from time_entries entry
     where entry.org_id = document.org_id
       and entry.field_ticket_id = document.id
  ) time_window on true
  left join parties json_foreman
    on json_foreman.org_id = document.org_id
   and document.custom->'fieldTicket'->>'foremanPartyId'
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and json_foreman.id =
         (document.custom->'fieldTicket'->>'foremanPartyId')::uuid
  left join parties source_foreman
    on source_foreman.org_id = document.org_id
   and source_foreman.custom->>'nsId' =
         document.custom->'legacy'->>'foremanRef'
  left join documents json_charge
    on json_charge.org_id = document.org_id
   and document.custom->'fieldTicket'->>'chargeDocumentId'
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and json_charge.id =
         (document.custom->'fieldTicket'->>'chargeDocumentId')::uuid
  left join users submitter
    on submitter.org_id = document.org_id
   and document.custom->'fieldTicket'->>'submittedBy'
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   and submitter.id =
         (document.custom->'fieldTicket'->>'submittedBy')::uuid
  where document.kind = 'field_ticket'
    and not exists (
      select 1 from field_tickets existing
       where existing.document_id = document.id
    )
),
inserted as (
  insert into field_tickets
    (document_id, org_id, period, period_start, period_end,
     foreman_party_id, charge_document_id, submitted_by, submitted_at,
     rejection_reason, created_by, updated_by, created_at, updated_at)
  select document_id, org_id, period, period_start, period_end,
         foreman_party_id, charge_document_id, submitted_by, submitted_at,
         rejection_reason, created_by, updated_by, now(), now()
    from candidates
  on conflict (document_id) do nothing
  returning document_id, org_id, period, period_start, period_end,
            foreman_party_id
)
insert into audit_log
  (org_id, table_name, row_id, action, changes, actor_id)
select inserted.org_id, 'field_tickets', inserted.document_id, 'insert',
       jsonb_build_object(
         'mode', 'native_field_ticket_schema_migration',
         'reason', 'Upgrade pre-native Field Ticket document',
         'after', jsonb_build_object(
           'period', inserted.period,
           'periodStart', inserted.period_start,
           'periodEnd', inserted.period_end,
           'foremanPartyId', inserted.foreman_party_id
         )
       ),
       null
  from inserted;
