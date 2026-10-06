import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import {
  payrollPeriodOpeningFieldsForCountry, savePayrollPeriodOpening,
  PayrollPeriodOpeningUnavailableError,
  type PayrollPeriodOpeningField,
} from '@openbooks/engine/payroll/period-openings'
import { duplicateImportRowIndexes, subsidiaryReadFilter, type DataResource } from './resource-core'
import { readExportWindow, transferId, transferWhere, transferLimit, finishExportPage } from './export-page'
import { importRowError } from './row-error'
import type { CellValue, ResourceDescriptor, ResourceField, WriteOutcome } from './types'

export const PAYROLL_PERIOD_OPENINGS_KEY = 'payroll-period-openings'
export const PAYROLL_PERIOD_OPENINGS_DESCRIPTOR: ResourceDescriptor = {
  key: PAYROLL_PERIOD_OPENINGS_KEY, label: 'Prior-provider period payments', group: 'Setup',
  iconKey: 'history', readPermission: 'payroll.read', writePermission: 'payroll.manage',
  supportsImport: true, scopedWrite: true, naturalKey: 'employee + taxYear',
}
const BASE_FIELDS: ResourceField[] = [
  { key: 'employee', label: 'Employee payroll number, code, name, or ID', kind: 'text', required: true },
  { key: 'employeeName', label: 'Employee name', kind: 'text', readOnly: true },
  { key: 'taxYear', label: 'Tax year', kind: 'number', required: true },
  { key: 'subsidiaryId', label: 'Legal employer ID', kind: 'text', required: true },
  { key: 'payScheduleId', label: 'Payroll schedule ID', kind: 'text', required: true },
  { key: 'country', label: 'Payroll country', kind: 'text', required: true },
  { key: 'currency', label: 'Payroll currency', kind: 'text', required: true },
  { key: 'periodStart', label: 'Period start', kind: 'date', required: true },
  { key: 'periodEnd', label: 'Period end', kind: 'date', required: true },
  { key: 'paidThrough', label: 'Prior provider paid through', kind: 'date', required: true },
  { key: 'expectedRevision', label: 'Reviewed period revision (new for first admission)', kind: 'text', required: true },
  { key: 'expectedAnnualUpdatedAt', label: 'Reviewed annual opening version', kind: 'text', required: true },
  { key: 'sourceReference', label: 'Verified payment source reference', kind: 'long_text', required: true },
  { key: 'reason', label: 'Reason for period attribution', kind: 'long_text', required: true },
]
const amountKey = (country: string, field: PayrollPeriodOpeningField) => `amount:${country}:${field.key}`
function yearOf(value: unknown): number {
  const text = String(value ?? '').trim()
  if (!/^\d{4}$/.test(text) || Number(text) < 1900) throw new Error('Use a four-digit tax year from 1900 through 9999')
  return Number(text)
}
function revisionOf(value: unknown): number | null {
  if (value === 'new') return null
  const text = String(value ?? '').trim()
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new Error('Export and review the period revision — enter new only when no period opening exists')
  }
  return Number(text)
}

