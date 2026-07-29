import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { FieldTicketDrawerProps, TicketPayload } from '../app/(app)/field-tickets/FieldTicketDrawer'
import { can, type Authz } from './authz'
import { resolveFormLayout } from './customization/resolve'
import { isFeatureEnabled } from './features'
import { FieldTicketError, loadFieldTicket } from './field-tickets'

/**
 * Loads the canonical Field Ticket transaction drawer payload for list pages
 * and nested record contexts. Keeping this assembly in one place ensures that
 * a ticket has the same historical picker coverage and permissions wherever
 * it is opened.
 */
export async function loadFieldTicketDrawerData({
  authz,
  ticketId,
  formLayoutId,
}: {
  authz: Authz
  ticketId: string
  formLayoutId?: string
}): Promise<FieldTicketDrawerProps | null> {
  if (!can(authz, 'time.read')) return null

  const orgId = authz.user.orgId
  if (!(await isFeatureEnabled(orgId, 'fieldTickets'))) return null

  let ticket: TicketPayload
  try {
    ticket = (await loadFieldTicket(orgId, ticketId)) as unknown as TicketPayload
  } catch (error) {
    if (error instanceof FieldTicketError) return null
    throw error
  }

  const equipmentEnabled = await isFeatureEnabled(orgId, 'equipment')
  const [employees, laborItems, timeTypes, catalogItems, projects, projectTasks, equipmentUnits, resolvedForm] =
    (await Promise.all([
      db.execute(sql`
        select p.id, p.display_name as name from parties p
         where p.org_id = ${orgId} and p.is_active
           and exists (
             select 1 from employee_roles r
              where r.party_id = p.id and r.org_id = ${orgId} and r.is_active
           )
         order by p.display_name`),
      db.execute(sql`
        select id, name from items
         where org_id = ${orgId} and is_active and kind in ('labor', 'service')
         order by name`),
      db.execute(sql`
        select tt.id, tt.name, tt.bill_multiplier
          from time_types tt
         where tt.org_id = ${orgId}
           and (
             (tt.is_active and tt.show_on_field_ticket)
             or exists (
               select 1 from time_entries te
                where te.org_id = ${orgId}
                  and te.field_ticket_id = ${ticket.id}
                  and te.time_type_id = tt.id
             )
             or exists (
               select 1
                 from field_ticket_labor_lines line
                 join field_ticket_labor_snapshots snapshot
                   on snapshot.id = line.snapshot_id
                  and snapshot.org_id = line.org_id
                where line.org_id = ${orgId}
                  and line.field_ticket_id = ${ticket.id}
                  and line.time_type_id = tt.id
                  and snapshot.superseded_at is null
             )
           )
         order by tt.bill_multiplier, tt.name`),
      db.execute(sql`
        select id, name, kind, default_rate from items
         where org_id = ${orgId} and is_active
           and kind in ('equipment_charge', 'non_inventory', 'other_charge', 'inventory', 'service')
         order by kind, name`),
      db.execute(sql`
        select p.id, coalesce(p.code || ' · ' || p.name, p.name) as name,
               cust.display_name as "customerName",
               coalesce((
                 select policy.period
                   from field_ticket_policies policy
                  where policy.org_id = p.org_id and policy.is_active
                    and policy.effective_from <= current_date
                    and (policy.effective_to is null or policy.effective_to >= current_date)
                    and (
                      (policy.scope = 'project' and policy.project_id = p.id)
                      or (policy.scope = 'customer' and policy.customer_party_id = p.customer_id)
                      or policy.scope = 'organization'
                    )
                  order by case policy.scope
                    when 'project' then 1 when 'customer' then 2 else 3 end,
                    policy.effective_from desc
                  limit 1
               ), 'weekly') as period
          from projects p
          left join parties cust on cust.id = p.customer_id and cust.org_id = p.org_id
         where p.org_id = ${orgId} and p.is_active
         order by p.name
         limit 2000`),
      ticket.projectId
        ? db.execute(sql`
            select id, code, name, status, estimated_hours as "estimatedHours"
              from project_tasks
             where org_id = ${orgId} and project_id = ${ticket.projectId}
             order by code nulls last, name`)
        : Promise.resolve({ rows: [] }),
      equipmentEnabled
        ? db.execute(sql`
            select id, name, unit_number as "unitNumber", charge_item_id as "chargeItemId"
              from equipment_units
             where org_id = ${orgId} and status = 'active' and charge_item_id is not null
             order by unit_number, name`)
        : Promise.resolve({ rows: [] }),
      resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: 'field_ticket',
        userRoles: [authz.user.role],
        headerDefs: [],
        lineDefs: [],
        explicitLayoutId: formLayoutId,
      }),
    ])) as unknown as [
      { rows: FieldTicketDrawerProps['employees'] },
      { rows: FieldTicketDrawerProps['laborItems'] },
      { rows: FieldTicketDrawerProps['timeTypes'] },
      { rows: FieldTicketDrawerProps['catalogItems'] },
      { rows: FieldTicketDrawerProps['projects'] },
      { rows: FieldTicketDrawerProps['projectTasks'] },
      { rows: FieldTicketDrawerProps['equipmentUnits'] },
      Awaited<ReturnType<typeof resolveFormLayout>>,
    ]

  return {
    ticket,
    employees: employees.rows,
    laborItems: laborItems.rows,
    timeTypes: timeTypes.rows,
    catalogItems: catalogItems.rows,
    projects: projects.rows,
    projectTasks: projectTasks.rows,
    equipmentUnits: equipmentUnits.rows,
    equipmentEnabled,
    layout: resolvedForm.layout,
    availableLayouts: resolvedForm.available,
    currentLayoutId: resolvedForm.row?.id ?? null,
    canCustomize: can(authz, 'admin.customization.manage'),
    canManage: can(authz, 'time.manage'),
  }
}
