import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { loadFieldDefs, type CustomFieldDef } from '../../../lib/custom-fields'
import { subsidiaryVisibleFilter } from '../../../lib/subsidiaries'

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

/**
 * Load one project for the flyout / cockpit. The caller's subsidiary scope is
 * applied HERE, so a project outside it is a missing project for every
 * surface built on this loader — pages cannot forget to check. Unrestricted
 * callers (null) see the whole org.
 */
export async function loadProject(
  id: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<ProjectPayload | null> {
  // One transaction for the whole bundle, locking the header first (READ
  // COMMITTED, like loadAsset): a concurrent project rehome blocks on the
  // lock instead of moving rows between the header read and the
  // task/customer reads of one response. Linked party names carry the party
  // lens (org-wide nulls stay visible); a linked party outside scope
  // resolves to no name rather than disclosing the row. (A REPEATABLE READ
  // snapshot cannot take the lock: a locking read that meets a concurrent
  // update errors with 40001 instead of waiting.)
  const [bundle, fieldDefs] = await Promise.all([
    withOrgTransaction(orgId, async () => {
      const proj = (await db.execute<Record<string, unknown>>(sql`
        select * from projects where id = ${id} and org_id = ${orgId}
          ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds)}
          for share
      `))
      if (!proj.rows[0]) return null
      const row = proj.rows[0]
      const partyName = (partyId: unknown) =>
        partyId
          ? db.execute<Record<string, unknown>>(sql`
              select display_name from parties
               where id = ${partyId} and org_id = ${orgId}
                 ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}`)
          : Promise.resolve({ rows: [] as Record<string, unknown>[] })
      const customer = await partyName(row.customer_id)
      const foreman = await partyName(row.foreman_id)
      const manager = await partyName(row.manager_id)
      const tasks = await db.execute<ProjectTaskRow>(sql`
        select id, code, name, status, estimated_hours, estimated_cost, updated_at
          from project_tasks
         where project_id = ${id} and org_id = ${orgId}
         order by code nulls last, name
      `)
      return { row, customer, foreman, manager, tasks }
    }),
    loadFieldDefs('projects'),
  ])
  if (!bundle) return null
  const { row, customer, foreman, manager, tasks } = bundle

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
