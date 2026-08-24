import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'

export type ProjectTimeDimension = 'employee' | 'item' | 'task'

export interface ProjectTimeEntryDetail {
  id: string
  workedOn: string
  employeeName: string
  itemName: string
  taskName: string
  timeTypeName: string
  hours: string
  billable: boolean
  cost: string
  bill: string
  memo: string | null
  fieldTicketNumber: string | null
}

export interface ProjectTimeEntryPage {
  entries: ProjectTimeEntryDetail[]
  page: number
  pageSize: number
  totalPages: number
  totals: {
    entries: number
    hours: string
    cost: string
    bill: string
  }
}

export class ProjectTimeDetailError extends Error {
  constructor(message: string, readonly status = 404) {
    super(message)
  }
}

/**
 * Canonical approved time behind one project-hours summary row.
 *
 * The project and every joined dimension are organization-scoped. Monetary
 * values remain decimal strings and are rounded per atomic time record before
 * aggregation, matching the detailed rows displayed by the drawer. Private
 * memos are redacted rather than suppressing the financial record itself.
 */
export async function loadProjectTimeEntryPage(args: {
  orgId: string
  projectId: string
  dimension: ProjectTimeDimension
  dimensionId: string | null
  page: number
  pageSize?: number
}): Promise<ProjectTimeEntryPage> {
  const pageSize = Math.min(Math.max(args.pageSize ?? 100, 1), 200)
  const page = Number.isSafeInteger(args.page) && args.page > 0 ? args.page : 1
  const offset = (page - 1) * pageSize
  const project = await db.execute(sql`
    select 1 from projects where id = ${args.projectId} and org_id = ${args.orgId}
  `)
  if (!project.rows[0]) throw new ProjectTimeDetailError('Project not found')

  const dimensionFilter = args.dimension === 'employee'
    ? (args.dimensionId ? sql`te.employee_party_id = ${args.dimensionId}` : sql`te.employee_party_id is null`)
    : args.dimension === 'item'
      ? (args.dimensionId ? sql`te.item_id = ${args.dimensionId}` : sql`te.item_id is null`)
      : (args.dimensionId ? sql`te.project_task_id = ${args.dimensionId}` : sql`te.project_task_id is null`)

  const [summaryResult, entryResult] = await Promise.all([
    db.execute(sql`
      select count(*)::int as entries,
             coalesce(sum(te.hours), 0)::text as hours,
             coalesce(sum(round(te.hours * coalesce(te.cost_rate, 0), 4)), 0)::text as cost,
             coalesce(sum(round(te.hours * coalesce(te.bill_rate, 0), 4)), 0)::text as bill
        from time_entries te
       where te.org_id = ${args.orgId}
         and te.project_id = ${args.projectId}
         and te.status = 'approved'
         and ${dimensionFilter}
    `),
    db.execute(sql`
      select te.id,
             te.worked_on::text as worked_on,
             coalesce(employee.display_name, '') as employee_name,
             coalesce(item.name, '') as item_name,
             coalesce(task.name, '') as task_name,
             coalesce(time_type.name, '') as time_type_name,
             te.hours::text as hours,
             te.is_billable,
             round(te.hours * coalesce(te.cost_rate, 0), 4)::text as cost,
             round(te.hours * coalesce(te.bill_rate, 0), 4)::text as bill,
             case when te.memo_is_private then null else nullif(te.memo, '') end as memo,
             field_ticket.document_number as field_ticket_number
        from time_entries te
        left join parties employee
          on employee.id = te.employee_party_id and employee.org_id = te.org_id
        left join items item
          on item.id = te.item_id and item.org_id = te.org_id
        left join project_tasks task
          on task.id = te.project_task_id and task.org_id = te.org_id and task.project_id = te.project_id
        left join time_types time_type
          on time_type.id = te.time_type_id and time_type.org_id = te.org_id
        left join documents field_ticket
          on field_ticket.id = te.field_ticket_id
         and field_ticket.org_id = te.org_id
         and field_ticket.kind = 'field_ticket'
       where te.org_id = ${args.orgId}
         and te.project_id = ${args.projectId}
         and te.status = 'approved'
         and ${dimensionFilter}
       order by te.worked_on desc, te.id
       limit ${pageSize} offset ${offset}
    `),
  ])

  const totals = summaryResult.rows[0] ?? {}
  const totalEntries = Number(totals.entries ?? 0)
  return {
    entries: (entryResult.rows).map((row) => ({
      id: String(row.id),
      workedOn: String(row.worked_on),
      employeeName: String(row.employee_name ?? ''),
      itemName: String(row.item_name ?? ''),
      taskName: String(row.task_name ?? ''),
      timeTypeName: String(row.time_type_name ?? ''),
      hours: String(row.hours ?? '0'),
      billable: Boolean(row.is_billable),
      cost: normalizeMoney(String(row.cost ?? '0')),
      bill: normalizeMoney(String(row.bill ?? '0')),
      memo: row.memo == null ? null : String(row.memo),
      fieldTicketNumber: row.field_ticket_number == null ? null : String(row.field_ticket_number),
    })),
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(totalEntries / pageSize)),
    totals: {
      entries: totalEntries,
      hours: String(totals.hours ?? '0'),
      cost: normalizeMoney(String(totals.cost ?? '0')),
      bill: normalizeMoney(String(totals.bill ?? '0')),
    },
  }
}
