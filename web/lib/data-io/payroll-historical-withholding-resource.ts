import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { recordHistoricalWithholding, payrollCertificate, resolveCertificate } from '@openbooks/engine/payroll/withholding'
import { duplicateImportRowIndexes, subsidiaryReadFilter, type DataResource } from './resource-core'
import { readExportWindow, transferId, transferWhere, transferLimit, finishExportPage } from './export-page'
import { importRowError } from './row-error'
import type { CellValue, ResourceDescriptor, ResourceField, WriteOutcome } from './types'

export const PAYROLL_HISTORICAL_WITHHOLDING_KEY = 'payroll-historical-withholding'
export const PAYROLL_HISTORICAL_WITHHOLDING_DESCRIPTOR: ResourceDescriptor = {
  key: PAYROLL_HISTORICAL_WITHHOLDING_KEY, label: 'Historical withholding inputs', group: 'Setup',
  iconKey: 'users', readPermission: 'payroll.read', writePermission: 'payroll.manage',
  supportsImport: true, scopedWrite: true, naturalKey: 'employee, form and effective window',
}
const FIELDS: ResourceField[] = [
  { key: 'employee', label: 'Employee ID', kind: 'text', required: true },
  { key: 'country', label: 'Payroll country', kind: 'text', required: true },
  { key: 'certificate', label: 'Withholding form key', kind: 'text', required: true },
  { key: 'answers', label: 'Historical field answers (JSON)', kind: 'long_text', required: true },
  { key: 'expectedCurrent', label: 'Reviewed current answers (JSON)', kind: 'long_text', required: true },
  { key: 'effectiveFrom', label: 'Effective from', kind: 'date', required: true },
  { key: 'effectiveTo', label: 'Effective through', kind: 'date', required: true },
  { key: 'reason', label: 'Dated source reference and reason', kind: 'long_text', required: true },
]
function answersObject(value: unknown, label: string): Record<string, string> {
  let parsed: unknown
  try { parsed = JSON.parse(String(value ?? '')) } catch { throw new Error(`${label} must be a JSON object of declared field names and string answers`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.values(parsed).some(value => typeof value !== 'string')) throw new Error(`${label} must contain string answers keyed by the form’s field names`)
  return parsed as Record<string, string>
}

/** The shared Data Import preview and approval workflow restores bounded source facts. */
export function payrollHistoricalWithholdingResource(orgId: string): DataResource {
  return {
    descriptor: PAYROLL_HISTORICAL_WITHHOLDING_DESCRIPTOR,
    async fields() { return FIELDS },
    async columns() { return FIELDS.map(({ key, label }) => ({ key, label })) },
    async read(ctx) {
      if (!ctx || ctx.allowedSubsidiaryIds === undefined) throw new Error('Historical withholding export requires an explicit legal-entity scope')
      const rows = (await readExportWindow<Record<string, unknown>>(db, sql`
        select c.employee_party_id::text as employee, c.country, c.certificate_key as certificate,
          c.answers, to_jsonb(prof) as profile, c.effective_from::text as "effectiveFrom",
          (c.superseded_on - 1)::text as "effectiveTo", a.changes->>'reason' as reason${transferId(ctx, sql`c.id`)}
        from employee_tax_certificates c
        join employee_payroll_profiles prof on prof.org_id=c.org_id and prof.employee_party_id=c.employee_party_id
        join parties p on p.org_id=c.org_id and p.id=c.employee_party_id
        join lateral (select changes from audit_log where org_id=c.org_id and table_name='employee_tax_certificates'
          and row_id=c.id and changes->>'kind'='historical_withholding_input' order by at desc, id desc limit 1) a on true
        where c.org_id=${orgId} ${subsidiaryReadFilter(sql`p.subsidiary_id`, ctx.allowedSubsidiaryIds)}
          ${transferWhere(ctx, sql`c.id`)} order by c.id limit ${transferLimit(ctx)}`, ctx)).rows
      const result = rows.map(row => {
        const certificate = payrollCertificate(String(row.country), String(row.certificate))
        const answers = row.answers as Record<string, string>
        const current = resolveCertificate({ certificate, profile: row.profile as Record<string, unknown> }).answers
        const { profile: _profile, ...values } = row
        return { ...values, answers: JSON.stringify(answers), expectedCurrent: JSON.stringify(
          Object.fromEntries(Object.keys(answers).map(key => [key, current[key] ?? '']))) } as Record<string, CellValue>
      })
      finishExportPage(result, PAYROLL_HISTORICAL_WITHHOLDING_DESCRIPTOR.label, ctx)
      return { fields: FIELDS, columns: FIELDS.map(({ key, label }) => ({ key, label })), rows: result }
    },
    async write(rows, _mode, ctx) {
      if (ctx.orgId !== orgId || ctx.allowedSubsidiaryIds === undefined) throw new Error('Historical withholding imports require this organization and an explicit legal-entity scope')
      if (ctx.post) throw new Error('Historical inputs cannot post payroll — calculate and review the run in Payroll')
      const keys = rows.map(row => [row.employee, row.country, row.certificate, row.effectiveFrom, row.effectiveTo].map(value => String(value ?? '').trim()).join('|'))
      if (ctx.recordKeys) await ctx.recordKeys(keys)
      const duplicates = duplicateImportRowIndexes(keys)
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      for (let index = 0; index < rows.length; index++) {
        try {
          if (duplicates.has(index)) throw new Error('Keep one reviewed set of answers per employee, form and effective window')
          const row = rows[index]!
          const result = await recordHistoricalWithholding({
            orgId, actorId: ctx.actorId, employeePartyId: String(row.employee ?? '').trim(),
            country: String(row.country ?? '').trim(), certificateKey: String(row.certificate ?? '').trim(),
            answers: answersObject(row.answers, 'Historical answers'), expectedCurrent: answersObject(row.expectedCurrent, 'Reviewed current answers'),
            effectiveFrom: String(row.effectiveFrom ?? '').trim(), effectiveTo: String(row.effectiveTo ?? '').trim(),
            reason: String(row.reason ?? '').trim(), allowedSubsidiaryIds: ctx.allowedSubsidiaryIds, dryRun: ctx.dryRun === true,
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
