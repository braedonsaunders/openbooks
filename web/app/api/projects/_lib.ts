import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Project payload for the flyout + cockpit header: the project row (with the
 * contract value lifted out of `custom` for convenience), resolved display
 * names for the linked customer / foreman / manager parties, and the WBS
 * tasks that make up the cost budget.
 */
export interface ProjectTaskRow {
  id: string
  code: string | null
  name: string
  status: string
  estimated_hours: string | null
  estimated_cost: string | null
}

export interface ProjectPayload {
  project: Record<string, unknown>
  contractValue: string | null
  customerName: string | null
  foremanName: string | null
  managerName: string | null
  tasks: ProjectTaskRow[]
}

export async function loadProject(id: string, orgId: string): Promise<ProjectPayload | null> {
  const proj = (await db.execute(sql`
    select * from projects where id = ${id} and org_id = ${orgId}
  `)) as unknown as { rows: Record<string, unknown>[] }
  if (!proj.rows[0]) return null
  const row = proj.rows[0]

  const [customer, foreman, manager, tasks] = (await Promise.all([
    row.customer_id
      ? db.execute(sql`select display_name from parties where id = ${row.customer_id} and org_id = ${orgId}`)
      : Promise.resolve({ rows: [] }),
    row.foreman_id
      ? db.execute(sql`select display_name from parties where id = ${row.foreman_id} and org_id = ${orgId}`)
      : Promise.resolve({ rows: [] }),
    row.manager_id
      ? db.execute(sql`select display_name from parties where id = ${row.manager_id} and org_id = ${orgId}`)
      : Promise.resolve({ rows: [] }),
    db.execute(sql`
      select id, code, name, status, estimated_hours, estimated_cost
        from project_tasks
       where project_id = ${id} and org_id = ${orgId}
       order by code nulls last, name
    `),
  ])) as unknown as { rows: Record<string, unknown>[] }[]

  const name = (r?: Record<string, unknown>) => (r ? ((r.display_name as string) ?? null) : null)
  const custom = (row.custom as Record<string, unknown> | null) ?? null
  const contractValue =
    custom && custom.contractValue != null && String(custom.contractValue).trim() !== ''
      ? String(custom.contractValue)
      : null

  return {
    project: row,
    contractValue,
    customerName: name(customer.rows[0]),
    foremanName: name(foreman.rows[0]),
    managerName: name(manager.rows[0]),
    tasks: tasks.rows as unknown as ProjectTaskRow[],
  }
}
