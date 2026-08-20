import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { loadFieldDefs, type CustomFieldDef } from '../../../lib/custom-fields'

/**
 * Project payload for the flyout + cockpit header: the project row (with the
 * native contract value, resolved display
 * names for the linked customer / foreman / manager parties, and the WBS
 * tasks that make up the cost budget.
 */
export type ProjectTaskRow = {
  id: string
  code: string | null
  name: string
  status: string
  estimated_hours: string | null
  estimated_cost: string | null
  updated_at: string
}

/** Client-safe custom field definition (drops server-only bits). */
export interface ProjectCustomFieldDef {
  key: string
  label: string
  fieldType: CustomFieldDef['fieldType']
  config: CustomFieldDef['config']
  isRequired: boolean
}

export interface ProjectPayload {
  project: Record<string, unknown>
  contractValue: string | null
  customerName: string | null
  foremanName: string | null
  managerName: string | null
  tasks: ProjectTaskRow[]
  customFieldDefs: ProjectCustomFieldDef[]
}

export async function loadProject(id: string, orgId: string): Promise<ProjectPayload | null> {
  const proj = (await db.execute<Record<string, unknown>>(sql`
    select * from projects where id = ${id} and org_id = ${orgId}
  `))
  if (!proj.rows[0]) return null
  const row = proj.rows[0]

  const [names, fieldDefs] = await Promise.all([
    Promise.all([
      row.customer_id
        ? db.execute<Record<string, unknown>>(sql`select display_name from parties where id = ${row.customer_id} and org_id = ${orgId}`)
        : Promise.resolve({ rows: [] }),
      row.foreman_id
        ? db.execute<Record<string, unknown>>(sql`select display_name from parties where id = ${row.foreman_id} and org_id = ${orgId}`)
        : Promise.resolve({ rows: [] }),
      row.manager_id
        ? db.execute<Record<string, unknown>>(sql`select display_name from parties where id = ${row.manager_id} and org_id = ${orgId}`)
        : Promise.resolve({ rows: [] }),
      db.execute<ProjectTaskRow>(sql`
        select id, code, name, status, estimated_hours, estimated_cost, updated_at
          from project_tasks
         where project_id = ${id} and org_id = ${orgId}
         order by code nulls last, name
      `),
    ]),
    loadFieldDefs('projects'),
  ])
  const [customer, foreman, manager, tasks] = names

  const name = (r?: Record<string, unknown>) => (r ? ((r.display_name as string) ?? null) : null)
  const contractValue = row.contract_value == null ? null : String(row.contract_value)

  return {
    project: row,
    contractValue,
    customerName: name(customer.rows[0]),
    foremanName: name(foreman.rows[0]),
    managerName: name(manager.rows[0]),
    tasks: tasks.rows,
    customFieldDefs: fieldDefs.map((d) => ({
      key: d.key,
      label: d.label,
      fieldType: d.fieldType,
      config: d.config,
      isRequired: d.isRequired,
    })),
  }
}
