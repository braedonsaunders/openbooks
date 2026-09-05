import { jsonObject, parseJsonBody, uuidId } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { CurrencyError, updateFxRate } from '@openbooks/engine/src/currencies.ts'
import { db, type SqlExecutor } from '@openbooks/engine/src/db.ts'
import { toUnits } from '@openbooks/engine/src/money.ts'
import { compileFormula } from '@openbooks/engine/src/depreciation-formula.ts'
import { filingAccountProblem } from '@openbooks/engine/src/payroll-filing-registry.ts'
import { payPeriodsPerYearProblem, semiMonthlyAnchorProblem } from '@openbooks/engine/src/payroll-run.ts'
import { guardPermission } from '../../../../../lib/authz'
import { SETUP_ENTITY_BY_KEY, setupEntityForFeatureState, toSnake, type SetupEntity } from '../../../../../lib/setup/registry'
import {
  buildRow,
  coerceBoolean,
  describeDbError,
  idColumn,
  multirefField,
  pgErrorCode,
  taxRatePercentProblem,
  UUID_RE,
} from '../../../../../lib/setup/coerce'
import { normalizeTaxReturnFormInput } from '../../../../../lib/setup/tax-return-form'
import { saveSetupBook } from '../../../../../lib/setup/books'
import { auditSetupChange as audit, loadSetupAuditRow } from '../../../../../lib/setup/audit'
import { featureEnabled, featureGateLockKey, isFeatureEnabled, resolvedFeatureState, subsidiaryFeatureEnabled } from '../../../../../lib/features'
import { loadNumberSequenceKindOptions } from '../../../../../lib/setup/number-sequence-kinds'

export const runtime = 'nodejs'

/**
 * Generic CRUD for every configuration entity in the Setup registry
 * (web/lib/setup/registry.ts). One route serves all of them — the entity slug
 * in the path selects the descriptor, which drives column whitelisting,
 * validation, and the SQL.
 *
 * SECURITY: table and column identifiers are taken ONLY from the registry
 * (never from the request body) and interpolated with sql.raw; every value is a
 * bound parameter. The request body cannot introduce a column name.
 *
 * Gated by admin.setup.manage. Org-scoped (except the shared `currencies`
 * reference table) and audited to audit_log, mirroring the settings route.
 */

const PERMISSION = 'admin.setup.manage'

class SetupWriteRefusal extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
type SetupTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Recheck authoritative entity and field gates on the same transaction/connection
 * that writes configuration. Take this fence before any row or book locks. */
