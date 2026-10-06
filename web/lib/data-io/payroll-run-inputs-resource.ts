import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { canonicalDecimal } from '@openbooks/engine/money/decimal'
import {
  mutatePayRunAdjustment, preflightPayRunAdjustment, payRunBulkAdjustmentId,
  PayRunAdjustmentIdempotencyConflict, type PayRunAdjustmentMutation,
} from '@openbooks/engine/payroll/inputs'
import { lockAndCheckOrgFeature } from '@openbooks/engine/organization/features'
import { decimalNullRefusal } from '../payroll-decimal-refusal'
import { coerceField } from '../setup/coerce'
import { duplicateImportRowIndexes, subsidiaryReadFilter, subsidiaryReadFilterWithUnassigned, type DataResource } from './resource-core'
import { readExportWindow, transferId, transferWhere, transferLimit, finishExportPage } from './export-page'
import { importRowError } from './row-error'
import type { CellValue, ResourceDescriptor, ResourceField, WriteOutcome } from './types'

export const PAYROLL_RUN_INPUTS_KEY = 'payroll-run-inputs'
export const PAYROLL_RUN_INPUTS_DESCRIPTOR: ResourceDescriptor = {
  key: PAYROLL_RUN_INPUTS_KEY, label: 'Pay run component inputs', group: 'Transactions',
  iconKey: 'clipboard-check', readPermission: 'payroll.read', writePermission: 'payroll.run',
  supportsImport: true, scopedWrite: true, naturalKey: 'run + employee + component',
}

const FIELDS: ResourceField[] = [
  { key: 'run', label: 'Pay run number or ID', kind: 'text', required: true },
  { key: 'employee', label: 'Employee payroll number, code, name, or ID', kind: 'text', required: true },
  { key: 'component', label: 'Pay component code or ID', kind: 'text', required: true },
  { key: 'amount', label: 'Amount', kind: 'currency', required: true },
  { key: 'hours', label: 'Hours or component units (optional)', kind: 'number' },
  { key: 'replaceComponent', label: 'Replace the calculated component amount', kind: 'boolean', required: true },
  { key: 'note', label: 'Reason or source reference', kind: 'text', required: true },
]

type Prepared = { documentId: string; key: string; mutation: Extract<PayRunAdjustmentMutation, { action: 'add' }> }

