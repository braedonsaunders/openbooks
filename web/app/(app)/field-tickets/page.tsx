import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '../../../components/page-layout'
import { RecordListView } from '../../../components/record-list-view'
import { pickString } from '../../../lib/list-params'
import { requirePermission, can } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { loadFieldTicket, FieldTicketError } from '../../../lib/field-tickets'
import { resolveFormLayout } from '../../../lib/customization/resolve'
import { NewOrderButton } from '../_order/NewOrderButton'
import { FieldTicketDrawer, type TicketPayload } from './FieldTicketDrawer'

export const dynamic = 'force-dynamic'

const BASE = '/field-tickets'
const PARAM = 'ticket'
const API = '/api/field-tickets'

/**
 * Field tickets — the universal RecordListView (same filters/views/columns as
 * every other list) + the standard instant-create button and transaction
 * flyout. Subordinate to the Projects parent gate on Company Settings → Features.
 */
export default async function FieldTicketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('time.read')
  const orgId = authz.user.orgId
  if (!(await isFeatureEnabled(orgId, 'fieldTickets'))) notFound()
  const canManage = can(authz, 'time.manage')
  const equipmentEnabled = await isFeatureEnabled(orgId, 'equipment')
  const t = await getTranslations('fieldTickets')
  const sp = await searchParams
  const openId = pickString(sp[PARAM])

  let openTicket: TicketPayload | null = null
  let pickers: {
    employees: { id: string; name: string }[]
    laborItems: { id: string; name: string }[]
    timeTypes: { id: string; name: string; bill_multiplier: string }[]
    catalogItems: { id: string; name: string; kind: string; default_rate: string | null }[]
    projects: { id: string; name: string; customerName: string | null; period: string }[]
    projectTasks: { id: string; code: string | null; name: string; status: string; estimatedHours: string | null }[]
    equipmentUnits: { id: string; name: string; unitNumber: string; chargeItemId: string }[]
  } | null = null
  if (openId) {
    try {
      openTicket = (await loadFieldTicket(orgId, openId)) as unknown as TicketPayload
    } catch (e) {
      if (!(e instanceof FieldTicketError)) throw e
    }
    if (openTicket) {
      const [employees, laborItems, timeTypes, catalogItems, projects, projectTasks, equipmentUnits] = (await Promise.all([
        db.execute(sql`
          select p.id, p.display_name as name from parties p
           where p.org_id = ${orgId} and p.is_active
             and exists (select 1 from employee_roles r where r.party_id = p.id and r.org_id = ${orgId} and r.is_active)
           order by p.display_name`),
        db.execute(sql`
          select id, name from items where org_id = ${orgId} and is_active and kind in ('labor', 'service') order by name`),
        db.execute(sql`
          select tt.id, tt.name, tt.bill_multiplier
            from time_types tt
           where tt.org_id = ${orgId}
             and (
               (tt.is_active and tt.show_on_field_ticket)
               or exists (
                 select 1 from time_entries te
                  where te.org_id = ${orgId}
                    and te.field_ticket_id = ${openTicket.id}
                    and te.time_type_id = tt.id
               )
               or exists (
                 select 1
                   from field_ticket_labor_lines line
                   join field_ticket_labor_snapshots snapshot
                     on snapshot.id = line.snapshot_id
                    and snapshot.org_id = line.org_id
                  where line.org_id = ${orgId}
                    and line.field_ticket_id = ${openTicket.id}
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
           where p.org_id = ${orgId} and p.is_active order by p.name limit 2000`),
        openTicket.projectId
          ? db.execute(sql`
              select id, code, name, status, estimated_hours as "estimatedHours"
                from project_tasks where org_id = ${orgId} and project_id = ${openTicket.projectId}
               order by code nulls last, name`)
          : Promise.resolve({ rows: [] }),
        equipmentEnabled
          ? db.execute(sql`
              select id, name, unit_number as "unitNumber", charge_item_id as "chargeItemId"
                from equipment_units
               where org_id = ${orgId} and status = 'active' and charge_item_id is not null
               order by unit_number, name`)
          : Promise.resolve({ rows: [] }),
      ])) as unknown as { rows: Record<string, unknown>[] }[]
      pickers = {
        employees: employees.rows as never,
        laborItems: laborItems.rows as never,
        timeTypes: timeTypes.rows as never,
        catalogItems: catalogItems.rows as never,
        projects: projects.rows as never,
        projectTasks: projectTasks.rows as never,
        equipmentUnits: equipmentUnits.rows as never,
      }
    }
  }

  const resolvedForm = openTicket
    ? await resolveFormLayout({
        orgId,
        userId: authz.user.id,
        recordType: 'field_ticket',
        userRoles: [authz.user.role],
        headerDefs: [],
        lineDefs: [],
        explicitLayoutId: pickString(sp.form),
      })
    : null

  const newBtn = canManage ? (
    <NewOrderButton apiPath={API} base={BASE} param={PARAM} label={t('list.new')} createFailedMessage={t('list.createFailed')} />
  ) : undefined

  const drawer =
    openTicket && pickers ? (
      <FieldTicketDrawer
        ticket={openTicket}
        employees={pickers.employees}
        laborItems={pickers.laborItems}
        timeTypes={pickers.timeTypes}
        catalogItems={pickers.catalogItems}
        projects={pickers.projects}
        projectTasks={pickers.projectTasks}
        equipmentUnits={pickers.equipmentUnits}
        equipmentEnabled={equipmentEnabled}
        layout={resolvedForm?.layout}
        availableLayouts={resolvedForm?.available}
        currentLayoutId={resolvedForm?.row?.id ?? null}
        canCustomize={can(authz, 'admin.customization.manage')}
        canManage={canManage}
      />
    ) : null

  return (
    <ListPageLayout header={<PageHeader title={t('title')} description={t('description')} actions={newBtn} />}>
      <RecordListView
        recordType="field_ticket"
        basePath={BASE}
        orgId={orgId}
        userId={authz.user.id}
        canManage={can(authz, 'admin.customization.manage')}
        sp={sp}
        drawer={drawer}
        emptyAction={newBtn}
      />
    </ListPageLayout>
  )
}
