import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  comparableSlots,
  priorRegisters,
  savePriorStub,
  recordUnmappedColumns,
  upsertPriorRegister,
  TOTAL_FIELD_KEYS,
  type ComparableSlot,
  type PriorStubWrite,
} from '@openbooks/engine/src/payroll-parallel-run-store.ts'
import {
  SOURCE_COLUMNS_KEY,
  UNMAPPED_COLUMNS_KEY,
  type CellValue,
  type ResourceDescriptor,
  type ResourceField,
  type WriteOutcome,
} from './types'
import type { DataResource, WriteCtx } from './resources'

/**
 * The prior payroll provider's register, as an import/export resource.
 *
 * A parallel run starts with a file: the register the outgoing system printed
 * for one pay period. Every provider's export has different column names, so
 * the job is mapping THEIR names onto OUR component vocabulary — which is
 * precisely what the generic mapping wizard does. Building a bespoke parser for
 * this would mean a second file-handling path, a second preview, a second error
 * table, and no mapping step at all.
 *
 * The target fields are resolved from the org's own `pay_components` at parse
 * time, so the vocabulary is whatever this tenant actually pays: a country
 * pack's statutory components, union fringes, and user components all appear
 * with no change here. Nothing in this file names a jurisdiction.
 *
 * UNMAPPED COLUMNS ARE THE POINT. An amount nobody mapped is exactly what hides
 * a real difference, so this resource:
 *   1. reads the reserved unmapped-columns metadata the import route preserves,
 *   2. reports each one as a row error (visible in the wizard's preview and
 *      result, and persisted in `import_jobs.errors`) WITHOUT failing the row,
 *      because a register legitimately carries non-amount columns too, and
 *   3. records them on the register, so the RECONCILIATION states them — a
 *      warning only the import screen showed is not a control.
 *
 * Writes go through engine/src/payroll-parallel-run-store.ts, so an import
 * cannot bypass the money validation or invent a component slot.
 */

const MAX_EXPORT_ROWS = 50_000

export const PRIOR_PAYROLL_REGISTER_KEY = 'prior-payroll-register'

export const PRIOR_PAYROLL_REGISTER_DESCRIPTOR: ResourceDescriptor = {
  key: PRIOR_PAYROLL_REGISTER_KEY,
  label: 'Prior payroll register (parallel run)',
  group: 'Setup',
  iconKey: 'clipboard-check',
  readPermission: 'payroll.read',
  writePermission: 'payroll.manage',
  supportsImport: true,
  naturalKey: 'register + employee',
}

/** Header fields every register row carries, before the component columns. */
const HEADER_FIELDS: ResourceField[] = [
  {
    key: 'register',
    label: 'Register name (e.g. "Prior provider — 2026-07-14")',
    kind: 'text',
    required: true,
  },
  { key: 'providerName', label: 'Prior provider', kind: 'text' },
  {
    key: 'employee',
    label: 'Employee (payroll number, code, or name)',
    kind: 'reference',
    required: true,
    ref: { resource: 'parties', by: 'short_code' },
  },
  { key: 'employeeName', label: 'Employee name', kind: 'text', readOnly: true },
  { key: 'periodStart', label: 'Period start', kind: 'date', required: true },
  { key: 'periodEnd', label: 'Period end', kind: 'date', required: true },
  { key: 'payDate', label: 'Pay date', kind: 'date', required: true },
]

/**
 * Resolve whatever the prior provider's register calls a person.
 *
 * The payroll number first, because that is what those reports actually carry,
 * then the party short code, then the display name. An ambiguous name is
 * REFUSED rather than guessed: loading one Chen's period onto the other Chen
 * turns a reconciliation into two fabricated differences and one hidden match.
 *
 * The population is "somebody payroll knows about" — a party carrying an
 * employee role or a payroll profile — deliberately NOT `parties.kind = 'person'`.
 * `kind` is `'employee'` in tenants provisioned through the employee entity, so
 * a kind filter silently resolves nobody and every row of a real register fails
 * to import. The role/profile join is also the stricter test: it cannot match a
 * customer contact who happens to share a name with an employee.
 */