/** One imported total per run, employee and component; retries address the same controlled adjustment. */
export function payrollRunInputsResource(orgId: string): DataResource {
  return {
    descriptor: PAYROLL_RUN_INPUTS_DESCRIPTOR,
    async fields() { return FIELDS },
    async columns() { return FIELDS.map(({ key, label }) => ({ key, label })) },
    async read(ctx) {
      if (!ctx || ctx.allowedSubsidiaryIds === undefined) throw new Error('Pay run input export requires an explicit subsidiary scope')
      const rows = (await readExportWindow<Record<string, CellValue>>(db, sql`
        select a.id::text as "adjustmentId", d.id::text as "runId", d.document_number as run,
          a.employee_party_id::text as employee, a.component_id::text as component,
          a.amount::text as amount, a.hours::text as hours,
          a.replace_component as "replaceComponent", a.note as note${transferId(ctx, sql`a.id`)}
        from pay_run_adjustments a
        join pay_runs r on r.document_id=a.pay_run_document_id and r.org_id=a.org_id
        join documents d on d.id=r.document_id and d.org_id=r.org_id
        join parties p on p.id=a.employee_party_id and p.org_id=a.org_id
        where a.org_id=${orgId} and a.adjustment_type='line'
          ${subsidiaryReadFilter(sql`d.subsidiary_id`, ctx.allowedSubsidiaryIds)}
          ${subsidiaryReadFilterWithUnassigned(sql`p.subsidiary_id`, ctx.allowedSubsidiaryIds)}
          ${transferWhere(ctx, sql`a.id`)} order by a.id limit ${transferLimit(ctx)}`, ctx)).rows
      finishExportPage(rows, PAYROLL_RUN_INPUTS_DESCRIPTOR.label, ctx)
      // Only this import's deterministic adjustments round-trip through this resource.
      const imported = rows.filter(row => row.adjustmentId === payRunBulkAdjustmentId(
        String(row.runId), `${row.employee}:${row.component}`,
      ))
      for (const row of imported) { delete row.adjustmentId; delete row.runId }
      return { fields: FIELDS, columns: FIELDS.map(({ key, label }) => ({ key, label })), rows: imported }
    },
    async write(rows, _mode, ctx) {
      if (ctx.orgId !== orgId) throw new Error('Pay run input organization does not match the import')
      if (ctx.allowedSubsidiaryIds === undefined) throw new Error('Pay run input import requires an explicit subsidiary scope')
      if (ctx.post) throw new Error('Pay run inputs cannot post payroll — calculate and review the run in Payroll')
      return db.transaction(async tx => {
        if (!(await lockAndCheckOrgFeature(tx, orgId, 'payroll'))) throw new Error('Payroll is disabled — enable it in Company Settings → Features before importing pay run inputs')
        const prepared: (Prepared | { error: string })[] = []
        for (const row of rows) {
          try {
            const runValue = String(row.run ?? '').trim()
            if (!runValue) throw new Error('Pay run number or ID is required')
            const run = (await tx.execute<{ id: string }>(sql`select d.id::text as id from documents d
              join pay_runs r on r.document_id=d.id and r.org_id=d.org_id
              where d.org_id=${orgId} and (d.id::text=${runValue} or d.document_number=${runValue})
                ${subsidiaryReadFilter(sql`d.subsidiary_id`, ctx.allowedSubsidiaryIds)} limit 2`)).rows
            if (run.length !== 1) throw new Error('Pay run not found or ambiguous — use the number or ID of an editable run in your legal entity')
            const employeeValue = String(row.employee ?? '').trim()
            if (!employeeValue) throw new Error('Employee is required — use a unique employee ID or payroll number')
            const employee = (await tx.execute<{ id: string }>(sql`select distinct p.id::text as id from parties p
              join employee_payroll_profiles prof on prof.employee_party_id=p.id and prof.org_id=p.org_id
              left join employee_roles er on er.party_id=p.id and er.org_id=p.org_id
              where p.org_id=${orgId} and (p.id::text=${employeeValue} or p.short_code=${employeeValue}
                or er.employee_number=${employeeValue} or p.display_name=${employeeValue})
                ${subsidiaryReadFilterWithUnassigned(sql`p.subsidiary_id`, ctx.allowedSubsidiaryIds)} limit 2`)).rows
            if (employee.length !== 1) throw new Error('Employee not found or ambiguous — use a unique employee ID or payroll number in your legal entity')
            const componentValue = String(row.component ?? '').trim()
            if (!componentValue) throw new Error('Pay component code or ID is required')
            const component = (await tx.execute<{ id: string }>(sql`select id::text as id from pay_components
              where org_id=${orgId} and (id::text=${componentValue} or code=${componentValue}) limit 2`)).rows
            if (component.length !== 1) throw new Error('Pay component not found or ambiguous — use its component code or ID')
            const amount = canonicalDecimal(row.amount, 4)
            if (amount === null) throw new Error(decimalNullRefusal('Amount', 'an amount', row.amount, 4))
            const hours = row.hours == null || row.hours === '' ? null : canonicalDecimal(row.hours, 2)
            if (hours === null && row.hours != null && row.hours !== '') throw new Error(decimalNullRefusal('Hours or units', 'hours or units', row.hours, 2))
            if (row.replaceComponent == null || row.replaceComponent === '') throw new Error('Declare whether this amount replaces the calculated component — enter true or false')
            const replacement = coerceField({ key: 'replaceComponent', kind: 'boolean' }, row.replaceComponent)
            if ('error' in replacement) throw new Error(replacement.error)
            const replaceComponent = replacement.value as boolean
            const note = String(row.note ?? '').trim()
            if (!note || note.length > 500) throw new Error('Supply a reason or source reference of 1 to 500 characters')
            const documentId = run[0]!.id, employeePartyId = employee[0]!.id, componentId = component[0]!.id
            prepared.push({ documentId, key: `${documentId}:${employeePartyId}:${componentId}`,
              mutation: { action: 'add', employeePartyId, componentId, amount, hours, replaceComponent, note,
                idempotencyKey: payRunBulkAdjustmentId(documentId, `${employeePartyId}:${componentId}`) } })
          } catch (error) { prepared.push({ error: importRowError(error) }) }
        }
        const keys = prepared.map(row => 'error' in row ? null : row.key)
        await ctx.recordKeys?.(keys)
        const duplicates = duplicateImportRowIndexes(keys)
        const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
        for (const [index, row] of prepared.entries()) {
          try {
            if ('error' in row) throw new Error(row.error)
            if (duplicates.has(index)) throw new Error('This run, employee and component appear more than once — combine their amount and units into one input row')
            const input = { orgId, documentId: row.documentId, actorId: ctx.actorId,
              allowedSubsidiaryIds: ctx.allowedSubsidiaryIds, mutation: row.mutation, source: 'data_import' as const }
            const result = await db.transaction(async () => {
              if (ctx.dryRun) return preflightPayRunAdjustment(input)
              return mutatePayRunAdjustment(input)
            })
            if (!result.replayed) outcome.created++
          } catch (error) {
            outcome.failed++
            outcome.errors.push({ row: index + 1, message: error instanceof PayRunAdjustmentIdempotencyConflict
              ? 'This component input was already imported with different details — remove its existing adjustment in the pay run, then preview this file again'
              : importRowError(error) })
          }
        }
        return outcome
      })
    },
  }
}
