import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { assignEmployeeWorkerCompGroup } from '@openbooks/engine/payroll/setup'
import { duplicateImportRowIndexes, subsidiaryReadFilter, type DataResource } from './resource-core'
import { readExportWindow, transferId, transferWhere, transferLimit, finishExportPage } from './export-page'
import { importRowError } from './row-error'
import type { CellValue, ResourceDescriptor, ResourceField, WriteOutcome } from './types'

export const EMPLOYEE_WORKER_COMP_KEY = 'employee-worker-compensation'
export const EMPLOYEE_WORKER_COMP_DESCRIPTOR: ResourceDescriptor = {
  key: EMPLOYEE_WORKER_COMP_KEY, label: 'Employee worker-compensation groups', group: 'Setup',
  iconKey: 'users', readPermission: 'parties.read', writePermission: 'parties.manage',
  supportsImport: true, scopedWrite: true, naturalKey: 'employee ID',
}
const FIELDS: ResourceField[] = [
  { key: 'employee', label: 'Employee ID', kind: 'text', required: true },
  { key: 'employeeName', label: 'Employee name', kind: 'text', readOnly: true },
  { key: 'group', label: 'Worker-compensation group ID', kind: 'text', required: true },
  { key: 'groupName', label: 'Current worker-compensation group', kind: 'text', readOnly: true },
  { key: 'expectedGroup', label: 'Expected current group ID (blank if unassigned)', kind: 'text' },
  { key: 'reason', label: 'Reason or source reference', kind: 'text', required: true },
]

/** Bulk changes use the employee drawer's authority, optimistic check and audit. */
export function employeeWorkerCompResource(orgId: string): DataResource {
  return {
    descriptor: EMPLOYEE_WORKER_COMP_DESCRIPTOR,
    async fields() { return FIELDS },
    async columns() { return FIELDS.map(({ key, label }) => ({ key, label })) },
    async read(ctx) {
      if (!ctx || ctx.allowedSubsidiaryIds === undefined) throw new Error('Worker-compensation export requires an explicit legal-entity scope')
      const rows = (await readExportWindow<Record<string, CellValue>>(db, sql`
        select p.id::text as employee, p.display_name as "employeeName",
          er.worker_comp_group_id::text as "group", g.name as "groupName",
          er.worker_comp_group_id::text as "expectedGroup", ''::text as reason${transferId(ctx, sql`er.id`)}
        from employee_roles er join parties p on p.id=er.party_id and p.org_id=er.org_id
        left join worker_comp_groups g on g.id=er.worker_comp_group_id and g.org_id=er.org_id
        where er.org_id=${orgId} and er.is_active
          ${subsidiaryReadFilter(sql`p.subsidiary_id`, ctx.allowedSubsidiaryIds)}
          ${transferWhere(ctx, sql`er.id`)} order by er.id limit ${transferLimit(ctx)}`, ctx)).rows
      finishExportPage(rows, EMPLOYEE_WORKER_COMP_DESCRIPTOR.label, ctx)
      return { fields: FIELDS, columns: FIELDS.map(({ key, label }) => ({ key, label })), rows }
    },
    async write(rows, _mode, ctx) {
      if (ctx.orgId !== orgId) throw new Error('Worker-compensation organization does not match the import')
      if (ctx.allowedSubsidiaryIds === undefined) throw new Error('Worker-compensation assignments require an explicit legal-entity scope')
      if (ctx.post) throw new Error('Worker-compensation assignments cannot post payroll — calculate and review the run in Payroll')
      const duplicates = duplicateImportRowIndexes(rows.map(row => String(row.employee ?? '').trim().toLowerCase() || null))
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      for (let index = 0; index < rows.length; index++) {
        try {
          if (duplicates.has(index)) throw new Error('This employee appears more than once — keep one reviewed worker-compensation assignment per employee')
          const row = rows[index]!
          const groupId = String(row.group ?? '').trim()
          if (!groupId) throw new Error('Choose an active worker-compensation group ID — this import cannot clear a classification')
          const result = await assignEmployeeWorkerCompGroup({
            orgId, actorId: ctx.actorId, employeePartyId: String(row.employee ?? '').trim(), groupId,
            expectedGroupId: String(row.expectedGroup ?? '').trim() || null,
            reason: String(row.reason ?? '').trim(), dryRun: ctx.dryRun === true,
            allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
          })
          if (result.changed) outcome.updated++
        } catch (error) {
          outcome.failed++
          outcome.errors.push({ row: index + 1, message: importRowError(error) })
        }
      }
      return outcome
    },
  }
}