async function resolveEmployee(
  orgId: string,
  raw: unknown,
): Promise<{ id: string } | { error: string }> {
  const value = String(raw ?? '').trim()
  if (!value) return { error: 'employee is required' }
  const matches = (await db.execute(sql`
    select distinct p.id, p.display_name
      from parties p
      left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
      left join employee_payroll_profiles prof
        on prof.employee_party_id = p.id and prof.org_id = p.org_id
     where p.org_id = ${orgId}
       and (er.party_id is not null or prof.employee_party_id is not null)
       and (p.id::text = ${value}
            or er.employee_number = ${value}
            or p.short_code = ${value}
            or p.display_name = ${value})
     limit 3
  `)) as { rows: { id: string; display_name: string }[] }
  if (matches.rows.length === 0) {
    return { error: `employee "${value}" not found — no payroll number, code, or name matches` }
  }
  if (matches.rows.length > 1) {
    return { error: `employee "${value}" matches more than one person — use the payroll number` }
  }
  return { id: matches.rows[0]!.id }
}

/**
 * Source columns nobody mapped, as the import route preserved them: header →
 * the raw value it carried in this row.
 */
function unmappedFrom(src: Record<string, unknown>): [string, unknown][] {
  const raw = src[UNMAPPED_COLUMNS_KEY]
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.entries(raw as Record<string, unknown>).filter(
    ([header]) => header.trim().length > 0,
  )
}

/**
 * Which column of the operator's file each field came from.
 *
 * Falls back to our own slot label when the route did not supply it (a direct
 * API caller, or an older client), so a finding always names something — but
 * the operator's own header is what makes it actionable.
 */
function sourceColumnsFrom(src: Record<string, unknown>): Record<string, string> {
  const raw = src[SOURCE_COLUMNS_KEY]
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [field, column] of Object.entries(raw as Record<string, unknown>)) {
    const header = String(column ?? '').trim()
    if (header) out[field] = header
  }
  return out
}

function money(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  return raw === '' ? null : raw
}