/** This resource attributes annual carry-in; it never creates another payment or journal. */
export function payrollPeriodOpeningsResource(orgId: string): DataResource {
  const declarations = new Map<string, Promise<PayrollPeriodOpeningField[]>>()
  const declared = (country: string) => {
    let fields = declarations.get(country)
    if (!fields) { fields = payrollPeriodOpeningFieldsForCountry(country); declarations.set(country, fields) }
    return fields
  }
  async function fields(): Promise<ResourceField[]> {
    const countries = (await db.execute<{ country: string }>(sql`select distinct country
      from employee_payroll_profiles where org_id=${orgId} order by country`)).rows
    const amounts: ResourceField[] = []
    for (const { country } of countries) for (const field of await declared(country)) {
      amounts.push({ key: amountKey(country, field), label: `${country}: ${field.label}`, kind: 'currency' })
    }
    return [...BASE_FIELDS, ...amounts]
  }
  return {
    descriptor: PAYROLL_PERIOD_OPENINGS_DESCRIPTOR, fields,
    async columns() { return (await fields()).map(({ key, label }) => ({ key, label })) },
    async read(ctx) {
      if (!ctx || ctx.allowedSubsidiaryIds === undefined) throw new Error('Period-opening export requires an explicit legal-entity scope')
      if (!(await db.execute<{ available: boolean }>(sql`select to_regclass('public.payroll_period_openings') is not null as available`)).rows[0]?.available) {
        throw new PayrollPeriodOpeningUnavailableError()
      }
      const columns = await fields()
      const rows = (await readExportWindow<Record<string, unknown>>(db, sql`
        select b.employee_party_id::text as employee,p.display_name as "employeeName",b.tax_year as "taxYear",
          coalesce(o.subsidiary_id,p.subsidiary_id)::text as "subsidiaryId",
          coalesce(o.pay_schedule_id,ep.pay_schedule_id)::text as "payScheduleId",
          coalesce(o.country,ep.country) as country,coalesce(o.currency,s.base_currency) as currency,
          o.period_start::text as "periodStart",o.period_end::text as "periodEnd",o.paid_through::text as "paidThrough",
          coalesce(o.revision::text,'new') as "expectedRevision",b.updated_at::text as "expectedAnnualUpdatedAt",
          o.source_reference as "sourceReference",o.reason,o.amounts
          ${transferId(ctx, sql`b.id`)}
        from payroll_opening_balances b
        join parties p on p.org_id=b.org_id and p.id=b.employee_party_id
        join employee_payroll_profiles ep on ep.org_id=b.org_id and ep.employee_party_id=p.id
        join subsidiaries s on s.org_id=p.org_id and s.id=p.subsidiary_id
        left join payroll_period_openings o on o.org_id=b.org_id and o.employee_party_id=b.employee_party_id and o.tax_year=b.tax_year
        where b.org_id=${orgId} ${subsidiaryReadFilter(sql`p.subsidiary_id`, ctx.allowedSubsidiaryIds)}
          ${transferWhere(ctx, sql`b.id`)} order by b.id limit ${transferLimit(ctx)}`, ctx)).rows
      finishExportPage(rows, PAYROLL_PERIOD_OPENINGS_DESCRIPTOR.label, ctx)
      const exported: Record<string, CellValue>[] = []
      for (const row of rows) {
        const packFields = await declared(String(row.country))
        if (!packFields.length) continue
        const amounts = row.amounts as Record<string, string> | null
        delete row.amounts
        for (const field of packFields) row[amountKey(String(row.country), field)] = amounts?.[field.key] ?? null
        exported.push(row as Record<string, CellValue>)
      }
      return { fields: columns, columns: columns.map(({ key, label }) => ({ key, label })), rows: exported }
    },
    async write(rows, mode, ctx) {
      if (ctx.orgId !== orgId || ctx.allowedSubsidiaryIds === undefined) throw new Error('Period-opening import requires the owning organization and an explicit legal-entity scope')
      if (ctx.post) throw new Error('Period openings cannot post payroll — calculate and review the run in Payroll')
      const prepared: ({ row: Record<string, unknown>; employeePartyId: string; taxYear: number; key: string } | { error: string })[] = []
      for (const row of rows) {
        try {
          const value = String(row.employee ?? '').trim()
          if (!value) throw new Error('Employee is required — use a unique payroll number or native employee ID')
          const employees = (await db.execute<{ id: string }>(sql`select distinct p.id from parties p
            join employee_payroll_profiles ep on ep.org_id=p.org_id and ep.employee_party_id=p.id
            left join employee_roles er on er.org_id=p.org_id and er.party_id=p.id
            where p.org_id=${orgId} and (lower(p.id::text)=lower(${value}) or er.employee_number=${value}
              or p.short_code=${value} or p.display_name=${value})
            ${subsidiaryReadFilter(sql`p.subsidiary_id`, ctx.allowedSubsidiaryIds)} limit 2`)).rows
          if (employees.length !== 1) throw new Error('Employee is unavailable or ambiguous in your legal-entity scope — use its native employee ID')
          const taxYear = yearOf(row.taxYear), employeePartyId = employees[0]!.id
          prepared.push({ row, employeePartyId, taxYear, key: `${employeePartyId}:${taxYear}` })
        } catch (error) { prepared.push({ error: importRowError(error) }) }
      }
      const keys = prepared.map(row => 'error' in row ? null : row.key)
      await ctx.recordKeys?.(keys)
      const duplicates = duplicateImportRowIndexes(keys)
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      for (const [index, preparedRow] of prepared.entries()) {
        try {
          if ('error' in preparedRow) throw new Error(preparedRow.error)
          if (duplicates.has(index)) throw new Error('This employee and tax year appear more than once — keep one reviewed period attribution')
          const { row, employeePartyId, taxYear } = preparedRow
          const expectedRevision = revisionOf(row.expectedRevision)
          if (mode === 'insert' && expectedRevision !== null) throw new Error('This period opening already exists — select update mode and review its current revision')
          const country = String(row.country ?? '').trim(), packFields = await declared(country)
          if (!packFields.length) throw new Error(`${country} does not support prior-provider period attribution — use annual opening balances`)
          const allowed = new Set(packFields.map(field => amountKey(country, field)))
          for (const [key, value] of Object.entries(row)) {
            if (key.startsWith('amount:') && !allowed.has(key) && value !== '' && value !== null && value !== undefined) {
              throw new Error(`Input ${key} is not declared by ${country} — use only this employee's payroll pack fields`)
            }
          }
          const amounts = Object.fromEntries(packFields.map(field => [field.key, row[amountKey(country, field)]]))
          const result = await savePayrollPeriodOpening({ orgId, actorId: ctx.actorId, employeePartyId, taxYear,
            subsidiaryId: String(row.subsidiaryId ?? '').trim(), payScheduleId: String(row.payScheduleId ?? '').trim(),
            country, currency: String(row.currency ?? '').trim(), periodStart: String(row.periodStart ?? '').trim(),
            periodEnd: String(row.periodEnd ?? '').trim(), paidThrough: String(row.paidThrough ?? '').trim(), amounts,
            expectedRevision, expectedAnnualUpdatedAt: String(row.expectedAnnualUpdatedAt ?? ''),
            sourceReference: String(row.sourceReference ?? ''), reason: String(row.reason ?? ''),
            dryRun: ctx.dryRun, allowedSubsidiaryIds: ctx.allowedSubsidiaryIds })
          if (result.changed) { if (expectedRevision === null) outcome.created++; else outcome.updated++ }
        } catch (error) { outcome.failed++; outcome.errors.push({ row: index + 1, message: importRowError(error) }) }
      }
      return outcome
    },
  }
}
