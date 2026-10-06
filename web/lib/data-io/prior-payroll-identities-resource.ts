import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { correctPriorStubEmployee } from '@openbooks/engine/payroll/setup'
import { duplicateImportRowIndexes, subsidiaryReadFilter, type DataResource } from './resource-core'
import { readExportWindow, transferId, transferWhere, transferLimit, finishExportPage } from './export-page'
import { importRowError } from './row-error'
import type { CellValue, ResourceDescriptor, ResourceField, WriteOutcome } from './types'

export const PRIOR_PAYROLL_IDENTITIES_KEY = 'prior-payroll-identities'
export const PRIOR_PAYROLL_IDENTITIES_DESCRIPTOR: ResourceDescriptor = {
  key: PRIOR_PAYROLL_IDENTITIES_KEY, label: 'Prior payroll employee identities', group: 'Setup',
  iconKey: 'users', readPermission: 'payroll.read', writePermission: 'payroll.manage',
  supportsImport: true, scopedWrite: true, naturalKey: 'imported payroll stub ID',
}
const FIELDS: ResourceField[] = [
  { key: 'stubId', label: 'Imported stub ID', kind: 'text', required: true },
  { key: 'register', label: 'Source register', kind: 'text', readOnly: true },
  { key: 'payDate', label: 'Source pay date', kind: 'date', readOnly: true },
  { key: 'expectedEmployeeLabel', label: 'Source employee label', kind: 'text', required: true },
  { key: 'expectedEmployeePartyId', label: 'Reviewed employee ID', kind: 'text', required: true },
  { key: 'employeePartyId', label: 'Verified employee ID', kind: 'text', required: true },
  { key: 'sourceReference', label: 'Identity source evidence', kind: 'long_text', required: true },
  { key: 'reason', label: 'Correction reason', kind: 'long_text', required: true },
]

/** Reuse the native import preview and approval flow; identity corrections cannot change money. */
export function priorPayrollIdentitiesResource(orgId: string): DataResource {
  return {
    descriptor: PRIOR_PAYROLL_IDENTITIES_DESCRIPTOR,
    async fields() { return FIELDS },
    async columns() { return FIELDS.map(({ key, label }) => ({ key, label })) },
    async read(ctx) {
      if (!ctx || ctx.allowedSubsidiaryIds === undefined) throw new Error('Prior payroll identity export requires an explicit legal-entity scope')
      const rows = (await readExportWindow<Record<string, CellValue>>(db, sql`
        select s.id::text as "stubId",r.name as register,r.pay_date::text as "payDate",
          s.employee_label as "expectedEmployeeLabel",s.employee_party_id::text as "expectedEmployeePartyId",
          s.employee_party_id::text as "employeePartyId",''::text as "sourceReference",''::text as reason${transferId(ctx, sql`s.id`)}
        from payroll_prior_stubs s join payroll_prior_registers r on r.org_id=s.org_id and r.id=s.register_id
        join parties p on p.org_id=s.org_id and p.id=s.employee_party_id
        where s.org_id=${orgId} ${subsidiaryReadFilter(sql`p.subsidiary_id`, ctx.allowedSubsidiaryIds)}
          ${transferWhere(ctx, sql`s.id`)} order by s.id limit ${transferLimit(ctx)}`, ctx)).rows
      finishExportPage(rows, PRIOR_PAYROLL_IDENTITIES_DESCRIPTOR.label, ctx)
      return { fields: FIELDS, columns: FIELDS.map(({ key, label }) => ({ key, label })), rows }
    },
    async write(rows, _mode, ctx) {
      if (ctx.orgId !== orgId || ctx.allowedSubsidiaryIds === undefined) throw new Error('Prior payroll identity corrections require this organization and an explicit legal-entity scope')
      if (ctx.post) throw new Error('Identity corrections cannot post payroll — calculate and review the run in Payroll')
      const keys = rows.map(row => String(row.stubId ?? '').trim().toLowerCase() || null)
      if (ctx.recordKeys) await ctx.recordKeys(keys)
      const duplicates = duplicateImportRowIndexes(keys)
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      for (let index = 0; index < rows.length; index++) {
        try {
          if (duplicates.has(index)) throw new Error('Keep one reviewed identity correction per imported payroll stub')
          const row = rows[index]!
          const result = await correctPriorStubEmployee({
            orgId, actorId: ctx.actorId, stubId: String(row.stubId ?? '').trim(),
            expectedEmployeePartyId: String(row.expectedEmployeePartyId ?? '').trim(),
            employeePartyId: String(row.employeePartyId ?? '').trim(),
            expectedEmployeeLabel: String(row.expectedEmployeeLabel ?? ''),
            sourceReference: String(row.sourceReference ?? '').trim(), reason: String(row.reason ?? '').trim(),
            allowedSubsidiaryIds: ctx.allowedSubsidiaryIds, dryRun: ctx.dryRun === true,
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
