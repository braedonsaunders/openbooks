import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { recordHistoricalEmployerAssignment, type EmployerAssignmentKind } from '@openbooks/engine/payroll/setup'
import { duplicateImportRowIndexes, subsidiaryReadFilter, type DataResource } from './resource-core'
import { readExportWindow, transferId, transferWhere, transferLimit, finishExportPage } from './export-page'
import { importRowError } from './row-error'
import type { CellValue, ResourceDescriptor, ResourceField, WriteOutcome } from './types'

export const PAYROLL_HISTORICAL_EMPLOYER_ASSIGNMENTS_KEY = 'payroll-historical-employer-assignments'
export const PAYROLL_HISTORICAL_EMPLOYER_ASSIGNMENTS_DESCRIPTOR: ResourceDescriptor = {
  key: PAYROLL_HISTORICAL_EMPLOYER_ASSIGNMENTS_KEY, label: 'Historical employer assignments', group: 'Setup',
  iconKey: 'users', readPermission: 'payroll.read', writePermission: 'payroll.manage',
  supportsImport: true, scopedWrite: true, naturalKey: 'employee, assignment kind and effective window',
}
const FIELDS: ResourceField[] = [
  { key: 'employee', label: 'Employee ID', kind: 'text', required: true },
  { key: 'kind', label: 'Assignment kind (filing_account or worker_comp)', kind: 'text', required: true },
  { key: 'assignment', label: 'Historical account or group ID', kind: 'text', required: true },
  { key: 'expectedCurrent', label: 'Reviewed current ID (or none)', kind: 'text', required: true },
  { key: 'effectiveFrom', label: 'Effective from', kind: 'date', required: true },
  { key: 'effectiveTo', label: 'Effective through', kind: 'date', required: true },
  { key: 'sourceReference', label: 'Dated source reference', kind: 'long_text', required: true },
  { key: 'reason', label: 'Reason', kind: 'long_text', required: true },
]

/** Compose the existing preview, approval and audited import workflow. */
export function payrollHistoricalEmployerAssignmentsResource(orgId: string): DataResource {
  return {
    descriptor: PAYROLL_HISTORICAL_EMPLOYER_ASSIGNMENTS_DESCRIPTOR,
    async fields() { return FIELDS },
    async columns() { return FIELDS.map(({ key, label }) => ({ key, label })) },
    async read(ctx) {
      if (!ctx || ctx.allowedSubsidiaryIds === undefined) throw new Error('Historical employer assignment export requires an explicit legal-entity scope')
      const installed = (await db.execute<{ installed: boolean }>(sql`select to_regclass('public.payroll_employee_employer_assignments') is not null as installed`)).rows[0]?.installed
      if (!installed) throw new Error('Historical employer assignments are not installed — run the authorized database bootstrap before exporting')
      const result = (await readExportWindow<Record<string, CellValue>>(db, sql`
        select a.employee_party_id::text as employee, a.assignment_kind as kind,
          coalesce(a.filing_account_id,a.worker_comp_group_id)::text as assignment,
          coalesce(case when a.assignment_kind='filing_account' then prof.filing_account_id else er.worker_comp_group_id end::text,'none') as "expectedCurrent",
          a.effective_from::text as "effectiveFrom", a.effective_to::text as "effectiveTo",
          a.source_reference as "sourceReference", a.reason${transferId(ctx, sql`a.id`)}
        from payroll_employee_employer_assignments a
        join employee_payroll_profiles prof on prof.org_id=a.org_id and prof.employee_party_id=a.employee_party_id
        join parties p on p.org_id=a.org_id and p.id=a.employee_party_id
        left join lateral (select worker_comp_group_id from employee_roles where org_id=a.org_id and party_id=a.employee_party_id
          order by is_active desc,id limit 1) er on true
        where a.org_id=${orgId} ${subsidiaryReadFilter(sql`p.subsidiary_id`, ctx.allowedSubsidiaryIds)}
          ${transferWhere(ctx, sql`a.id`)} order by a.id limit ${transferLimit(ctx)}`, ctx)).rows
      finishExportPage(result, PAYROLL_HISTORICAL_EMPLOYER_ASSIGNMENTS_DESCRIPTOR.label, ctx)
      return { fields: FIELDS, columns: FIELDS.map(({ key, label }) => ({ key, label })), rows: result }
    },
    async write(rows, _mode, ctx) {
      if (ctx.orgId !== orgId || ctx.allowedSubsidiaryIds === undefined) throw new Error('Historical employer assignment imports require this organization and an explicit legal-entity scope')
      if (ctx.post) throw new Error('Historical assignments cannot post payroll — calculate and review the run in Payroll')
      const keys = rows.map(row => [row.employee, row.kind, row.effectiveFrom, row.effectiveTo].map(value => String(value ?? '').trim()).join('|'))
      if (ctx.recordKeys) await ctx.recordKeys(keys)
      const duplicates = duplicateImportRowIndexes(keys)
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      for (let index = 0; index < rows.length; index++) {
        try {
          if (duplicates.has(index)) throw new Error('Keep one reviewed assignment per employee, kind and effective window')
          const row = rows[index]!
          const reviewed = String(row.expectedCurrent ?? '').trim()
          if (!reviewed) throw new Error('Declare the reviewed current account or group ID; enter none only when no current assignment exists')
          const result = await recordHistoricalEmployerAssignment({
            orgId, actorId: ctx.actorId, employeePartyId: String(row.employee ?? '').trim(),
            kind: String(row.kind ?? '').trim() as EmployerAssignmentKind,
            assignmentId: String(row.assignment ?? '').trim(), expectedCurrentId: reviewed === 'none' ? null : reviewed,
            effectiveFrom: String(row.effectiveFrom ?? '').trim(), effectiveTo: String(row.effectiveTo ?? '').trim(),
            sourceReference: String(row.sourceReference ?? '').trim(), reason: String(row.reason ?? '').trim(),
            allowedSubsidiaryIds: ctx.allowedSubsidiaryIds, dryRun: ctx.dryRun === true,
          })
          if (result.changed) outcome.created++
        } catch (error) {
          outcome.failed++
          outcome.errors.push({ row: index + 1, message: importRowError(error) })
        }
      }
      return outcome
    },
  }
}