export function priorPayrollRegisterResource(orgId: string): DataResource {
  // One query per resource instance, not per row. `fields()` is called on every
  // parse and on every export-page selection.
  let slotCache: ComparableSlot[] | null = null
  const slots = async (): Promise<ComparableSlot[]> => {
    slotCache ??= await comparableSlots(orgId)
    return slotCache
  }

  const buildFields = async (): Promise<ResourceField[]> => {
    const all = await slots()
    return [
      ...HEADER_FIELDS,
      // The register's OWN stated totals. Required, because the comparison
      // reconciles them against the sum of the mapped components — that
      // identity is what surfaces an amount column nobody mapped.
      ...all
        .filter((slot) => slot.kind === 'total')
        .map((slot) => ({
          key: slot.fieldKey,
          label: slot.label,
          kind: 'currency' as const,
          required: slot.slot !== 'employer_cost',
        })),
      ...all
        .filter((slot) => slot.kind !== 'total')
        .map((slot) => ({
          key: slot.fieldKey,
          label: slot.label,
          kind: 'currency' as const,
        })),
    ]
  }

  return {
    descriptor: PRIOR_PAYROLL_REGISTER_DESCRIPTOR,
    async fields() {
      return buildFields()
    },
    async columns() {
      const fields = await buildFields()
      return fields.map((f) => ({ key: f.key, label: f.label }))
    },
    async read() {
      const [fields, all] = await Promise.all([buildFields(), slots()])
      const columns = fields.map((f) => ({ key: f.key, label: f.label }))
      const rows = (await db.execute(sql`
        select g.name as "register", g.provider_name as "providerName",
               coalesce(er.employee_number, p.short_code, s.employee_label) as "employee",
               p.display_name as "employeeName",
               g.period_start::text as "periodStart",
               g.period_end::text as "periodEnd",
               g.pay_date::text as "payDate",
               s.gross, s.net_pay, s.employer_cost,
               s.id as "stubId"
          from payroll_prior_stubs s
          join payroll_prior_registers g on g.id = s.register_id and g.org_id = s.org_id
          left join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
          left join employee_roles er on er.party_id = s.employee_party_id and er.org_id = s.org_id
         where s.org_id = ${orgId}
         order by g.pay_date desc, p.display_name
         limit ${MAX_EXPORT_ROWS}`)) as { rows: Record<string, CellValue>[] }

      const amounts = (await db.execute(sql`
        select a.prior_stub_id, a.kind, a.slot, a.amount
          from payroll_prior_amounts a
          join payroll_prior_stubs s on s.id = a.prior_stub_id and s.org_id = a.org_id
         where a.org_id = ${orgId}`)) as {
        rows: { prior_stub_id: string; kind: string; slot: string; amount: string }[]
      }
      // Slot → the field key it exports under, so an export re-imports cleanly.
      const fieldKeyBySlot = new Map(
        all.filter((s) => s.kind !== 'total').map((s) => [`${s.kind}/${s.slot}`, s.fieldKey]),
      )
      const bySt = new Map<string, Record<string, CellValue>>()
      for (const row of amounts.rows) {
        const fieldKey = fieldKeyBySlot.get(`${row.kind}/${row.slot}`)
        if (!fieldKey) continue
        const bucket = bySt.get(row.prior_stub_id) ?? {}
        bucket[fieldKey] = row.amount
        bySt.set(row.prior_stub_id, bucket)
      }

      const totalKeyBySlot = new Map(
        Object.entries(TOTAL_FIELD_KEYS).map(([fieldKey, slot]) => [slot, fieldKey]),
      )
      return {
        fields,
        columns,
        rows: rows.rows.map((row) => {
          const stubId = String(row.stubId)
          const out: Record<string, CellValue> = { ...row }
          delete out.stubId
          out[totalKeyBySlot.get('gross')!] = row.gross!
          out[totalKeyBySlot.get('net_pay')!] = row.net_pay!
          out[totalKeyBySlot.get('employer_cost')!] = row.employer_cost!
          delete out.gross
          delete out.net_pay
          delete out.employer_cost
          return { ...out, ...(bySt.get(stubId) ?? {}) }
        }),
      }
    },
    async write(rows, _mode, ctx: WriteCtx) {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      const all = await slots()
      const componentSlots = all.filter((slot) => slot.kind !== 'total')

      // A register whose amount columns are ALL unmapped is not an import, it
      // is a population list — and it would reconcile to a pile of one-sided
      // findings nobody can act on. Refuse the whole load, once, up front.
      const mappedComponentKeys = new Set<string>()
      for (const src of rows) {
        for (const slot of componentSlots) {
          if (src[slot.fieldKey] !== undefined) mappedComponentKeys.add(slot.fieldKey)
        }
      }
      if (rows.length > 0 && mappedComponentKeys.size === 0) {
        outcome.failed += rows.length
        outcome.errors.push({
          row: 0,
          message:
            'no component column was mapped — map the prior register\'s earning, deduction and contribution columns onto this payroll\'s components, or the comparison has nothing to reconcile',
        })
        return outcome
      }

      // Unmapped source columns, counted across the whole file, reported once
      // per column rather than once per row.
      const unmappedCounts = new Map<string, number>()
      for (const src of rows) {
        for (const [column, value] of unmappedFrom(src)) {
          const carriesValue = String(value ?? '').trim() !== ''
          unmappedCounts.set(column, (unmappedCounts.get(column) ?? 0) + (carriesValue ? 1 : 0))
        }
      }

      // Registers are per (name, period); cache so a 400-row file is not 400
      // upserts of the same header.
      const registerCache = new Map<string, string>()
      const touchedRegisters = new Set<string>()

      for (let index = 0; index < rows.length; index++) {
        const rowNo = index + 1
        const src = rows[index]!
        try {
          const registerName = String(src.register ?? '').trim()
          if (!registerName) {
            outcome.failed++
            outcome.errors.push({ row: rowNo, message: 'register is required', field: 'register' })
            continue
          }
          const employee = await resolveEmployee(ctx.orgId, src.employee)
          if ('error' in employee) {
            outcome.failed++
            outcome.errors.push({ row: rowNo, message: employee.error, field: 'employee' })
            continue
          }

          const sourceColumns = sourceColumnsFrom(src)
          const amounts: PriorStubWrite['amounts'] = []
          for (const slot of componentSlots) {
            const raw = money(src[slot.fieldKey])
            if (raw === null) continue
            amounts.push({
              fieldKey: slot.fieldKey,
              amount: raw,
              sourceColumn: sourceColumns[slot.fieldKey] ?? slot.label,
            })
          }

          const stub: PriorStubWrite = {
            employeePartyId: employee.id,
            employeeLabel: String(src.employee ?? '').trim(),
            gross: money(src['total:gross']),
            netPay: money(src['total:net_pay']),
            employerCost: money(src['total:employer_cost']),
            amounts,
          }
          if (stub.gross === null || stub.netPay === null) {
            outcome.failed++
            outcome.errors.push({
              row: rowNo,
              message:
                'the register must state its own gross and net for this employee — the reconciliation proves them against the mapped components, which is how an unmapped amount column is caught',
            })
            continue
          }

          // A dry run validates everything and writes nothing, so the wizard's
          // preview is a real preview rather than a row count.
          if (ctx.dryRun) {
            const existing = (await db.execute(sql`
              select 1 from payroll_prior_stubs s
                join payroll_prior_registers g on g.id = s.register_id and g.org_id = s.org_id
               where s.org_id = ${ctx.orgId} and g.name = ${registerName}
                 and s.employee_party_id = ${employee.id}
               limit 1`)) as { rows: unknown[] }
            if (existing.rows.length > 0) outcome.updated++
            else outcome.created++
            continue
          }

          if (!registerCache.has(registerName)) {
            registerCache.set(
              registerName,
              await upsertPriorRegister({
                orgId: ctx.orgId,
                actorId: ctx.actorId,
                name: registerName,
                providerName: String(src.providerName ?? '').trim() || null,
                periodStart: String(src.periodStart ?? ''),
                periodEnd: String(src.periodEnd ?? ''),
                payDate: String(src.payDate ?? ''),
              }),
            )
          }
          const registerId = registerCache.get(registerName)!
          touchedRegisters.add(registerId)

          const result = await savePriorStub(
            { orgId: ctx.orgId, actorId: ctx.actorId, registerId, row: stub },
            all,
          )
          if (result.created) outcome.created++
          else outcome.updated++
        } catch (error) {
          outcome.failed++
          outcome.errors.push({
            row: rowNo,
            message: error instanceof Error ? error.message : 'write failed',
          })
        }
      }

      // Record the unmapped columns on every register this load touched, and
      // report them. This is NOT a row failure: a register legitimately carries
      // department, cost centre and hour columns that map onto nothing. It is
      // an unavoidable statement that an amount may be unaccounted for.
      if (unmappedCounts.size > 0) {
        if (!ctx.dryRun) {
          const columns = [...unmappedCounts.entries()].map(([column, valuedRows]) => ({
            column,
            valuedRows,
          }))
          for (const registerId of touchedRegisters) {
            await recordUnmappedColumns(ctx.orgId, registerId, columns)
          }
        }
        for (const [column, valuedRows] of [...unmappedCounts.entries()].sort()) {
          outcome.errors.push({
            row: 0,
            field: column,
            message:
              `column "${column}" was not mapped onto a component (a value in ${valuedRows} row(s)). ` +
              'Nothing in it is compared, and the reconciliation will report it as unmapped. ' +
              'Map it, or confirm it carries no amount.',
          })
        }
      }

      // Prove the load is not silently empty. An import that resolved nobody is
      // exactly what makes a later comparison look clean for the wrong reason.
      if (rows.length > 0 && outcome.created + outcome.updated === 0 && outcome.failed === 0) {
        outcome.errors.push({
          row: 0,
          message: 'no register row was written — nothing in this file resolved to an employee',
        })
      }

      return outcome
    },
  }
}

/** Registers currently loaded, for surfaces that offer them as a comparison side. */
export async function loadedPriorRegisters(orgId: string) {
  return priorRegisters(orgId)
}
