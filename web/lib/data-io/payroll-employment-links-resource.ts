import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { linkPayrollProfileEmployment } from '@openbooks/engine/payroll/setup'
import { duplicateImportRowIndexes, subsidiaryReadFilter, type DataResource } from './resource-core'
import { readExportWindow, transferId, transferWhere, transferLimit, finishExportPage } from './export-page'
import { importRowError } from './row-error'
import type { CellValue, ResourceDescriptor, ResourceField, WriteOutcome } from './types'

export const PAYROLL_EMPLOYMENT_LINKS_KEY = 'payroll-employment-links'
export const PAYROLL_EMPLOYMENT_LINKS_DESCRIPTOR: ResourceDescriptor = {
  key: PAYROLL_EMPLOYMENT_LINKS_KEY, label: 'Payroll employment links', group: 'Setup',
  iconKey: 'users', readPermission: 'payroll.read', writePermission: 'payroll.manage',
  supportsImport: true, scopedWrite: true, naturalKey: 'employee ID',
}
const FIELDS: ResourceField[] = [
  { key: 'employee', label: 'Employee ID', kind: 'text', required: true },
  { key: 'employeeName', label: 'Employee name', kind: 'text', readOnly: true },
  { key: 'employment', label: 'Employment ID to link', kind: 'text', required: true },
  { key: 'currentEmployment', label: 'Current employment link', kind: 'text', readOnly: true },
  { key: 'employerName', label: 'Legal employer', kind: 'text', readOnly: true },
  { key: 'reason', label: 'Reason or source reference', kind: 'text', required: true },
]

/** Explicit employment identities use the native preview and audited domain writer. */
export function payrollEmploymentLinksResource(orgId: string): DataResource {
  return {
    descriptor: PAYROLL_EMPLOYMENT_LINKS_DESCRIPTOR,
    async fields() { return FIELDS },
    async columns() { return FIELDS.map(({ key, label }) => ({ key, label })) },
    async read(ctx) {
      if (!ctx || ctx.allowedSubsidiaryIds === undefined) throw new Error('Employment link export requires an explicit legal-entity scope')
      const rows = (await readExportWindow<Record<string, CellValue>>(db, sql`
        select p.id::text as employee, p.display_name as "employeeName",
          coalesce(prof.employment_id::text, candidate.id) as employment,
          prof.employment_id::text as "currentEmployment", employer.name as "employerName",
          ''::text as reason${transferId(ctx, sql`prof.id`)}
        from employee_payroll_profiles prof join parties p on p.id=prof.employee_party_id and p.org_id=prof.org_id
        left join subsidiaries employer on employer.org_id=p.org_id and employer.id=p.subsidiary_id
        left join lateral (select case when count(*)=1 and bool_and(e.employer_subsidiary_id=p.subsidiary_id)
          then min(e.id::text) else null end as id from worker_employments e
          where e.org_id=p.org_id and e.worker_party_id=p.id) candidate on true
        where prof.org_id=${orgId} ${subsidiaryReadFilter(sql`p.subsidiary_id`, ctx.allowedSubsidiaryIds)}
          ${transferWhere(ctx, sql`prof.id`)} order by prof.id limit ${transferLimit(ctx)}`, ctx)).rows
      finishExportPage(rows, PAYROLL_EMPLOYMENT_LINKS_DESCRIPTOR.label, ctx)
      return { fields: FIELDS, columns: FIELDS.map(({ key, label }) => ({ key, label })), rows }
    },
    async write(rows, _mode, ctx) {
      if (ctx.orgId !== orgId) throw new Error('Employment link organization does not match the import')
      if (ctx.allowedSubsidiaryIds === undefined) throw new Error('Employment linking requires an explicit legal-entity scope')
      if (ctx.post) throw new Error('Employment links cannot post payroll — calculate and review the run in Payroll')
      const duplicates = duplicateImportRowIndexes(rows.map(row => String(row.employee ?? '').trim().toLowerCase() || null))
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      for (let index = 0; index < rows.length; index++) {
        try {
          if (duplicates.has(index)) throw new Error('This employee appears more than once — keep one reviewed employment link per employee')
          const row = rows[index]!
          const result = await linkPayrollProfileEmployment({
            orgId, actorId: ctx.actorId, employeePartyId: String(row.employee ?? '').trim(),
            employmentId: String(row.employment ?? '').trim(), reason: String(row.reason ?? '').trim(),
            dryRun: ctx.dryRun === true, allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
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