async function setupWriteTransaction<T>(
  entity: SetupEntity, orgId: string, body: Record<string, unknown> | undefined,
  rowId: string | undefined, write: (tx: SetupTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${featureGateLockKey(orgId)}, 0))`)
    if (!(await setupEntityEnabled(entity, orgId, tx))) throw new SetupWriteRefusal('unknown setup entity', 404)
    if (body) {
      const problem = await validateEntityIntegrity(entity, body, orgId, rowId, tx)
      if (problem) throw new SetupWriteRefusal(problem, problem === 'not found' ? 404 : 400)
      if (entity.key === 'item-rate-books' && body.currency !== undefined
        && !(await isFeatureEnabled(orgId, 'multiCurrency', tx))) {
        throw new SetupWriteRefusal('not found', 404)
      }
    }
    return write(tx)
  })
}

const FX_RATE_COLUMNS = new Set(['rate', 'current_rate', 'average_rate', 'historical_rate'])

/** Compare values read from PostgreSQL with the normalized values produced by
 * the setup coercer. Money columns come back at their storage scale (for
 * example `70.0000`) while the decimal coercer deliberately emits the wider
 * setup scale (`70.0000000000`); those representations are the same rule. */
function comparableSetupValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try { return JSON.stringify(JSON.parse(trimmed)) } catch { /* text value */ }
    }
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const negative = trimmed.startsWith('-')
      const unsigned = negative ? trimmed.slice(1) : trimmed
      const [rawWhole, fraction = ''] = unsigned.split('.')
      const whole = rawWhole ?? ''
      const normalized = `${whole.replace(/^0+(?=\d)/, '')}${fraction ? `.${fraction.replace(/0+$/, '')}` : ''}`
      return (negative && normalized !== '0') ? `-${normalized}` : normalized
    }
    return trimmed
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function persistFxRateCols<T extends { column: string; value: unknown }>(cols: T[]): T[] {
  return cols.map((column) =>
    FX_RATE_COLUMNS.has(column.column)
      ? { ...column, value: updateFxRate({ rate: column.value }) }
      : column,
  )
}

/**
 * Bind a validated id list as ONE pg-array parameter. Drizzle expands a raw
 * JS array inside sql`` into a row constructor ($1, $2), so the list crosses
 * sql.param exactly once and node-postgres serializes it natively — request
 * values can never shape the statement text.
 */
const uuidArrayParam = (ids: string[]) => sql.param(ids)

/** Boundary gate for request-supplied id lists: every entry must parse as the
 * shared uuidId schema before SQL sees it, so a malformed or hostile id is the
 * route's documented client error instead of PostgreSQL raising 22P02 outside
 * this handler's validation catch. */
function hasNonUuidEntry(ids: unknown[]): boolean {
  return !ids.every((id) => uuidId.safeParse(id).success)
}

/** Reconcile a tax group's members join table to exactly `taxCodeIds`. */
async function syncMembers(
  orgId: string,
  groupId: string,
  taxCodeIds: string[],
  runner: Pick<typeof db, 'execute'> = db,
) {
  const clean = [...new Set(taxCodeIds.filter((v) => UUID_RE.test(v)))]
  await runner.execute(sql`
    delete from tax_group_members
     where tax_group_id = ${groupId}
       and exists (select 1 from tax_groups where id = ${groupId} and org_id = ${orgId})`)
  for (let i = 0; i < clean.length; i++) {
    await runner.execute(sql`
      insert into tax_group_members (tax_group_id, tax_code_id, sequence)
      select tg.id, ${clean[i]}, ${i + 1}
        from tax_groups tg
       where tg.id = ${groupId} and tg.org_id = ${orgId}`)
  }
}

function resolveEntity(entityKey: string): SetupEntity | null {
  return SETUP_ENTITY_BY_KEY.get(entityKey) ?? null
}

async function setupEntityEnabled(entity: SetupEntity, orgId: string, executor: Pick<typeof db, 'execute'> = db): Promise<boolean> {
  if (!entity.featureKey) return true
  return featureEnabled(await resolvedFeatureState(orgId, executor), entity.featureKey)
}

/** Hide Equipment-gated controls for writes, but keep an existing
 *  equipment_charge trigger coercible so editing other fields on that row
 *  does not rewrite the gated value as a new persist. */
function writableSetupEntity(
  entity: SetupEntity,
  features: { multiSubsidiary: boolean; equipment: boolean; fieldTickets: boolean },
): SetupEntity {
  const next = setupEntityForFeatureState(entity, features)
  if (features.equipment) return next
  const trigger = entity.fields.find((field) => field.key === 'trigger')
  if (!trigger?.options?.some((option) => option.value === 'equipment_charge')) return next
  return {
    ...next,
    fields: next.fields.map((field) => (
      field.key === 'trigger' ? { ...field, options: trigger.options } : field
    )),
  }
}

/** Domain checks that cannot be expressed by the generic field coercer. */
async function validateEntityIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  rowId?: string,
  executor: SqlExecutor = db,
): Promise<string | null> {
  const submittedSubsidiaryScope = entity.fields
    .filter((field) => field.ref === 'subsidiaries')
    .some((field) => Boolean(body[field.key]))
  if (submittedSubsidiaryScope && !(await subsidiaryFeatureEnabled(orgId, executor))) {
    return 'Subsidiaries are not enabled for this organization'
  }
  if (entity.key === 'pay-derived-rules') {
    // Equipment attribution is a Features-gated write. Turning Equipment off
    // must stop a new unit link or equipment_charge trigger without wiping
    // rules that already carry one.
    const current = rowId
      ? (((await executor.execute(sql`
          select trigger, equipment_unit_id from pay_derived_rules
           where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    if (rowId && !current) return 'not found'
    const submittedUnit = Boolean(body.equipmentUnitId)
    const submittedChargeTrigger = body.trigger === 'equipment_charge'
    const changingUnit = submittedUnit && body.equipmentUnitId !== current?.equipment_unit_id
    const changingTrigger = submittedChargeTrigger && current?.trigger !== 'equipment_charge'
    if ((changingUnit || changingTrigger || (!rowId && (submittedUnit || submittedChargeTrigger)))
      && !(await isFeatureEnabled(orgId, 'equipment', executor))) {
      return 'not found'
    }
  }
  if (entity.key === 'time-types' && body.showOnFieldTicket !== undefined
    && !(await isFeatureEnabled(orgId, 'fieldTickets', executor))) {
    return 'not found'
  }
  if (entity.key === 'number-sequences') {
    const current = rowId
      ? (((await executor.execute(sql`
          select document_kind, subsidiary_id from number_sequences
           where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    if (rowId && !current) return 'not found'
    const documentKind = String(body.documentKind ?? current?.document_kind ?? '')
    const allowedKinds = new Set((await loadNumberSequenceKindOptions(orgId, executor)).map((option) => option.value))
    if (!allowedKinds.has(documentKind)) return 'Choose a valid document or custom record type'

    const submittedSubsidiaryId = body.subsidiaryId || null
    if (submittedSubsidiaryId) {
      if (!(await subsidiaryFeatureEnabled(orgId, executor))) return 'Subsidiaries are not enabled for this organization'
      if (!UUID_RE.test(String(submittedSubsidiaryId))) return 'Choose a valid subsidiary'
      const subsidiary = ((await executor.execute(sql`
        select 1 from subsidiaries
         where id = ${String(submittedSubsidiaryId)} and org_id = ${orgId}
           and is_active and not is_elimination`)))
      if (!subsidiary.rows.length) return 'Choose an active subsidiary from this organization'
    }
  }
  if (entity.key === 'depreciation-methods') {
    const current = rowId
      ? (((await executor.execute(sql`select formula from depreciation_methods where id=${rowId} and org_id=${orgId}`)))).rows[0]
      : null
    if (rowId && !current) return 'not found'
    const formula = String(body.formula ?? current?.formula ?? '').trim()
    if (!formula || formula.length > 2048) return 'invalid-depreciation-formula'
    try {
      compileFormula(formula)
    } catch {
      return 'invalid-depreciation-formula'
    }
  }
  if (entity.key === 'tax-return-forms' && body.submissionUrl) {
    try {
      const url = new URL(String(body.submissionUrl))
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'invalid-url'
    } catch {
      return 'invalid-url'
    }
  }
  if (entity.key === 'tax-rates') {
    // One exact-decimal contract with the calculation engine
    // (engine/src/tax.ts): a rate is a nonnegative exact decimal with at most
    // 4 decimal places. Without this check the generic percent coercer admits
    // FX-scale values PostgreSQL silently rounds into numeric(19,4), and a
    // negative rate saves "successfully" only to fail every later document at
    // calculation time. A statutory 0% rate stays legal.
    const current = rowId
      ? (((await executor.execute(sql`
          select rate_percent::text as rate_percent from tax_rates
           where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    if (rowId && !current) return 'not found'
    const raw = body.ratePercent !== undefined ? body.ratePercent : current?.rate_percent
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return 'ratePercent is required'
    }
    return taxRatePercentProblem(raw)
  }
  if (entity.key === 'tax-codes') {
    const current = rowId
      ? (((await executor.execute(sql`select * from tax_codes where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    if (rowId && !current) return 'not found'
    const value = (camel: string, snake: string, fallback: unknown) =>
      body[camel] !== undefined ? body[camel] : current?.[snake] ?? fallback
    const calculationType = String(value('calculationType', 'calculation_type', 'standard'))
    const appliesTo = String(value('appliesTo', 'applies_to', 'both'))
    const inclusive = coerceBoolean(value('priceIncludesTax', 'price_includes_tax', false))
    const roundingScale = Number(value('roundingScale', 'rounding_scale', 2))
    if (!['standard', 'withholding', 'reverse_charge'].includes(calculationType)) return 'invalid-tax-calculation-type'
    if (inclusive && calculationType !== 'standard') return 'inclusive-standard-only'
    if (!Number.isInteger(roundingScale) || roundingScale < 0 || roundingScale > 4) return 'invalid-tax-rounding-scale'
    try {
      const recovery = toUnits(String(value('recoverablePercent', 'recoverable_percent', '100')))
      if (recovery < 0n || recovery > toUnits('100')) return 'invalid-recoverable-percent'
    } catch {
      return 'invalid-recoverable-percent'
    }
    const withholdingAccountId = value('withholdingAccountId', 'withholding_account_id', null)
    const collectedAccountId = value('collectedAccountId', 'collected_account_id', null)
    const paidAccountId = value('paidAccountId', 'paid_account_id', null)
    if (calculationType === 'withholding' && !withholdingAccountId) return 'withholding-account-required'
    if (calculationType === 'reverse_charge' && (!collectedAccountId || !paidAccountId)) return 'reverse-charge-accounts-required'
    const accountIds = [withholdingAccountId, collectedAccountId, paidAccountId].filter(Boolean).map(String)
    if (accountIds.length > 0) {
      const accounts = ((await executor.execute(sql`
        select id from accounts where org_id = ${orgId} and id = any(${`{${accountIds.join(',')}}`}::uuid[])
          and is_active and not is_summary
      `)))
      if (accounts.rows.length !== new Set(accountIds).size) return 'invalid-tax-account'
    }
    if (!['sales', 'purchases', 'both'].includes(appliesTo)) return 'invalid-tax-application-scope'
  }
  if (entity.key === 'tax-groups') {
    const current = rowId
      ? (((await executor.execute(sql`
          select price_includes_tax from tax_groups where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    if (rowId && !current) return 'not found'
    const members = Array.isArray(body.members)
      ? body.members.map(String)
      : rowId
        ? (((await executor.execute(sql`
            select tgm.tax_code_id
              from tax_group_members tgm
              join tax_groups tg on tg.id = tgm.tax_group_id and tg.org_id = ${orgId}
             where tgm.tax_group_id = ${rowId}
             order by tgm.sequence`)))).rows.map((row) => String(row.tax_code_id))
        : []
    if (members.length === 0) return 'tax-group-members-required'
    if (new Set(members).size !== members.length || members.some((id: string) => !UUID_RE.test(id))) return 'invalid-tax-group-members'
    const rows = ((await executor.execute(sql`
      select id, calculation_type from tax_codes
       where org_id = ${orgId} and is_active and id = any(${`{${members.join(',')}}`}::uuid[])
    `)))
    if (rows.rows.length !== members.length) return 'invalid-tax-group-members'
    const inclusive = body.priceIncludesTax === undefined
      ? Boolean(current?.price_includes_tax)
      : coerceBoolean(body.priceIncludesTax)
    if (inclusive && rows.rows.some((row) => row.calculation_type !== 'standard')) {
      return 'inclusive-tax-group-standard-only'
    }
  }
  if (entity.key === 'tax-pool-classes') {
    const current = rowId
      ? (((await executor.execute(sql`select * from tax_pool_classes where id=${rowId} and org_id=${orgId}`)))).rows[0]
      : null
    if (rowId && !current) return 'not found'
    const value = (camel: string, snake: string) => body[camel] !== undefined ? body[camel] : current?.[snake]
    const regimeCode = String(value('regime', 'regime') ?? '')
    const regime = ((await executor.execute(sql`
      select calculation_model from tax_regimes where org_id=${orgId} and code=${regimeCode} and is_active limit 1`)))
    if (!regime.rows[0]) return 'install-or-create-tax-depreciation-regime-first'
    const recovery = Number(value('recoveryPeriodYears', 'recovery_period_years'))
    if (regime.rows[0].calculation_model === 'macrs') {
      if (!['gds', 'ads'].includes(String(value('depreciationSystem', 'depreciation_system') ?? ''))) return 'macrs-system-required'
      if (!['200_db', '150_db', 'straight_line'].includes(String(value('macrsMethod', 'macrs_method') ?? ''))) return 'macrs-method-required'
      if (!Number.isFinite(recovery) || recovery <= 0) return 'macrs-recovery-period-required'
      if (!['half_year', 'mid_quarter', 'mid_month'].includes(String(value('convention', 'convention') ?? ''))) return 'macrs-convention-required'
    }
    const fraction = Number(value('firstYearFraction', 'first_year_fraction') ?? 1)
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) return 'first-year-fraction-out-of-range'
  }
  if (entity.key === 'accounting-books') {
    if (coerceBoolean(body.isPrimary) && body.isActive !== undefined && !coerceBoolean(body.isActive)) {
      return 'primary-active-required'
    }
    if (rowId) {
      const existing = ((await executor.execute(sql`
        select is_primary from accounting_books where id = ${rowId} and org_id = ${orgId}`)))
      if (!existing.rows[0]) return 'not found'
      if (existing.rows[0].is_primary && !coerceBoolean(body.isPrimary)) return 'primary-required'
      if (existing.rows[0].is_primary && !coerceBoolean(body.isActive)) return 'primary-active-required'
    }
  }

  if (entity.key === 'payroll-filing-accounts') {
    // The pack's declared filing program types are the constraint that used
    // to be the payroll_filing_accounts_country/_program/_program_country/
    // _state DB CHECKs. A CHECK cannot enumerate an open pack registry, so
    // the declaration (engine/src/payroll-filing-registry.ts) is asked here,
    // at the API boundary, for creates and edits alike.
    const current = rowId
      ? (((await executor.execute(sql`
          select country, program_type, state_code from payroll_filing_accounts
           where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    if (rowId && !current) return 'not found'
    const country = String(body.country ?? current?.country ?? '')
    const programType = String(body.programType ?? current?.program_type ?? '')
    const stateCode = body.stateCode === undefined
      ? ((current?.state_code as string | null) ?? null)
      : (body.stateCode ? String(body.stateCode) : null)
    const problem = filingAccountProblem({ country, programType, stateCode })
    if (problem) return problem
  }
  if (entity.key === 'pay-schedules') {
    // `anchor_period_end` is a REQUIRED field the engine derives every period
    // boundary from, semi-monthly included: the anchor's day-of-month names one
    // of the month's two period ends and its half-month complement names the
    // other (engine/src/payroll-run.ts, `semiMonthlyBoundaries`). Two anchor
    // shapes do not determine a calendar — the 14th, whose complement is a day
    // February does not always have, and the last day of a 28-day February,
    // which is simultaneously "the 28th" and "the month end". Both are refused
    // HERE, by name, rather than quietly reinterpreted: a schedule that saves
    // and then pays on days the employer did not choose misaligns every pay
    // date, the periods-per-year assumption the statutory engines annualize
    // with, and the period-overlap guard.
    const current = rowId
      ? (((await executor.execute(sql`
          select frequency, periods_per_year, anchor_period_end::text as anchor_period_end
            from pay_schedules
           where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    if (rowId && !current) return 'not found'
    const frequency = String(body.frequency ?? current?.frequency ?? '')
    const anchor = body.anchorPeriodEnd === undefined
      ? String(current?.anchor_period_end ?? '')
      : String(body.anchorPeriodEnd ?? '')
    if (frequency === 'semi_monthly') {
      const problem = semiMonthlyAnchorProblem(anchor)
      if (problem) return problem
    }
    // Factor P has to match the calendar the other two fields describe; the
    // table's CHECK only constrains it to the union across all frequencies.
    const periodsPerYear = Number(body.periodsPerYear ?? current?.periods_per_year)
    if (Number.isFinite(periodsPerYear)) {
      const problem = payPeriodsPerYearProblem(frequency, periodsPerYear)
      if (problem) return problem
    }
  }

  if (entity.key === 'segment-definitions') {
    const key = String(body.key ?? '')
    if (!rowId && !/^[a-z][a-z0-9_]{0,62}$/.test(key)) {
      return 'The key must start with a lowercase letter and contain only lowercase letters, numbers, and underscores'
    }
    if (rowId) {
      const existing = ((await executor.execute(sql`
        select source_kind from segment_definitions where id = ${rowId} and org_id = ${orgId}`)))
      if (!existing.rows[0]) return 'not found'
    }
  }

  if (entity.key === 'segment-values') {
    const existing = rowId
      ? (((await executor.execute(sql`
          select segment_id, parent_id from segment_values where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    if (rowId && !existing) return 'not found'
    const segmentId = String(body.segmentId ?? existing?.segment_id ?? '')
    if (!UUID_RE.test(segmentId)) return 'Values can only be created for a custom segment'
    const segment = ((await executor.execute(sql`
      select id, is_hierarchical from segment_definitions
       where id = ${segmentId} and org_id = ${orgId} and source_kind = 'custom'`)))
    if (!segment.rows[0]) return 'Values can only be created for a custom segment'
    const parentId = body.parentId === undefined ? existing?.parent_id ?? null : body.parentId || null
    if (parentId) {
      if (!segment.rows[0].is_hierarchical) return 'This segment is not hierarchical'
      if (!UUID_RE.test(String(parentId))) return 'Choose a parent value from the same segment'
      const parent = ((await executor.execute(sql`
        select id from segment_values where id = ${String(parentId)} and org_id = ${orgId}
         and segment_id = ${segmentId}`)))
      if (!parent.rows[0]) return 'Choose a parent value from the same segment'
      if (rowId) {
        // This is the early, user-facing check. segment_value_guard repeats it
        // after taking the per-tenant/per-segment storage fence, which closes
        // the concurrent cross-reparent window for this route and every other
        // writer (bulk import and direct SQL included).
        const cycle = ((await executor.execute(sql`
          with recursive descendants as (
            select id from segment_values
             where id = ${rowId} and org_id = ${orgId} and segment_id = ${segmentId}
            union
            select value.id from segment_values value
            join descendants descendant on value.parent_id = descendant.id
             where value.org_id = ${orgId} and value.segment_id = ${segmentId}
          ) select 1 from descendants where id = ${String(parentId)} limit 1`)))
        if (cycle.rows.length) return 'A segment value cannot be parented beneath itself'
      }
    }
  }

  if (entity.key === 'subsidiaries') {
    const existing = rowId
      ? ((await executor.execute(sql`
          select id, parent_id, is_active, is_elimination from subsidiaries
           where id = ${rowId} and org_id = ${orgId}`)) as any).rows[0]
      : null
    if (rowId && !existing) return 'not found'
    const parentId = body.parentId === undefined ? existing?.parent_id : body.parentId || null
    if (!rowId && !parentId) return 'A new subsidiary must have a parent'
    if (existing?.parent_id === null && parentId) return 'The root subsidiary cannot be moved'
    if (existing?.parent_id === null && body.isActive === false) return 'The root subsidiary cannot be archived'
    if (parentId) {
      if (!UUID_RE.test(String(parentId))) return 'Invalid parent subsidiary'
      const parent = ((await executor.execute(sql`
        select id from subsidiaries
         where id = ${String(parentId)} and org_id = ${orgId} and is_active`)))
      if (!parent.rows[0]) return 'Parent subsidiary not found'
      if (rowId) {
        const cycle = ((await executor.execute(sql`
          with recursive descendants as (
            select id from subsidiaries where id = ${rowId} and org_id = ${orgId}
            union all
            select s.id from subsidiaries s join descendants d on s.parent_id = d.id
             where s.org_id = ${orgId}
          ) select 1 from descendants where id = ${String(parentId)} limit 1`)))
        if (cycle.rows.length) return 'A subsidiary cannot be parented beneath itself'
      }
    }
    if (rowId && body.isElimination !== undefined && body.isElimination !== existing.is_elimination) {
      const used = ((await executor.execute(sql`
        select 1 from journal_entries where org_id = ${orgId} and subsidiary_id = ${rowId} limit 1`)))
      if (used.rows.length) return 'Elimination status cannot change after the subsidiary has ledger activity'
    }
  }

  if (entity.key === 'intercompany-pairs') {
    const current = rowId
      ? (((await executor.execute(sql`
          select * from intercompany_pairs where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    const fromId = String(body.fromSubsidiaryId ?? current?.from_subsidiary_id ?? '')
    const toId = String(body.toSubsidiaryId ?? current?.to_subsidiary_id ?? '')
    const dueFromId = String(body.dueFromAccountId ?? current?.due_from_account_id ?? '')
    const dueToId = String(body.dueToAccountId ?? current?.due_to_account_id ?? '')
    if (fromId === toId) return 'Intercompany subsidiaries must be different'
    const subsidiaries = ((await executor.execute(sql`
      select id from subsidiaries where org_id = ${orgId} and is_active and not is_elimination
       and id = any(${`{${[fromId, toId].join(',')}}`}::uuid[])`)))
    if (subsidiaries.rows.length !== 2) return 'Choose two active, non-elimination subsidiaries'
    const accounts = ((await executor.execute(sql`
      select id, type, eliminate from accounts where org_id = ${orgId} and is_active and not is_summary
       and id = any(${`{${[dueFromId, dueToId].join(',')}}`}::uuid[])`)))
    const byId = new Map<string, { id: string; type: string; eliminate: boolean }>(
      accounts.rows.map((a: any) => [a.id as string, a]),
    )
    const dueFrom = byId.get(dueFromId)
    const dueTo = byId.get(dueToId)
    if (!dueFrom || !dueTo) return 'Choose active posting accounts from this organization'
    if (!String(dueFrom.type).startsWith('asset_')) return 'The due-from account must be an asset'
    if (!String(dueTo.type).startsWith('liability_')) return 'The due-to account must be a liability'
    if (!dueFrom.eliminate || !dueTo.eliminate) return 'Both intercompany accounts must be marked for elimination'
    const duplicate = ((await executor.execute(sql`
      select 1 from intercompany_pairs where org_id = ${orgId}
       and id is distinct from ${rowId ?? null}
       and ((from_subsidiary_id = ${fromId} and to_subsidiary_id = ${toId})
         or (from_subsidiary_id = ${toId} and to_subsidiary_id = ${fromId})) limit 1`)))
    if (duplicate.rows.length) return 'An intercompany pair already exists for these subsidiaries'
  }
  if (entity.key === 'subsidiary-ownership-interests') {
    const current = rowId
      ? (((await executor.execute(sql`select * from subsidiary_ownership_interests where id=${rowId} and org_id=${orgId}`)))).rows[0]
      : null
    const value = (key: string, column: string) => body[key] ?? current?.[column] ?? null
    const method = String(value('method', 'method') ?? 'full')
    const ownership = String(value('ownershipPercent', 'ownership_percent') ?? '')
    if (!/^(?:100(?:\.0+)?|(?:\d{1,2})(?:\.\d{1,10})?)$/.test(ownership) || ownership === '0') {
      return 'Ownership must be greater than 0% and no more than 100%'
    }
    const fullyOwned = /^100(?:\.0+)?$/.test(ownership)
    const accountRules: [string, string, (type: string) => boolean, string][] = [
      ['investmentAccountId', 'investment_account_id', (type) => type.startsWith('asset_'), 'Investment must use an asset account'],
      ['equityIncomeAccountId', 'equity_income_account_id', (type) => type.startsWith('income'), 'Equity income must use an income account'],
      ['distributionAccountId', 'distribution_account_id', (type) => type === 'equity', 'Distribution must use an equity account'],
      ['distributionIncomeAccountId', 'distribution_income_account_id', (type) => type.startsWith('income'), 'Distribution income must use an income account'],
      ['nciEquityAccountId', 'nci_equity_account_id', (type) => type === 'equity', 'NCI equity must use an equity account'],
      ['nciIncomeAccountId', 'nci_income_account_id', (type) => type.startsWith('expense'), 'NCI profit allocation must use an expense account'],
      ['goodwillAccountId', 'goodwill_account_id', (type) => type.startsWith('asset_'), 'Goodwill must use an asset account'],
      ['fairValueAdjustmentAccountId', 'fair_value_adjustment_account_id', (type) => type.startsWith('asset_'), 'Fair-value adjustment must use an asset account'],
    ]
    const ids = [...new Set(accountRules.map(([key, column]) => value(key, column)).filter(Boolean).map(String))]
    if (hasNonUuidEntry(ids)) return 'Ownership accounts must be valid accounts from this organization'
    const rows = ids.length
      ? (((await executor.execute(sql`
          select id,type from accounts where org_id=${orgId} and is_active and not is_summary
            and id=any(${uuidArrayParam(ids)}::uuid[])
        `)))).rows as { id: string; type: string }[]
      : []
    const typeById = new Map(rows.map((account) => [account.id, account.type]))
    for (const [key, column, accepts, message] of accountRules) {
      const id = value(key, column)
      if (!id) continue
      const type = typeById.get(String(id))
      if (!type || !accepts(type)) return message
    }
    if (method === 'full' && !fullyOwned && (!value('nciEquityAccountId', 'nci_equity_account_id') || !value('nciIncomeAccountId', 'nci_income_account_id'))) {
      return 'Full consolidation below 100% requires both NCI equity and NCI profit-allocation accounts'
    }
  }
  if (entity.key === 'fx-rates' || entity.key === 'consolidated-fx-rates') {
    const from = String(body.fromCurrency ?? '')
    const to = String(body.toCurrency ?? '')
    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || from === to) {
      return 'Choose two different ISO currency codes'
    }
    const currencies = ((await executor.execute(sql`
      select code from currencies where code = any(${`{${[from, to].join(',')}}`}::text[])`)))
    if (currencies.rows.length !== 2) return 'Unknown currency code'
    const rateFields = entity.key === 'fx-rates'
      ? ['rate']
      : ['currentRate', 'averageRate', 'historicalRate']
    if (rateFields.some((key) => {
      if (body[key] === undefined) return false
      const value = String(body[key]).trim()
      return !/^(?:\d+)(?:\.\d{1,10})?$/.test(value) || /^0(?:\.0+)?$/.test(value)
    })) {
      return 'Exchange rates must be greater than zero'
    }
    if (entity.key === 'consolidated-fx-rates') {
      const periodId = String(body.periodId ?? '')
      if (!rowId) {
        const period = ((await executor.execute(sql`
          select 1 from accounting_periods where id = ${periodId} and org_id = ${orgId}`)))
        if (!period.rows.length) return 'Choose an accounting period from this organization'
      }
      if (rowId && body.source !== 'manual') {
        return 'Set the source to Manual before overriding a consolidated rate'
      }
    }
  }
  if (entity.key === 'item-rate-book-assignments') {
    let values = body
    if (rowId) {
      const current = ((await executor.execute(sql`
        select rate_book_id as "rateBookId", customer_id as "customerId", project_id as "projectId",
               effective_from as "effectiveFrom", effective_to as "effectiveTo", date_basis as "dateBasis"
          from item_rate_book_assignments where id = ${rowId} and org_id = ${orgId}
      `)))
      if (!current.rows[0]) return 'Rate book assignment not found'
      values = { ...current.rows[0], ...body }
    }
    if (values.customerId && values.projectId) return 'Choose a customer or a project, not both'
    if (!['usage_date','project_start'].includes(String(values.dateBasis ?? 'usage_date'))) return 'Choose a valid schedule date'
    if (values.effectiveFrom && values.effectiveTo && String(values.effectiveTo) < String(values.effectiveFrom)) {
      return 'The end date cannot precede the start date'
    }
    const scope = values.projectId
      ? sql`project_id = ${values.projectId}`
      : values.customerId
        ? sql`customer_id = ${values.customerId}`
        : sql`project_id is null and customer_id is null`
    const refs = await executor.execute(sql`
        select
          exists(select 1 from item_rate_books where id = ${values.rateBookId} and org_id = ${orgId}) as book_ok,
          ${values.customerId ? sql`exists(select 1 from customer_roles where party_id = ${values.customerId} and org_id = ${orgId} and is_active)` : sql`true`} as customer_ok,
          ${values.projectId ? sql`exists(select 1 from projects where id = ${values.projectId} and org_id = ${orgId})` : sql`true`} as project_ok
      `)
    const overlap = await executor.execute(sql`
        select 1 from item_rate_book_assignments
         where org_id = ${orgId} and id is distinct from ${rowId ?? null} and is_active
           and ${scope}
           and daterange(effective_from, effective_to, '[]') &&
               daterange(${values.effectiveFrom ?? null}::date, ${values.effectiveTo ?? null}::date, '[]')
         limit 1
      `)
    if (!refs.rows[0]?.book_ok || !refs.rows[0]?.customer_ok || !refs.rows[0]?.project_ok) {
      return 'Choose records from this organization'
    }
    if (overlap.rows.length) return 'This scope already has an active rate book for part of that date range'
  }
  return null
}

export async function POST(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const entity = resolveEntity((await params).entity)
  if (!entity) return NextResponse.json({ error: 'unknown setup entity' }, { status: 404 })
  if (!(await setupEntityEnabled(entity, orgId))) return NextResponse.json({ error: 'unknown setup entity' }, { status: 404 })
  if (entity.readOnly) return NextResponse.json({ error: 'read-only' }, { status: 405 })

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = normalizeTaxReturnFormInput(
    entity.key,
    (parsedBody.data) as Record<string, unknown>,
  )
  const multiCurrency = await isFeatureEnabled(orgId, 'multiCurrency')
  const writableEntity = writableSetupEntity(entity, {
    multiSubsidiary: await subsidiaryFeatureEnabled(orgId),
    equipment: await isFeatureEnabled(orgId, 'equipment'),
    fieldTickets: await isFeatureEnabled(orgId, 'fieldTickets'),
  })
  // Rate-book currency is Multi-currency configuration. When that switch is
  // off the create descriptor must not require the field, so omitting it
  // can fall through to the org base instead of a 400.
  const createEntity = entity.key === 'item-rate-books' && !multiCurrency
    ? { ...writableEntity, fields: writableEntity.fields.filter((field) => field.key !== 'currency') }
    : writableEntity
  const built = buildRow(createEntity, body, { forCreate: true })
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })
  const integrityError = await validateEntityIntegrity(entity, body, orgId)
  if (integrityError) return NextResponse.json({ error: integrityError }, { status: integrityError === 'not found' ? 404 : 400 })

  if (entity.key === 'accounting-books') {
    try {
      const id = await setupWriteTransaction(entity, orgId, body, undefined, (tx) =>
        saveSetupBook(entity, orgId, actorId, body, tx))
      return NextResponse.json({ id })
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return NextResponse.json({ error: e.message }, { status: e.status })
      return NextResponse.json({ error: describeDbError(e) }, { status: 400 })
    }
  }

  if (entity.key === 'item-rate-books') {
    // Rate-book currency is Multi-currency configuration. Turning that
    // switch off must refuse a new write; omitting currency keeps the
    // org base so a book can still be created and stored books stay.
    if (body.currency !== undefined && !multiCurrency) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    try {
      const id = await setupWriteTransaction(entity, orgId, body, undefined, (tx) =>
        saveSetupBook(entity, orgId, actorId, body, tx))
      return NextResponse.json({ id })
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return NextResponse.json({ error: e.message }, { status: e.status })
      return NextResponse.json({ error: describeDbError(e) }, { status: 400 })
    }
  }

  // Natural-key uniqueness (these tables mostly lack a DB unique constraint).
  if (entity.naturalKey) {
    const col = toSnake(entity.naturalKey)
    const val = String(body[entity.naturalKey] ?? '')
    const orgFilter = entity.orgScoped ? sql` and org_id = ${orgId}` : sql``
    // Derived rules are effective-dated versions: the same code is allowed
    // again when it starts on a different date, while the storage unique key
    // still rejects two definitions beginning on the same date.
    const effectiveFilter = entity.key === 'pay-derived-rules'
      ? sql` and effective_from = ${String(body.effectiveFrom ?? '')}`
      : sql``
    const dup = ((await db.execute(sql`
      select 1 from ${sql.raw(entity.table)}
       where ${sql.raw(col)} = ${val}${orgFilter}${effectiveFilter} limit 1`)))
    if (dup.rows.length > 0) return NextResponse.json({ error: 'duplicate', code: 'duplicate' }, { status: 409 })
  }

  let cols = entity.key === 'fx-rates'
    ? built.cols.filter((column) => !['source', 'provider_config_id', 'imported_at'].includes(column.column))
    : [...built.cols]
  if (entity.key === 'fx-rates' || entity.key === 'consolidated-fx-rates') {
    try {
      cols = persistFxRateCols(cols)
    } catch (error) {
      return NextResponse.json({
        error: error instanceof CurrencyError ? error.message : 'Exchange rates must be an exact decimal',
      }, { status: 400 })
    }
  }
  if (entity.key === 'fx-rates') cols.push({ column: 'source', value: 'manual' })
  if (entity.orgScoped) cols.push({ column: 'org_id', value: orgId })
  if (entity.actorCols) {
    cols.push({ column: 'created_by', value: actorId })
    cols.push({ column: 'updated_by', value: actorId })
  }

  const colSql = sql.raw(cols.map((c) => c.column).join(', '))
  const valSql = sql.join(
    cols.map((c) => sql`${c.value}`),
    sql`, `,
  )

  if (entity.key === 'pay-derived-rules') {
    // A direct create of a later active version follows the same timeline rule
    // as an edit: close the currently-effective active row before inserting the
    // successor, and keep both operations plus their evidence atomic.
    try {
      const newId = await setupWriteTransaction(entity, orgId, body, undefined, async (tx) => {
        const effectiveFrom = String(body.effectiveFrom)
        const prior = coerceBoolean(body.isActive)
          ? ((await tx.execute(sql`
              select * from pay_derived_rules
               where org_id = ${orgId} and code = ${String(body.code)}
                 and is_active
                 and effective_from < ${effectiveFrom}::date
                 and (effective_to is null or effective_to >= ${effectiveFrom}::date)
               for update`)))
          : { rows: [] as { id: string }[] }
        for (const row of prior.rows) {
          const closed = ((await tx.execute(sql`
            update pay_derived_rules
               set effective_to = (${effectiveFrom}::date - 1),
                   updated_at = now(), updated_by = ${actorId}
             where id = ${String(row.id)} and org_id = ${orgId}
            returning *`)))
          await audit({
            orgId,
            table: entity.table,
            rowId: String(row.id),
            action: 'update',
            changes: { before: row, after: closed.rows[0] },
            actorId,
          }, tx)
        }
        const inserted = ((await tx.execute(sql`
          insert into ${sql.raw(entity.table)} (${colSql}) values (${valSql})
          returning ${sql.raw(idColumn(entity))} as id`)))
        const id = String(inserted.rows[0]?.id)
        await audit({
          orgId: entity.orgScoped ? orgId : null,
          table: entity.table,
          rowId: id,
          action: 'insert',
          changes: { after: await loadSetupAuditRow(entity, orgId, id, tx) },
          actorId,
        }, tx)
        return id
      })
      return NextResponse.json({ id: newId })
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return NextResponse.json({ error: e.message }, { status: e.status })
      if (pgErrorCode(e) === '23505' || pgErrorCode(e) === '23P01') {
        return NextResponse.json({ error: 'duplicate', code: 'duplicate' }, { status: 409 })
      }
      return NextResponse.json({ error: describeDbError(e) }, { status: 400 })
    }
  }

  try {
    const newId = await setupWriteTransaction(entity, orgId, body, undefined, async (tx) => {
      const inserted = ((await tx.execute(sql`
        insert into ${sql.raw(entity.table)} (${colSql}) values (${valSql})
        returning ${sql.raw(idColumn(entity))} as id`)))
      const id = String(inserted.rows[0]?.id)
      const members = multirefField(entity)
      if (members && Array.isArray(body[members.key])) {
        await syncMembers(orgId, id, (body[members.key] as unknown[]).map(String), tx)
      }
      await audit({
        orgId: entity.orgScoped ? orgId : null,
        table: entity.table,
        rowId: id,
        action: 'insert',
        changes: { after: await loadSetupAuditRow(entity, orgId, id, tx) },
        actorId,
      }, tx)
      return id
    })
    return NextResponse.json({ id: newId })
  } catch (e) {
    if (e instanceof SetupWriteRefusal) return NextResponse.json({ error: e.message }, { status: e.status })
    // The natural-key preflight above is an autocommit read, so two concurrent
    // creates can both pass it; the storage UNIQUE constraint is the authority
    // and surfaces here as a deterministic 409, with no partial row or audit
    // (the insert and its audit share one transaction).
    if (pgErrorCode(e) === '23505') {
      return NextResponse.json({ error: 'duplicate', code: 'duplicate' }, { status: 409 })
    }
    return NextResponse.json({ error: describeDbError(e) }, { status: 400 })
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const entity = resolveEntity((await params).entity)
  if (!entity) return NextResponse.json({ error: 'unknown setup entity' }, { status: 404 })
  if (!(await setupEntityEnabled(entity, orgId))) return NextResponse.json({ error: 'unknown setup entity' }, { status: 404 })
  if (entity.readOnly) return NextResponse.json({ error: 'read-only' }, { status: 405 })

  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = normalizeTaxReturnFormInput(
    entity.key,
    (parsedBody2.data) as Record<string, unknown>,
  )
  const id = String(body.id ?? '')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const multiCurrency = await isFeatureEnabled(orgId, 'multiCurrency')
  const writableEntity = writableSetupEntity(entity, {
    multiSubsidiary: await subsidiaryFeatureEnabled(orgId),
    equipment: await isFeatureEnabled(orgId, 'equipment'),
    fieldTickets: await isFeatureEnabled(orgId, 'fieldTickets'),
  })
  // Rate-book currency is Multi-currency configuration. When that switch is
  // off the update descriptor must not require the field, so omitting it
  // keeps the stored book instead of a 400.
  const patchEntity = entity.key === 'item-rate-books' && !multiCurrency
    ? { ...writableEntity, fields: writableEntity.fields.filter((field) => field.key !== 'currency') }
    : writableEntity
  const built = buildRow(patchEntity, body, { forCreate: false })
  if ('error' in built) return NextResponse.json({ error: built.error }, { status: 400 })
  const integrityError = await validateEntityIntegrity(entity, body, orgId, id)
  if (integrityError) return NextResponse.json({ error: integrityError }, { status: integrityError === 'not found' ? 404 : 400 })

  if (entity.key === 'accounting-books') {
    try {
      await setupWriteTransaction(entity, orgId, body, id, (tx) =>
        saveSetupBook(entity, orgId, actorId, body, tx, { id }))
      return NextResponse.json({ id })
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return NextResponse.json({ error: e.message }, { status: e.status })
      const message = (e as Error).message
      const error = message === 'primary-required' || message === 'primary-active-required' || message === 'not found'
        ? message
        : describeDbError(e)
      return NextResponse.json({ error }, { status: error === 'not found' ? 404 : 400 })
    }
  }

  if (entity.key === 'item-rate-books') {
    // Rate-book currency is Multi-currency configuration. Turning that
    // switch off must refuse a write; omitting currency keeps the
    // stored book.
    if (body.currency !== undefined && !multiCurrency) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
    try {
      await setupWriteTransaction(entity, orgId, body, id, (tx) =>
        saveSetupBook(entity, orgId, actorId, body, tx, { id }))
      return NextResponse.json({ id })
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return NextResponse.json({ error: e.message }, { status: e.status })
      const message = (e as Error).message
      const error = ['not found', 'default-required'].includes(message) ? message : describeDbError(e)
      return NextResponse.json({ error }, { status: error === 'not found' ? 404 : 400 })
    }
  }

  if (entity.key === 'pay-derived-rules') {
    // A rule is a policy snapshot. Once its effective window has been used by
    // payroll, changing its pricing/filter columns would restate that period.
    // Close the previous window and insert a successor instead. Activation and
    // a deliberate window close remain in-place operations; they do not alter
    // the policy that historical periods resolve.
    const policyColumns = [
      'name', 'component_id', 'trigger', 'time_type_id', 'project_id',
      'department_id', 'equipment_unit_id', 'item_id', 'trade_id', 'job_title',
      'billable_only', 'included_job_titles', 'excluded_job_titles',
      'quantity_mode', 'rate_mode', 'rate_value', 'costing_mode',
      'effective_from', 'sequence',
    ]
    const builtByColumn = new Map(built.cols.map((column) => [column.column, column.value]))
    try {
      const versionId = await setupWriteTransaction(entity, orgId, body, id, async (tx) => {
        const currentRes = ((await tx.execute(sql`
          select * from pay_derived_rules
           where id = ${id} and org_id = ${orgId}
           for update`)))
        const current = currentRes.rows[0] as Record<string, unknown> | undefined
        if (!current) throw new Error('not found')

        const valueFor = (column: string) => builtByColumn.has(column)
          ? builtByColumn.get(column)
          : current[column]
        const changedPolicy = policyColumns.some((column) =>
          comparableSetupValue(valueFor(column)) !== comparableSetupValue(current[column]))

        if (!changedPolicy) {
          const updated = ((await tx.execute(sql`
            update pay_derived_rules set
              ${sql.join(built.cols.map(column => sql`${sql.raw(column.column)} = ${column.value}`), sql`, `)},
              updated_at = now(), updated_by = ${actorId}
             where id = ${id} and org_id = ${orgId}
            returning id`)))
          if (!updated.rows.length) throw new Error('not found')
          await audit({
            orgId,
            table: entity.table,
            rowId: id,
            action: 'update',
            changes: { before: current, after: await loadSetupAuditRow(entity, orgId, id, tx) },
            actorId,
          }, tx)
          return id
        }

        const effectiveFrom = String(valueFor('effective_from') ?? '')
        const priorEffectiveFrom = String(current.effective_from ?? '')
        if (!effectiveFrom || effectiveFrom <= priorEffectiveFrom) {
          throw new Error('effective-from-must-follow-current')
        }
        const effectiveTo = valueFor('effective_to')
        if (effectiveTo != null && String(effectiveTo) < effectiveFrom) {
          throw new Error('effective-to-before-effective-from')
        }

        // If the old row is open (or reaches into the successor's start), its
        // inclusive range ends the day before the new version begins. A lapsed
        // row is left untouched so its original historical window remains an
        // exact record of what was configured.
        const priorEffectiveTo = current.effective_to == null ? null : String(current.effective_to)
        const closesPrior = priorEffectiveTo == null || priorEffectiveTo >= effectiveFrom
        if (closesPrior) {
          await tx.execute(sql`
            update pay_derived_rules
               set effective_to = (${effectiveFrom}::date - 1),
                   updated_at = now(), updated_by = ${actorId}
             where id = ${id} and org_id = ${orgId}
          `)
        }

        const successorColumns = [
          'org_id', 'code', ...policyColumns.slice(0, policyColumns.indexOf('effective_from')),
          'effective_from', 'effective_to', 'sequence', 'is_active', 'created_by', 'updated_by',
        ]
        const successorValues = successorColumns.map((column) => {
          if (column === 'org_id') return sql`${orgId}`
          if (column === 'code') return sql`${String(current.code)}`
          if (column === 'effective_to') return sql`${effectiveTo ?? null}`
          if (column === 'created_by' || column === 'updated_by') return sql`${actorId}`
          if (column === 'is_active') return sql`${valueFor('is_active')}`
          return sql`${valueFor(column) ?? null}`
        })
        const inserted = ((await tx.execute(sql`
          insert into pay_derived_rules (${sql.raw(successorColumns.join(', '))})
          values (${sql.join(successorValues, sql`, `)})
          returning id`)))
        const successorId = String(inserted.rows[0]?.id)

        if (closesPrior) {
          await audit({
            orgId,
            table: entity.table,
            rowId: id,
            action: 'update',
            changes: { before: current, after: await loadSetupAuditRow(entity, orgId, id, tx) },
            actorId,
          }, tx)
        }
        await audit({
          orgId,
          table: entity.table,
          rowId: successorId,
          action: 'insert',
          changes: { after: await loadSetupAuditRow(entity, orgId, successorId, tx) },
          actorId,
        }, tx)
        return successorId
      })
      return NextResponse.json({ id: versionId })
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return NextResponse.json({ error: e.message }, { status: e.status })
      const code = pgErrorCode(e)
      if (code === '23505' || code === '23P01') {
        return NextResponse.json({ error: 'duplicate', code: 'duplicate' }, { status: 409 })
      }
      const message = (e as Error).message
      if (message === 'not found') return NextResponse.json({ error: message }, { status: 404 })
      if (message === 'effective-from-must-follow-current') {
        return NextResponse.json({ error: 'A changed derived rule must start after its current effective date' }, { status: 400 })
      }
      if (message === 'effective-to-before-effective-from') {
        return NextResponse.json({ error: 'effectiveTo cannot precede effectiveFrom' }, { status: 400 })
      }
      return NextResponse.json({ error: describeDbError(e) }, { status: 400 })
    }
  }

  let updateCols = entity.key === 'fx-rates'
    ? built.cols.filter((column) => !['source', 'provider_config_id', 'imported_at'].includes(column.column))
    : built.cols
  if (entity.key === 'fx-rates' || entity.key === 'consolidated-fx-rates') {
    try {
      updateCols = persistFxRateCols(updateCols)
    } catch (error) {
      return NextResponse.json({
        error: error instanceof CurrencyError ? error.message : 'Exchange rates must be an exact decimal',
      }, { status: 400 })
    }
  }
  const setParts = updateCols.map((c) => sql`${sql.raw(c.column)} = ${c.value}`)
  if (entity.key === 'fx-rates') {
    // Any human edit is an explicit override. Provider synchronization never
    // replaces manual rows, so detach the imported provenance atomically.
    setParts.push(sql`source = 'manual'`)
    setParts.push(sql`provider_config_id = null`)
    setParts.push(sql`imported_at = null`)
  }
  if (entity.actorCols) {
    setParts.push(sql`updated_by = ${actorId}`)
    setParts.push(sql`updated_at = now()`)
  }
  if (setParts.length === 0) return NextResponse.json({ error: 'nothing to update' }, { status: 400 })

  const orgFilter = entity.orgScoped ? sql` and org_id = ${orgId}` : sql``
  try {
    const found = await setupWriteTransaction(entity, orgId, body, id, async (tx) => {
      const before = await loadSetupAuditRow(entity, orgId, id, tx, true)
      if (!before) return false
      const updated = ((await tx.execute(sql`
        update ${sql.raw(entity.table)} set ${sql.join(setParts, sql`, `)}
         where ${sql.raw(idColumn(entity))} = ${id}${orgFilter}
        returning ${sql.raw(idColumn(entity))} as id`)))
      if (updated.rows.length === 0) return false
      const members = multirefField(entity)
      if (members && Array.isArray(body[members.key])) {
        await syncMembers(orgId, id, (body[members.key] as unknown[]).map(String), tx)
      }
      const after = await loadSetupAuditRow(entity, orgId, id, tx)
      await audit({
        orgId: entity.orgScoped ? orgId : null,
        table: entity.table,
        rowId: id,
        action: 'update',
        changes: { before, after },
        actorId,
      }, tx)
      return true
    })
    if (!found) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ id })
  } catch (e) {
    if (e instanceof SetupWriteRefusal) return NextResponse.json({ error: e.message }, { status: e.status })
    const databaseError = e as { constraint?: string; cause?: { constraint?: string; message?: string }; message?: string }
    if ((databaseError.cause?.constraint ?? databaseError.constraint) === 'asset_category_posted_policy') {
      return NextResponse.json({ error: databaseError.cause?.message ?? databaseError.message }, { status: 409 })
    }
    // Same storage-authority mapping as POST: an edit that moves a row onto an
    // occupied natural key (codes are editable on several entities) is a
    // duplicate conflict, not a generic save failure.
    if (pgErrorCode(e) === '23505') {
      return NextResponse.json({ error: 'duplicate', code: 'duplicate' }, { status: 409 })
    }
    return NextResponse.json({ error: describeDbError(e) }, { status: 400 })
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const entity = resolveEntity((await params).entity)
  if (!entity) return NextResponse.json({ error: 'unknown setup entity' }, { status: 404 })
  if (!(await setupEntityEnabled(entity, orgId))) return NextResponse.json({ error: 'unknown setup entity' }, { status: 404 })
  if (entity.readOnly) return NextResponse.json({ error: 'read-only' }, { status: 405 })
  if (entity.key === 'accounting-books') {
    return NextResponse.json({ error: 'archive-only' }, { status: 405 })
  }

  const url = new URL(req.url)
  const id = url.searchParams.get('id') ?? ''
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const orgFilter = entity.orgScoped ? sql` and org_id = ${orgId}` : sql``
  try {
    const found = await setupWriteTransaction(entity, orgId, undefined, id, async (tx) => {
      if (entity.key === 'item-rate-books') {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`item-rate-books:${orgId}`}, 0))`)
      }
      const before = await loadSetupAuditRow(entity, orgId, id, tx, true)
      if (!before) return false
      if (entity.key === 'item-rate-books' && before.is_default) throw new Error('default-required')
      // Memberships belong to this group. External references still refuse the
      // parent deletion and roll these removals back with the audit transaction.
      if (entity.key === 'tax-groups') await syncMembers(orgId, id, [], tx)
      const deleted = ((await tx.execute(sql`
        delete from ${sql.raw(entity.table)}
         where ${sql.raw(idColumn(entity))} = ${id}${orgFilter}
        returning ${sql.raw(idColumn(entity))} as id`)))
      if (deleted.rows.length === 0) return false
      // The audit is part of the delete transaction. If audit_log rejects the
      // event, the setup row must roll back with it rather than disappearing
      // without evidence.
      await audit({
        orgId: entity.orgScoped ? orgId : null,
        table: entity.table,
        rowId: id,
        action: 'delete',
        changes: { before },
        actorId,
      }, tx)
      return true
    })
    if (!found) return NextResponse.json({ error: 'not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    if (e instanceof SetupWriteRefusal) return NextResponse.json({ error: e.message }, { status: e.status })
    if (e instanceof Error && e.message === 'default-required') {
      return NextResponse.json({ error: 'default-required' }, { status: 409 })
    }
    // Foreign-key violation → the record is referenced elsewhere.
    if (pgErrorCode(e) === '23503') {
      return NextResponse.json({ error: 'in-use', code: 'in-use' }, { status: 409 })
    }
    return NextResponse.json({ error: describeDbError(e) }, { status: 400 })
  }
}
