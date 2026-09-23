import 'server-only'
import { randomUUID } from 'node:crypto'
import { uuidId } from '../api/json'
import { claimSetupCreate, SetupCreateConflict } from '../api/idempotency'
import { isUuid } from '../list-params'
import { saveExtensionSettingRow } from './extension-settings'
import { createHomeAnnouncementRow, deleteHomeAnnouncementRow, saveHomeAnnouncementRow } from './home-announcements'
import { sql } from 'drizzle-orm'
import { CurrencyError, updateFxRate } from '@openbooks/engine/src/fx/currencies.ts'
import { db, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { toUnits } from '@openbooks/engine/src/money/money.ts'
import { compileFormula } from '@openbooks/engine/src/assets/depreciation-formula.ts'
import { filingAccountProblem } from '@openbooks/engine/src/payroll/filing-registry.ts'
import { payPeriodsPerYearProblem, semiMonthlyAnchorProblem } from "@openbooks/engine/src/payroll/run-calendar.ts";
import { payScheduleSubsidiaryProblem, rescopePayScheduleRuns } from "@openbooks/engine/src/payroll/run-lifecycle.ts";
import { payComponentTreatmentProblem } from '@openbooks/engine/src/payroll/treatment-bases.ts'
import { recognitionRulePolicyProblem } from '@openbooks/engine/src/revenue/recognition-limits.ts'
import { parseRatingScale, PerformanceMathError } from '@openbooks/engine/src/hrm/performance/performance-math.ts'
// HR-18 begin: recruiting-depth Setup validation runs through the engine
// owners of each shape (one implementation, two callers).
import { CANONICAL_RATING_KEYS } from '@openbooks/engine/src/hrm/recruiting/kits.ts'
import { RecruitingError } from '@openbooks/engine/src/hrm/recruiting/errors.ts'
import { parseClauses } from '@openbooks/engine/src/hrm/recruiting/offers-signing.ts'
import { validateAvailabilityWindows } from '@openbooks/engine/src/hrm/recruiting/scheduling.ts'
// HR-18 end
import { SETUP_ENTITY_BY_KEY, setupEntityForFeatureState, toSnake, type SetupEntity } from './registry'
import {
  buildRow,
  coerceBoolean,
  describeDbError,
  idColumn,
  multirefField,
  pgErrorCode,
  taxRatePercentProblem,
  UUID_RE,
} from './coerce'
import { normalizeHrmProcessTemplateInput } from './hrm-process-template'
import { normalizeHrmPipelineStageInput } from './hrm-pipeline'
import { normalizeHrmReviewTemplateInput } from './hrm-review-template'
import { normalizeHrmCompensationInput } from './hrm-compensation'
import { validateCategoryKey } from '@openbooks/engine/src/hrm/documents/categories.ts'
import { validateTemplateInput } from '@openbooks/engine/src/hrm/documents/templates.ts'
import { benefitPlanShapeProblem, normalizeHrmBenefitPlanInput } from './hrm-benefits'
import { leavePolicyRuleProblem, normalizeHrmLeavePolicyInput } from './hrm-leave-policy'
import { mergeTemplateSlots, normalizeHrmDocumentTemplateInput } from './hrm-document-template'
import { applyRuleSlotColumns } from './hrm-rule-slots'
import { normalizeTaxReturnFormInput } from './tax-return-form'
import { saveSetupBook } from './books'
import { auditSetupChange as audit, loadSetupAuditRow } from './audit'
import { featureEnabled, featureGateLockKey, isFeatureEnabled, resolvedFeatureState, subsidiaryFeatureEnabled } from '../features'
import { loadNumberSequenceKindOptions } from './number-sequence-kinds'


/**
 * Generic CRUD for every configuration entity in the Setup registry
 * (web/lib/setup/registry.ts) — the command layer behind
 * /api/admin/setup/[entity] AND the assistant/MCP setup-record tools, so
 * every surface shares column whitelisting, validation, the feature fence,
 * specialised per-entity rules, and audit evidence.
 *
 * SECURITY: table and column identifiers are taken ONLY from the registry
 * (never from the request body) and interpolated with sql.raw; every value is a
 * bound parameter. The request body cannot introduce a column name. Callers
 * must already hold admin.setup.manage — the route and the tool gate both
 * check it before reaching here.
 */

/** The acting admin: org, user id (stamped on rows + audit), and permissions
 *  (extension settings scope themselves by permission). */
export type SetupActor = { orgId: string; id: string; permissions: Iterable<string> }

/** Transport-neutral outcome: the HTTP status the route answers with and the
 *  JSON body. Adapters map it onto their wire. */
export type SetupWriteResult = { status: number; body: Record<string, unknown> }

export { resolveEntity as resolveSetupEntity }


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


class SetupWriteRefusal extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}
type SetupTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** Recheck authoritative entity and field gates on the same transaction/connection
 * that writes configuration. Take this fence before any row or book locks. */
async function setupWriteTransaction<T>(
  entity: SetupEntity, orgId: string, body: Record<string, unknown> | undefined,
  rowId: string | undefined, write: (tx: SetupTransaction) => Promise<T>,
  options: { idempotencyKey?: string } = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    // Same-key retries serialize here, before any create effect: the second
    // claimant blocks until the first commits, then replays off its audit.
    if (options.idempotencyKey) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'setup-create:' + options.idempotencyKey}, 0))`)
    }
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

/**
 * The entity a write is validated against, WITH its dynamic options resolved.
 *
 * `resolveDynamicSetupOptions` is the same resolution the render path applies
 * before handing the descriptor to the client, and the write path must use it
 * too or the two disagree about what a field accepts. They did: a field may
 * declare BOTH a static `options` list and a dynamic `optionsSource`, the
 * static list being (per dynamic-options.ts) "the fallback for any surface
 * that renders without resolving". The picker resolved and offered all
 * fourteen declared payroll countries; `coerceField`'s `select` check never
 * resolved and validated against the fallback, which is still the CA/US pair
 * from before the registry opened. So creating a German filing account sent a
 * correct `country: "DE"` and got 400 "country has an invalid value" — the
 * server refusing a code its own picker had offered. `programType` had the
 * same split (ca_rp/us_ein/us_state_sui statically, every declared pack's
 * program types dynamically).
 *
 * Resolving here means one source of truth for what a field accepts, so a
 * newly registered pack's countries and program types become writable with no
 * registry edit — which was the stated intent of `optionsSource` all along.
 */
function resolveEntity(entityKey: string): SetupEntity | null {
  return SETUP_ENTITY_BY_KEY.get(entityKey) ?? null
}

/**
 * The entity to VALIDATE a write against: the same descriptor, with its dynamic
 * options resolved.
 *
 * A field may declare BOTH a static `options` list and a dynamic
 * `optionsSource`, the static list being (per dynamic-options.ts) "the fallback
 * for any surface that renders without resolving". The RENDER path resolves and
 * offered all fourteen declared payroll countries; the write path did not, so
 * `coerceField`'s `select` check validated against the fallback — still the
 * CA/US pair from before the pack registry opened. Creating a German filing
 * account sent a correct `country: "DE"` and got 400 "country has an invalid
 * value": the server refusing a code its own picker had offered.
 *
 * Imported DYNAMICALLY and called LATE, after the read-only and permission
 * guards, for two reasons: dynamic-options is server-only and reaches into the
 * engine's pack registry, and a read-only entity must fail closed WITHOUT
 * loading it (web/lib/setup-route.test.ts pins that a currency mutation
 * answers 405 with zero database calls — a top-level import breaks it).
 */
async function entityForValidation(entity: SetupEntity): Promise<SetupEntity> {
  if (!hasDynamicOptions(entity)) return entity
  const { resolveDynamicSetupOptions } = await import('./dynamic-options')
  return resolveDynamicSetupOptions(entity)
}

/** Cheap, pure check so the dynamic import happens only where it is needed. */
function hasDynamicOptions(entity: SetupEntity): boolean {
  return (entity.fields ?? []).some((field) => field.optionsSource != null)
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
  // Pay schedules keep their subsidiary control coercible even while the
  // feature is off. `validateEntityIntegrity` governs that entity through
  // the dedicated engine rule, which validates the submitted id against the
  // org — and the onboarding wizard names the sole subsidiary on a
  // single-entity tenant. Dropping the field here would silently persist the
  // root default instead of the validated choice (and an unscoped row in a
  // tenant that later grows a second entity).
  const scoped = entity.key === 'pay-schedules' && !features.multiSubsidiary
    ? { ...next, fields: [...next.fields, ...entity.fields.filter((field) => field.ref === 'subsidiaries')] }
    : next
  if (features.equipment) return scoped
  const trigger = entity.fields.find((field) => field.key === 'trigger')
  if (!trigger?.options?.some((option) => option.value === 'equipment_charge')) return scoped
  return {
    ...scoped,
    fields: scoped.fields.map((field) => (
      field.key === 'trigger' ? { ...field, options: trigger.options } : field
    )),
  }
}

// HR-18 begin: create-time defaults for recruiting-depth Setup. A kit
// created without a declared scale rates on the full canonical scale —
// defaulted here (before coercion), because the generic stringArray
// coercion would otherwise store an empty list the storage CHECK refuses
// without naming the field. Present-but-empty stays empty so the
// integrity check below can refuse it by name.
function foldRecruitingSetupCreate(
  entityKey: string,
  rawBody: Record<string, unknown>,
): Record<string, unknown> {
  if (entityKey === 'hrm-interview-kits' && rawBody.ratingScale === undefined) {
    return { ...rawBody, ratingScale: [...CANONICAL_RATING_KEYS] }
  }
  return rawBody
}
// HR-18 end

/** Domain checks that cannot be expressed by the generic field coercer. */
export async function validateEntityIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  rowId?: string,
  executor: SqlExecutor = db,
): Promise<string | null> {
  // `pay-schedules` is exempt from the generic feature fence: its dedicated
  // rule below (`payScheduleSubsidiaryProblem`) is the complete subsidiary
  // check for that entity — a valid subsidiary id is always accepted, an
  // absent one refused only in a multi-entity org. Firing the fence first
  // would refuse the onboarding wizard's single-entity default, which names
  // the org's sole subsidiary while the fence is closed.
  const submittedSubsidiaryScope = entity.key !== 'pay-schedules'
    && entity.fields
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
    // (engine/src/tax/tax.ts): a rate is a nonnegative exact decimal with at most
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
    // A blank is not a choice: the drawer sends '' for untouched inputs and
    // the coerce layer drops those blanks onto the default (F-t06-022), so
    // the integrity read must fall back the same way instead of refusing a
    // raw blank (F-t10-001: '' reached toUnits as a refusal key).
    const present = (camel: string, snake: string, fallback: unknown) => {
      const submitted = body[camel]
      if (submitted === undefined || submitted === null || String(submitted).trim() === '') {
        return current?.[snake] ?? fallback
      }
      return submitted
    }
    const calculationType = String(present('calculationType', 'calculation_type', 'standard'))
    const appliesTo = String(present('appliesTo', 'applies_to', 'both'))
    const inclusive = coerceBoolean(value('priceIncludesTax', 'price_includes_tax', false))
    const roundingScale = Number(present('roundingScale', 'rounding_scale', 2))
    if (!['standard', 'withholding', 'reverse_charge'].includes(calculationType)) return 'invalid-tax-calculation-type'
    if (inclusive && calculationType !== 'standard') return 'inclusive-standard-only'
    if (!Number.isInteger(roundingScale) || roundingScale < 0 || roundingScale > 4) return 'invalid-tax-rounding-scale'
    try {
      const recovery = toUnits(String(present('recoverablePercent', 'recoverable_percent', '100')))
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
  if (entity.key === 'recognition-rules') {
    // One exact contract with the recognition engine (engine/src/revenue):
    // periods, offsets, or an up-front percent outside the builder's domain
    // save "successfully" and fail every later invoice attach or posting.
    // Refuse at save, by field name, with no row change. A blank is not a
    // choice (the drawer sends '' for untouched keepDefault inputs), so the
    // merged stored value is validated, never the raw blank.
    const current = rowId
      ? (((await executor.execute(sql`
          select recognition_periods, period_offset, start_offset_days,
                 initial_amount_percent::text as initial_amount_percent
            from recognition_rules where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    if (rowId && !current) return 'not found'
    const value = (camel: string, snake: string) => {
      const submitted = body[camel]
      if (submitted === undefined || submitted === null || String(submitted).trim() === '') {
        return current?.[snake] ?? null
      }
      return submitted
    }
    return recognitionRulePolicyProblem({
      recognitionPeriods: value('recognitionPeriods', 'recognition_periods'),
      periodOffset: value('periodOffset', 'period_offset'),
      startOffsetDays: value('startOffsetDays', 'start_offset_days'),
      initialAmountPercent: value('initialAmountPercent', 'initial_amount_percent'),
    })
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
    // the declaration (engine/src/payroll/filing-registry.ts) is asked here,
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
  if (entity.key === 'pay-components') {
    // The pack's declared pre-tax treatments are the constraint that used
    // to be the pay_components_tax_treatment DB CHECK. A CHECK cannot
    // enumerate an open pack vocabulary (every permitted value was
    // Canadian), so the declaration (engine/src/payroll/treatment-bases.ts,
    // over each pack's deductionTreatments) is asked here, at the API
    // boundary, for creates and edits alike — and the refusal names the
    // treatments the scope declares rather than surfacing a constraint name.
    const currentComponent = rowId
      ? (((await executor.execute(sql`
          select country, tax_treatment from pay_components
           where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    if (rowId && !currentComponent) return 'not found'
    const componentCountry = body.country !== undefined
      ? (body.country ? String(body.country) : null)
      : ((currentComponent?.country as string | null) ?? null)
    const componentTreatment = body.taxTreatment !== undefined
      ? (body.taxTreatment ? String(body.taxTreatment) : null)
      : ((currentComponent?.tax_treatment as string | null) ?? null)
    const treatmentProblem = payComponentTreatmentProblem({
      country: componentCountry,
      taxTreatment: componentTreatment,
    })
    if (treatmentProblem) return treatmentProblem
  }
  if (entity.key === 'pay-schedules') {
    // `anchor_period_end` is a REQUIRED field the engine derives every period
    // boundary from, semi-monthly included: the anchor's day-of-month names one
    // of the month's two period ends and its half-month complement names the
    // other (engine/src/payroll/run.ts, `semiMonthlyBoundaries`). Two anchor
    // shapes do not determine a calendar — the 14th, whose complement is a day
    // February does not always have, and the last day of a 28-day February,
    // which is simultaneously "the 28th" and "the month end". Both are refused
    // HERE, by name, rather than quietly reinterpreted: a schedule that saves
    // and then pays on days the employer did not choose misaligns every pay
    // date, the periods-per-year assumption the statutory engines annualize
    // with, and the period-overlap guard.
    const current = rowId
      ? (((await executor.execute(sql`
          select frequency, periods_per_year, anchor_period_end::text as anchor_period_end,
                 subsidiary_id::text as subsidiary_id
            from pay_schedules
           where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    if (rowId && !current) return 'not found'
    // A schedule with no subsidiary pays from the root entity. In a tenant
    // running more than one legal entity that silence mints runs frozen to
    // the wrong paying entity and currency — so the engine refuses it here,
    // on create and on re-scoping back to none alike, before anything is
    // written. Single-entity tenants keep the root default without asking.
    const effectiveScheduleSubsidiary = body.subsidiaryId !== undefined
      ? (body.subsidiaryId ? String(body.subsidiaryId) : null)
      : ((current?.subsidiary_id as string | null) ?? null)
    const scheduleSubsidiaryProblem = await payScheduleSubsidiaryProblem(
      orgId, effectiveScheduleSubsidiary, executor,
    )
    if (scheduleSubsidiaryProblem) return scheduleSubsidiaryProblem
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
      ? ((await executor.execute<{ id: string; parent_id: string | null; is_active: boolean; is_elimination: boolean }>(sql`
          select id, parent_id, is_active, is_elimination from subsidiaries
           where id = ${rowId} and org_id = ${orgId}`))).rows[0] ?? null
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
    if (rowId && body.isElimination !== undefined && body.isElimination !== existing?.is_elimination) {
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
    const accounts = ((await executor.execute<{ id: string; type: string; eliminate: boolean }>(sql`
      select id, type, eliminate from accounts where org_id = ${orgId} and is_active and not is_summary
       and id = any(${`{${[dueFromId, dueToId].join(',')}}`}::uuid[])`)))
    const byId = new Map<string, { id: string; type: string; eliminate: boolean }>(
      accounts.rows.map((a): [string, { id: string; type: string; eliminate: boolean }] => [a.id, a]),
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
  if (entity.key === 'payment-cards') {
    // A card is a posting instrument: its holder must be an employee of this
    // org and its liability account a postable liability (0171). Without this
    // fence a card could point at another tenant's party or at an expense
    // account, and the failure would surface only at posting time.
    const current = rowId
      ? (((await executor.execute(sql`
          select * from payment_cards where id = ${rowId} and org_id = ${orgId}`)))).rows[0]
      : null
    const holderId = String(body.holderPartyId ?? current?.holder_party_id ?? '')
    const liabilityId = String(body.liabilityAccountId ?? current?.liability_account_id ?? '')
    const holder = holderId && UUID_RE.test(holderId)
      ? ((await executor.execute(sql`
          select p.id from parties p
           join employee_roles e on e.party_id = p.id and e.org_id = p.org_id and e.is_active
          where p.id = ${holderId} and p.org_id = ${orgId} and p.is_active`)))
      : null
    if (!holder?.rows.length) return 'Choose an active employee of this organization as the cardholder'
    const liability = liabilityId && UUID_RE.test(liabilityId)
      ? ((await executor.execute(sql`
          select id, type from accounts
           where id = ${liabilityId} and org_id = ${orgId} and is_active and not is_summary`)))
      : null
    const liabilityRow = (liability?.rows as { id: string; type: string }[] | undefined)?.[0]
    if (!liabilityRow) return 'Choose an active posting account from this organization as the card liability'
    if (!String(liabilityRow.type).startsWith('liability_')) return 'The card liability must be a liability account'
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
    // The ownership_interest_guard trigger refuses full-method rows without
    // these legs (F-t06-022): preflight it here so the refusal is a typed
    // user-language 400 naming the missing accounts, never the trigger's
    // raw SQL INSERT echoing through describeDbError.
    if (method === 'full' && (!value('goodwillAccountId', 'goodwill_account_id') || !value('fairValueAdjustmentAccountId', 'fair_value_adjustment_account_id'))) {
      return 'Full consolidation requires goodwill and fair-value adjustment accounts'
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
  // HRM process templates (0193): prove the applies_to filter targets are
  // visible in this org — a template that can never apply is refused by
  // field name instead of saved as applicable. The body arrives normalized
  // (slot fields folded into appliesTo); a direct appliesTo object from
  // API callers is accepted as-is.
  if (entity.key === 'hrm-process-templates') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select applies_to as "appliesTo" from hrm_process_templates where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Process template not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    const raw = values.appliesTo
    const parsed: { employer_subsidiary_id?: unknown; department_id?: unknown } =
      raw === undefined || raw === null
        ? {}
        : typeof raw === 'string'
          ? (() => { try { return JSON.parse(raw) as Record<string, unknown> } catch { return { __bad: true } } })()
          : (raw as Record<string, unknown>)
    if ((parsed as Record<string, unknown>).__bad !== undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'The applies-to filter must be a JSON object'
    }
    const subsidiary = (parsed.employer_subsidiary_id ?? null) as string | null
    const department = (parsed.department_id ?? null) as string | null
    const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
    if ((subsidiary !== null && !uuid.test(subsidiary)) || (department !== null && !uuid.test(department))) {
      return 'The applies-to subsidiary and department must be ids, or null for all'
    }
    const refs = await executor.execute(sql`
      select
        ${subsidiary ? sql`exists(select 1 from subsidiaries where id = ${subsidiary} and org_id = ${orgId})` : sql`true`} as subsidiary_ok,
        ${department ? sql`exists(select 1 from departments where id = ${department} and org_id = ${orgId})` : sql`true`} as department_ok
    `)
    if (!refs.rows[0]?.subsidiary_ok) return 'The applies-to subsidiary is not visible in this organization'
    if (!refs.rows[0]?.department_ok) return 'The applies-to department is not visible in this organization'
  }
  // HRM leave policies (0194): the rule shapes are refused with the engine's
  // own words before the write, and the applies_to targets must be visible
  // in this org — a policy that can never apply is refused by field name.
  if (entity.key === 'leave-policies') {
    const problem = leavePolicyRuleProblem({
      appliesTo: body.appliesTo,
      accrualRule: body.accrualRule,
      carryoverRule: body.carryoverRule,
    })
    if (problem) return problem
    const applies = (body.appliesTo ?? null) as { employer_subsidiary_id?: unknown; department_id?: unknown } | null
    if (applies) {
      const subsidiary = (applies.employer_subsidiary_id ?? null) as string | null
      const department = (applies.department_id ?? null) as string | null
      const refs = await executor.execute(sql`
        select
          ${subsidiary ? sql`exists(select 1 from subsidiaries where id = ${subsidiary} and org_id = ${orgId})` : sql`true`} as subsidiary_ok,
          ${department ? sql`exists(select 1 from departments where id = ${department} and org_id = ${orgId})` : sql`true`} as department_ok
      `)
      if (!refs.rows[0]?.subsidiary_ok) return 'The applies-to subsidiary is not visible in this organization'
      if (!refs.rows[0]?.department_ok) return 'The applies-to department is not visible in this organization'
    }
  }
  // HRM benefit plans (0197): the coordinator-ruled component validation on
  // plan save — a side with a cost and no component is refused by name,
  // the employer component must be kind employer_contribution (so employer
  // money can never reach net pay), the employee component kind deduction.
  // prorationBasis carries no drawer default, so a missing rule is refused
  // here with its remedy, never stored as a guess.
  if (entity.key === 'benefit-plans') {
    // Edits arrive partial: merge the stored row first so an edit that
    // touches only the name is not refused for a rule it never changed
    // (0193 steps precedent).
    let values: Record<string, unknown> = body as Record<string, unknown>
    if (rowId) {
      const current = await executor.execute(sql`
        select proration_basis as "prorationBasis",
               employee_cost_basis as "employeeCostBasis", employer_cost_basis as "employerCostBasis",
               currency, waiting_period_days as "waitingPeriodDays",
               employee_pay_component_id as "employeePayComponentId",
               employer_pay_component_id as "employerPayComponentId",
               provider_party_id as "providerPartyId", employer_subsidiary_id as "employerSubsidiaryId"
          from hrm_benefit_plans where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Benefit plan not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...values }
    }
    const shape = benefitPlanShapeProblem(values)
    if (shape) return shape
    const employeeComponent = (values.employeePayComponentId ?? null) as string | null
    const employerComponent = (values.employerPayComponentId ?? null) as string | null
    const provider = (values.providerPartyId ?? null) as string | null
    const subsidiary = (values.employerSubsidiaryId ?? null) as string | null
    const refs = await executor.execute(sql`
      select
        ${provider ? sql`exists(select 1 from parties where id = ${provider} and org_id = ${orgId})` : sql`true`} as provider_ok,
        ${subsidiary ? sql`exists(select 1 from subsidiaries where id = ${subsidiary} and org_id = ${orgId})` : sql`true`} as subsidiary_ok,
        ${employeeComponent ? sql`(select json_build_object('kind', kind, 'active', is_active) from pay_components where id = ${employeeComponent} and org_id = ${orgId})` : sql`null`} as employee_component,
        ${employerComponent ? sql`(select json_build_object('kind', kind, 'active', is_active) from pay_components where id = ${employerComponent} and org_id = ${orgId})` : sql`null`} as employer_component
    `)
    if (!refs.rows[0]?.provider_ok) return 'The provider party is not visible in this organization'
    if (!refs.rows[0]?.subsidiary_ok) return 'The employer subsidiary is not visible in this organization'
    const employeeRow = refs.rows[0]?.employee_component as { kind?: string | null; active?: boolean } | null
    if (employeeComponent && !employeeRow?.kind) return 'The employee pay component is not visible in this organization'
    if (employeeComponent && employeeRow?.active !== true) return 'The employee pay component is inactive — reactivate it or link its replacement'
    if (employeeComponent && employeeRow?.kind !== 'deduction') {
      return 'The employee component must be kind deduction so a contribution can never inflate net pay'
    }
    const employerRow = refs.rows[0]?.employer_component as { kind?: string | null; active?: boolean } | null
    if (employerComponent && !employerRow?.kind) return 'The employer pay component is not visible in this organization'
    if (employerComponent && employerRow?.active !== true) return 'The employer pay component is inactive — reactivate it or link its replacement'
    if (employerComponent && employerRow?.kind !== 'employer_contribution') {
      return 'The employer component must be kind employer_contribution so employer money can never reach net pay'
    }
  }
  // HRM benefit pricing tiers (0197): the parent plan must live in this
  // org; keys and labels are non-blank; costs and position are explicit.
  if (entity.key === 'benefit-plan-levels') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select plan_id as "planId" from hrm_benefit_plan_levels where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Benefit tier not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    const plan = (values.planId ?? null) as string | null
    const planOk = plan
      ? (await executor.execute(sql`select exists(select 1 from hrm_benefit_plans where id = ${plan} and org_id = ${orgId}) as ok`)).rows[0]?.ok
      : false
    if (!planOk) return 'The parent benefit plan is not visible in this organization'
  }
  // HRM process template steps (0193): named owners must be visible parties
  // (named_party needs exactly one, other owners need none), and the parent
  // template must live in this org.
  if (entity.key === 'hrm-process-template-steps') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select template_id as "templateId", owner_kind as "ownerKind", owner_party_id as "ownerPartyId"
          from hrm_process_template_steps where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Template step not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    if (values.ownerKind !== undefined && !['manager', 'hr', 'employee', 'named_party'].includes(String(values.ownerKind))) {
      return 'Assign the step to manager, hr, employee, or named_party'
    }
    const ownerParty = (values.ownerPartyId ?? null) as string | null
    if (values.ownerKind === 'named_party' && ownerParty === null) return 'A named-party step needs exactly one owner party'
    if (values.ownerKind !== undefined && values.ownerKind !== 'named_party' && ownerParty !== null) {
      return 'Only a named-party step takes an owner party — clear it'
    }
    const refs = await executor.execute(sql`
      select
        ${values.templateId ? sql`exists(select 1 from hrm_process_templates where id = ${values.templateId} and org_id = ${orgId})` : sql`false`} as template_ok,
        ${ownerParty ? sql`exists(select 1 from parties where id = ${ownerParty} and org_id = ${orgId})` : sql`true`} as party_ok
    `)
    if (!refs.rows[0]?.template_ok) return 'The parent template is not visible in this organization'
    if (!refs.rows[0]?.party_ok) return 'The owner party is not visible in this organization'
  }
  // HRM pipeline stages (0195): the parent funnel must live in this org
  // and the kind must name the fixed vocabulary — terminality derives
  // from kind in storage, so an unknown kind is refused before the write.
  if (entity.key === 'hrm-pipeline-stages') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select template_id as "templateId", kind from hrm_pipeline_stages
         where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Pipeline stage not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    if (values.kind !== undefined && !['screening', 'interview', 'assessment', 'offer', 'hired', 'rejected'].includes(String(values.kind))) {
      return 'The stage kind must be screening, interview, assessment, offer, hired, or rejected'
    }
    const refs = await executor.execute(sql`
      select
        ${values.templateId ? sql`exists(select 1 from hrm_pipeline_templates where id = ${values.templateId} and org_id = ${orgId})` : sql`false`} as template_ok
    `)
    if (!refs.rows[0]?.template_ok) return 'The parent funnel is not visible in this organization'
  }
  // HRM review templates (0196): the rating scale is refused with the
  // engine's own words before the write, merging the current row on edit
  // so a partial slot edit keeps the untouched bound. Sections prove
  // their parent template and questions prove their parent section, both
  // visible in this org — a form that can never open is refused by field
  // name instead of saved as openable.
  if (entity.key === 'hrm-review-templates') {
    let scale = body.ratingScale as Record<string, unknown> | undefined
    if (rowId) {
      const current = await executor.execute(sql`
        select rating_scale as "ratingScale" from hrm_review_templates where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Review template not found'
      const base = (current.rows[0] as Record<string, unknown>).ratingScale
      scale = { ...((base ?? {}) as Record<string, unknown>), ...(scale ?? {}) }
    }
    try {
      parseRatingScale(scale ?? {})
    } catch (e) {
      if (e instanceof PerformanceMathError) return e.message
      throw e
    }
    // The merged scale is what writes: a partial slot edit keeps the
    // untouched bound instead of storing a partial scale the storage
    // CHECK would refuse with a worse message.
    body.ratingScale = scale
  }
  // HR-19 begin: document templates (0230) — the folded signer/merge
  // slots are proved with the engine's own words (validateTemplateInput
  // shares the API's validation; never a second classifier) and the
  // category must be declared in hrm_document_categories. Edits merge
  // the stored row first so a partial slot edit keeps the untouched
  // signer set (review-template precedent).
  if (entity.key === 'hrm-document-templates') {
    let current: { signer_roles?: unknown; merge_fields?: unknown } | null = null
    if (rowId) {
      const rows = (await executor.execute(sql`
        select signer_roles, merge_fields, category_key as "categoryKey", name as "name",
               body_template as "bodyTemplate", requires_signature as "requiresSignature",
               acknowledgment_only as "acknowledgmentOnly"
          from hrm_document_templates where id = ${rowId} and org_id = ${orgId}`)).rows as Record<string, unknown>[]
      if (!rows[0]) return 'Document template not found'
      current = rows[0]
    }
    const merged = mergeTemplateSlots(current, body)
    const probe = {
      name: body.name ?? (current as Record<string, unknown> | null)?.name ?? '',
      categoryKey: body.categoryKey ?? (current as Record<string, unknown> | null)?.categoryKey ?? '',
      bodyTemplate: body.bodyTemplate ?? (current as Record<string, unknown> | null)?.bodyTemplate ?? '',
      mergeFields: merged.mergeFields,
      requiresSignature: body.requiresSignature ?? (current as Record<string, unknown> | null)?.requiresSignature ?? false,
      signerRoles: merged.signerRoles,
      acknowledgmentOnly: body.acknowledgmentOnly ?? (current as Record<string, unknown> | null)?.acknowledgmentOnly ?? false,
    }
    try {
      validateTemplateInput(probe)
    } catch (e) {
      return e instanceof Error ? e.message : 'Invalid document template'
    }
    const declared = await executor.execute(sql`
      select 1 from hrm_document_categories
       where org_id = ${orgId} and key = ${String(probe.categoryKey)} and is_active`)
    if (!declared.rows.length) {
      return `Category ${JSON.stringify(String(probe.categoryKey))} is not declared — declare it under Setup → Workforce → Document Categories first`
    }
    body.signerRoles = merged.signerRoles
    body.mergeFields = merged.mergeFields
  }
  // HR-19 end
  // HR-19 begin: retention schedules (0230) — a schedule for an
  // undeclared category would never match a document, so the save is
  // refused against the Setup vocabulary instead of stored as a dead
  // rule. Categories themselves prove key shape with the engine's own
  // words (validateCategoryKey).
  if (entity.key === 'hrm-retention-schedules') {
    const categoryKey = String(body.categoryKey ?? '').trim()
    const declared = await executor.execute(sql`
      select 1 from hrm_document_categories
       where org_id = ${orgId} and key = ${categoryKey} and is_active`)
    if (!declared.rows.length) {
      return `Category ${JSON.stringify(categoryKey)} is not declared — declare it under Setup → Workforce → Document Categories first`
    }
  }
  if (entity.key === 'hrm-document-categories') {
    try {
      validateCategoryKey(body.key)
    } catch (e) {
      return e instanceof Error ? e.message : 'Invalid category key'
    }
  }
  // HR-19 end
  if (entity.key === 'hrm-review-template-sections') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select template_id as "templateId", kind as "kind"
          from hrm_review_template_sections where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Template section not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    if (values.kind !== undefined && !['competency', 'goals', 'free_text'].includes(String(values.kind))) {
      return 'Place the section in competency, goals, or free_text'
    }
    const refs = await executor.execute(sql`
      select
        ${values.templateId ? sql`exists(select 1 from hrm_review_templates where id = ${values.templateId} and org_id = ${orgId})` : sql`false`} as template_ok
    `)
    if (!refs.rows[0]?.template_ok) return 'The parent template is not visible in this organization'
  }
  if (entity.key === 'hrm-review-template-questions') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select section_id as "sectionId", answer_kind as "answerKind"
          from hrm_review_template_questions where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Template question not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    if (values.answerKind !== undefined && !['rating', 'text', 'rating_and_text'].includes(String(values.answerKind))) {
      return 'Answer the question with rating, text, or rating_and_text'
    }
    const refs = await executor.execute(sql`
      select
        ${values.sectionId ? sql`exists(select 1 from hrm_review_template_sections where id = ${values.sectionId} and org_id = ${orgId})` : sql`false`} as section_ok
    `)
    if (!refs.rows[0]?.section_ok) return 'The parent section is not visible in this organization'
  }
  // HR-18 begin: recruiting-depth configuration (0229). Every structured
  // field is validated through the engine service that owns the shape —
  // validateAvailabilityWindows, parseClauses, CANONICAL_RATING_KEYS —
  // and parents prove visibility in this org (the current row merges on
  // edit, so a partial edit validates the stored remainder instead of
  // refusing the untouched structure). Validation only: normalized values
  // reach the columns through the pre-fold (create defaults) and the
  // generic coercion, never by mutating the body after buildRow ran.
  // Setup can never store a row the depth services refuse to read.
  if (entity.key === 'hrm-interview-kits') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select pipeline_stage_id as "pipelineStageId", rating_scale as "ratingScale"
          from hrm_interview_kits where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Interview kit not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    const scale = values.ratingScale
    // Absent on create is defaulted before coercion (see
    // foldRecruitingSetupCreate); present-but-empty is refused here, and
    // anything outside the canonical vocabulary is refused by name — the
    // storage CHECK would otherwise fail without naming the field.
    if (scale !== undefined && scale !== null) {
      const keys = Array.isArray(scale) ? scale.map(String) : []
      const allowed = new Set<string>(CANONICAL_RATING_KEYS as readonly string[])
      if (keys.length < 2 || keys.some((key) => !allowed.has(key))) {
        return 'The rating scale lists at least two of strong_no, no, yes, strong_yes'
      }
    }
    if (values.pipelineStageId) {
      const stage = await executor.execute(sql`
        select 1 from hrm_pipeline_stages where id = ${String(values.pipelineStageId)} and org_id = ${orgId}
      `)
      if (!stage.rows[0]) return 'The pipeline stage is not visible in this organization'
    }
  }
  if (entity.key === 'hrm-kit-attributes') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select kit_id as "kitId" from hrm_scorecard_attributes where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Scorecard attribute not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    if (values.position !== undefined && (!Number.isInteger(Number(values.position)) || Number(values.position) < 0)) {
      return 'Attribute position is a zero-based integer ordering the scorecard'
    }
    const kit = await executor.execute(sql`
      select 1 from hrm_interview_kits where id = ${String(values.kitId ?? '')} and org_id = ${orgId}
    `)
    if (!kit.rows[0]) return 'The parent kit is not visible in this organization'
  }
  if (entity.key === 'hrm-kit-questions') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select kit_id as "kitId", attribute_id as "attributeId"
          from hrm_interview_kit_questions where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Kit question not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    if (values.position !== undefined && (!Number.isInteger(Number(values.position)) || Number(values.position) < 0)) {
      return 'Question position is a zero-based integer ordering the guide'
    }
    const kit = await executor.execute(sql`
      select 1 from hrm_interview_kits where id = ${String(values.kitId ?? '')} and org_id = ${orgId}
    `)
    if (!kit.rows[0]) return 'The parent kit is not visible in this organization'
    if (values.attributeId) {
      const attribute = await executor.execute(sql`
        select 1 from hrm_scorecard_attributes
         where id = ${String(values.attributeId)} and org_id = ${orgId} and kit_id = ${String(values.kitId ?? '')}
      `)
      if (!attribute.rows[0]) return 'The attribute belongs to a different kit — pin the question to one of this kit\u2019s attributes'
    }
  }
  if (entity.key === 'hrm-interviewer-pools') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select kit_id as "kitId", availability as "availability"
          from hrm_interviewer_pools where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Interviewer pool not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    if (values.availability !== undefined && values.availability !== null) {
      try {
        validateAvailabilityWindows(values.availability)
      } catch (e) {
        if (e instanceof RecruitingError) return e.message
        throw e
      }
    }
    if (values.kitId) {
      const kit = await executor.execute(sql`
        select 1 from hrm_interview_kits where id = ${String(values.kitId)} and org_id = ${orgId}
      `)
      if (!kit.rows[0]) return 'The default kit is not visible in this organization'
    }
  }
  if (entity.key === 'hrm-offer-templates') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select name as "name", clauses as "clauses"
          from hrm_offer_templates where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Offer template not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    if (values.clauses !== undefined && values.clauses !== null) {
      try {
        parseClauses(values.clauses, String(values.name ?? 'template'))
      } catch (e) {
        if (e instanceof RecruitingError) return e.message
        throw e
      }
    }
  }
  if (entity.key === 'hrm-retention-rules') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select region_scope as "regionScope", basis as "basis", action as "action",
               retain_months as "retainMonths", consent_extension_lead_days as "consentExtensionLeadDays"
          from hrm_retention_rules where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Retention rule not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    if (values.basis !== undefined && !['inactivity', 'consent'].includes(String(values.basis))) {
      return 'The rule basis is inactivity or consent'
    }
    if (values.action !== undefined && !['anonymize', 'delete'].includes(String(values.action))) {
      return 'The rule action is anonymize or delete'
    }
    if (values.retainMonths !== undefined && (!Number.isInteger(Number(values.retainMonths)) || Number(values.retainMonths) < 1)) {
      return 'Retention months is a positive integer'
    }
    if (values.consentExtensionLeadDays !== undefined && values.consentExtensionLeadDays !== null
      && (!Number.isInteger(Number(values.consentExtensionLeadDays)) || Number(values.consentExtensionLeadDays) < 1)) {
      return 'Extension lead days is a positive integer, or empty for no extension email'
    }
    const scope = values.regionScope as Record<string, unknown> | null | undefined
    if (scope !== undefined && scope !== null) {
      if (typeof scope !== 'object' || Array.isArray(scope)) return 'The region scope is an object with applies_to all or countries'
      const appliesTo = (scope as Record<string, unknown>).applies_to
      if (appliesTo !== undefined && appliesTo !== 'all' && appliesTo !== 'countries') {
        return 'The region scope applies_to is all or countries'
      }
      if (appliesTo === 'countries') {
        const countries = (scope as Record<string, unknown>).countries
        if (!Array.isArray(countries) || countries.length === 0 || countries.some((code) => typeof code !== 'string' || code.trim().length === 0)) {
          return 'The region scope names at least one country code'
        }
      }
    }
  }
  // HR-18 end
  // HRM compensation architecture (0221, HR-12): levels carry at least
  // one directive criterion with a positive weight (merged on edit so a
  // partial slot edit keeps the untouched weights); the family, when
  // named, must be visible in this org. Bands order min <= target <=
  // max and scope to the level's own family — a band that prices a rung
  // against another family's ladder is refused by field name.
  if (entity.key === 'hrm-job-levels') {
    let values = body
    if (rowId) {
      const current = await executor.execute(sql`
        select family_id as "familyId", equal_value_criteria as "equalValueCriteria"
          from hrm_job_levels where id = ${rowId} and org_id = ${orgId}
      `)
      if (!current.rows[0]) return 'Job level not found'
      values = { ...(current.rows[0] as Record<string, unknown>), ...body }
    }
    const criteria = values.equalValueCriteria
    const allowed = new Set(['skills', 'effort', 'responsibility', 'working_conditions'])
    if (!Array.isArray(criteria) || criteria.length === 0) {
      return 'Declare at least one equal-value criterion (skills, effort, responsibility, working_conditions) with a weight'
    }
    for (const entry of criteria) {
      const row = entry as Record<string, unknown>
      if (!row || !allowed.has(String(row.criterion))) return 'Each criterion names skills, effort, responsibility, or working_conditions'
      if (typeof row.weight !== 'string' || !/^\d+(\.\d+)?$/.test(row.weight) || !(Number(row.weight) > 0)) {
        return 'Each criterion needs a positive weight'
      }
    }
    if (values.familyId) {
      const family = await executor.execute(sql`
        select 1 from hrm_job_families where id = ${String(values.familyId)} and org_id = ${orgId}
      `)
      if (!family.rows[0]) return 'The family is not visible in this organization'
    }
    if (values.rank !== undefined && (!Number.isInteger(Number(values.rank)) || Number(values.rank) < 1)) {
      return 'Rank is a positive integer ordering the ladder'
    }
  }
  if (entity.key === 'hrm-pay-bands') {
    const min = body.min !== undefined ? Number(body.min) : null
    const target = body.target !== undefined ? Number(body.target) : null
    const max = body.max !== undefined ? Number(body.max) : null
    if ((min !== null && !(min > 0)) || (target !== null && !(target > 0)) || (max !== null && !(max > 0))) {
      return 'Band min, target and max are positive amounts'
    }
    if (min !== null && target !== null && max !== null && !(min <= target && target <= max)) {
      return 'Order the band min <= target <= max'
    }
    if (body.levelId) {
      const level = (await executor.execute(sql`
        select family_id as "familyId" from hrm_job_levels where id = ${String(body.levelId)} and org_id = ${orgId}
      `)).rows[0] as Record<string, unknown> | undefined
      if (!level) return 'The level is not visible in this organization'
      if (body.familyId && String(body.familyId) !== String(level.familyId ?? '')) {
        return 'Scope the band to the level\'s own family, or to no family for the org-wide ladder'
      }
    }
  }
  return null
}


/**
 * Bills of materials change only through the BOM command
 * (PUT /api/inventory/bom): a complete recipe with an expected version, a
 * reason, and one before/after audit. Generic single-row CRUD would let one
 * component change without a revision or reason, delete the last component,
 * or store a zero/negative quantity the build then refuses or misprices — so
 * every generic verb refuses here, in the preflight and in each command (the
 * assistant/MCP tools share the commands, not the route). Bulk migration
 * imports keep their own path in web/lib/data-io/setup-resources.ts.
 */
function bomCommandOnly(entity: SetupEntity): SetupWriteResult | null {
  if (entity.key !== 'bom-components') return null
  return {
    status: 405,
    body: { error: 'Bills of materials change only through the bill of materials command (PUT /api/inventory/bom), which records the revision, reason, and audit.' },
  }
}

/**
 * The refusals every mutation applies before it reads a body or touches the
 * database: unknown/disabled entity (404), declaration-owned, command-owned,
 * or shared reference data (405). The route calls this before parsing so a
 * malformed body on a refused entity still answers 405, and each command
 * re-runs it.
 */
export async function preflightSetupWrite(
  actor: SetupActor,
  entityKey: string,
  method: 'create' | 'update' | 'delete',
): Promise<SetupWriteResult | null> {
  const entity = resolveEntity(entityKey)
  if (!entity) return { status: 404, body: { error: 'unknown setup entity' } }
  if (!(await setupEntityEnabled(entity, actor.orgId))) return { status: 404, body: { error: 'unknown setup entity' } }
  const owned = bomCommandOnly(entity)
  if (owned) return owned
  if (method === 'create' && entity.allowCreate === false) return { status: 405, body: { error: 'This configuration is declared by its module' } }
  if (method === 'delete' && entity.allowDelete === false) return { status: 405, body: { error: 'Module setting history is preserved' } }
  if (entity.readOnly) return { status: 405, body: { error: 'read-only' } }
  if (method === 'delete' && entity.key === 'accounting-books') return { status: 405, body: { error: 'archive-only' } }
  return null
}

/**
 * Duplicate conflicts stay typed (F-t06-019): `code` drives the drawer's
 * localized copy while `error` reads as user language for every other
 * surface of this shared layer (assistant/MCP tools, API consumers) — never
 * a bare code string.
 */
function duplicateConflict(entityKey: string): { status: 409; body: { error: string; code: 'duplicate' } } {
  const error = entityKey === 'fx-rates' || entityKey === 'consolidated-fx-rates'
    ? 'An exchange rate for this date, currency pair and type already exists.'
    : 'This record already exists.'
  return { status: 409, body: { error, code: 'duplicate' } }
}

/**
 * Overlap conflicts stay typed (F-t09-016): a GiST exclusion rejection
 * (SQLSTATE 23P01) must never echo Postgres constraint text to the drawer.
 * `code` drives the drawer's localized copy while `error` reads as user
 * language for every other surface of this shared layer.
 */
function overlapConflict(entityKey: string): { status: 409; body: { error: string; code: 'overlap' } } {
  const error = entityKey === 'income-tax-rates'
    ? 'An active rate already covers this jurisdiction for this period.'
    : entityKey === 'leave-policies'
      ? 'Another policy already covers this leave type and scope for these dates — close its window or deactivate it before saving.'
      : 'This period overlaps an existing record.'
  return { status: 409, body: { error, code: 'overlap' } }
}

/**
 * Create one setup record (the POST semantics of /api/admin/setup/[entity]).
 *
 * Every create carries an idempotency key that becomes the new row's id (or,
 * for home announcements, the announcement id): the HTTP route passes the
 * caller's `Idempotency-Key` header, while direct command callers (assistant
 * tools, imports) omit it and each call mints a fresh key. A retried key
 * replays the original result with no second row, audit event, or side
 * effect; a changed payload or cross-org collision is refused as 409.
 *
 * `extension-settings` declares allowCreate: false, so its creates stay 405
 * above — it is explicitly refused, never silently exempted from the claim.
 */
export async function createSetupRecord(
  actor: SetupActor,
  entityKey: string,
  rawBody: Record<string, unknown>,
  options: { requestId?: string } = {},
): Promise<SetupWriteResult> {
  const { orgId, id: actorId } = actor
  const entity = resolveEntity(entityKey)
  if (!entity) return { status: 404, body: { error: 'unknown setup entity' } }
  if (!(await setupEntityEnabled(entity, orgId))) return { status: 404, body: { error: 'unknown setup entity' } }
  const owned = bomCommandOnly(entity)
  if (owned) return owned
  if (entity.allowCreate === false) return { status: 405, body: { error: 'This configuration is declared by its module' } }
  if (entity.readOnly) return { status: 405, body: { error: 'read-only' } }
  const requestId = options.requestId ?? randomUUID()
  if (!isUuid(requestId)) {
    return { status: 400, body: { error: 'Idempotency-Key must be a UUID', code: 'invalid' } }
  }

  // HR-15: home announcements create into org settings JSON.
  if (entity.dataSource === 'home-announcements') {
    try { return { status: 200, body: await createHomeAnnouncementRow(orgId, rawBody, { id: requestId }) } }
    catch (error) {
      if (error instanceof Error && (error as { status?: unknown }).status === 409) {
        return { status: 409, body: { error: error.message, code: 'idempotency-conflict' } }
      }
      return { status: 400, body: { error: error instanceof Error ? error.message : 'Invalid announcement' } }
    }
  }

  // HR-18: recruiting-depth create defaults fold before the generic coercion.
  const recruitingBody = foldRecruitingSetupCreate(entity.key, rawBody)
  const body = normalizeHrmDocumentTemplateInput(entity.key, normalizeHrmBenefitPlanInput(entity.key, normalizeHrmPipelineStageInput(entity.key, normalizeHrmLeavePolicyInput(entity.key, normalizeHrmReviewTemplateInput(entity.key, normalizeHrmCompensationInput(entity.key, normalizeHrmProcessTemplateInput(entity.key, normalizeTaxReturnFormInput(entity.key, recruitingBody))))))))
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
  // The writer normalizes slot fields into their folded objects before this
  // point, so a present fold covers its slots' requiredness and columns.
  const built = buildRow(await entityForValidation(createEntity), body, { forCreate: true, coverFoldedSlots: true })
  if ('error' in built) return { status: 400, body: { error: built.error, code: 'invalid' } }
  const integrityError = await validateEntityIntegrity(entity, body, orgId)
  if (integrityError) {
    if (integrityError === 'not found') return { status: 404, body: { error: integrityError } }
    // Typed user-correctable failure (F-t06-023): the code lets surfaces map
    // stably while the message reads as user language.
    return { status: 400, body: { error: integrityError, code: 'invalid' } }
  }

  // Request-controlled match image for the book entities: submitted values
  // only. The selected/active flags derive from concurrent table state
  // (first-book auto-promotion), so comparing them would turn a genuine
  // retry into a conflict; the claim compares this image against the stored
  // one, never against the derived row.
  const setupBookMatch = (): Record<string, unknown> => ({
    code: String(body.code),
    name: String(body.name),
    ...(entity.key === 'accounting-books'
      ? { is_primary: body.isPrimary === undefined ? null : coerceBoolean(body.isPrimary) }
      : { is_default: body.isDefault === undefined ? null : coerceBoolean(body.isDefault) }),
    is_active: body.isActive === undefined ? null : coerceBoolean(body.isActive),
    ...(entity.key === 'accounting-books' || body.currency === undefined ? {} : { currency: String(body.currency) }),
    org_id: orgId,
    created_by: actorId,
    updated_by: actorId,
  })

  if (entity.key === 'accounting-books') {
    try {
      const id = await setupWriteTransaction(entity, orgId, body, undefined, (tx) =>
        saveSetupBook(entity, orgId, actorId, body, tx, { idempotencyKey: requestId, match: setupBookMatch() }),
        { idempotencyKey: requestId })
      return { status: 200, body: { id } }
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return { status: e.status, body: { error: e.message } }
      if (e instanceof SetupCreateConflict) return { status: e.status, body: { error: e.message, code: e.code } }
      return { status: 400, body: { error: describeDbError(e) } }
    }
  }

  if (entity.key === 'item-rate-books') {
    // Rate-book currency is Multi-currency configuration. Turning that
    // switch off must refuse a new write; omitting currency keeps the
    // org base so a book can still be created and stored books stay.
    if (body.currency !== undefined && !multiCurrency) {
      return { status: 404, body: { error: 'not found' } }
    }
    try {
      const id = await setupWriteTransaction(entity, orgId, body, undefined, (tx) =>
        saveSetupBook(entity, orgId, actorId, body, tx, { idempotencyKey: requestId, match: setupBookMatch() }),
        { idempotencyKey: requestId })
      return { status: 200, body: { id } }
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return { status: e.status, body: { error: e.message } }
      if (e instanceof SetupCreateConflict) return { status: e.status, body: { error: e.message, code: e.code } }
      return { status: 400, body: { error: describeDbError(e) } }
    }
  }

  // Natural-key uniqueness (these tables mostly lack a DB unique constraint).
  // The check selects ids so a retried idempotency key passes through: when
  // the duplicate row IS this key's own row, the claim inside the transaction
  // replays an exact retry (200) or refuses a changed payload (409) instead
  // of misreporting the retry as a natural-key duplicate.
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
      select id from ${sql.raw(entity.table)}
       where ${sql.raw(col)} = ${val}${orgFilter}${effectiveFilter} limit 1`)))
    if (dup.rows.length > 0
      && !(dup.rows as { id: unknown }[]).some((row) => String(row.id) === requestId)) {
      return duplicateConflict(entity.key)
    }
  }

  // Rule-slot entities: generated slot columns are never written and the
  // folded rule objects always are (see hrm-rule-slots.ts).
  const slotted = applyRuleSlotColumns(entity.key, body, built.cols)
  if ('error' in slotted) return { status: 400, body: { error: slotted.error } }
  let cols = entity.key === 'fx-rates'
    ? slotted.cols.filter((column) => !['source', 'provider_config_id', 'imported_at'].includes(column.column))
    : [...slotted.cols]
  if (entity.key === 'fx-rates' || entity.key === 'consolidated-fx-rates') {
    try {
      cols = persistFxRateCols(cols)
    } catch (error) {
      return { status: 400, body: {
        error: error instanceof CurrencyError ? error.message : 'Exchange rates must be an exact decimal',
      } }
    }
  }
  if (entity.key === 'fx-rates') cols.push({ column: 'source', value: 'manual' })
  if (entity.orgScoped) cols.push({ column: 'org_id', value: orgId })
  if (entity.actorCols) {
    cols.push({ column: 'created_by', value: actorId })
    cols.push({ column: 'updated_by', value: actorId })
  }
  // The idempotency key becomes the row id, claimed atomically
  // (on conflict do nothing) at each insert below; a lost race re-resolves
  // the claim in the same transaction instead of reporting success for a row
  // it did not write.
  cols.push({ column: 'id', value: requestId })

  // Request-controlled match image for the replay comparison: the exact
  // coerced columns the insert stores (actor/org context included, so a
  // different actor reusing the key fails closed), plus join-table members
  // where the entity has them. Derived values never enter here — version
  // closures and book promotions compute theirs after the claim.
  const setupCreateMatch = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const match: Record<string, unknown> = { ...extra }
    for (const column of cols) {
      if (column.column === 'id') continue
      match[column.column] = column.value
    }
    return match
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
    const match = setupCreateMatch()
    const claimMatch = { orgId, table: entity.table, key: requestId, match, orgScoped: entity.orgScoped }
    try {
      const newId = await setupWriteTransaction(entity, orgId, body, undefined, async (tx) => {
        // The claim resolves before the version closure below, so an exact
        // retry returns without closing (or re-closing) the prior version.
        const claim = await claimSetupCreate(tx, claimMatch)
        if (claim.kind === 'replay') return claim.id
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
          on conflict (id) do nothing
          returning ${sql.raw(idColumn(entity))} as id`)))
        const insertedRow = inserted.rows[0]
        if (!insertedRow) {
          // Lost the same-key insert race: the winner's row (and its insert
          // audit) is visible now, so re-resolve the claim in this same
          // transaction — replay, or refuse.
          const raced = await claimSetupCreate(tx, claimMatch)
          if (raced.kind === 'replay') return raced.id
          throw new Error('not found')
        }
        const id = String(insertedRow.id)
        await audit({
          orgId: entity.orgScoped ? orgId : null,
          table: entity.table,
          rowId: id,
          action: 'insert',
          changes: { after: await loadSetupAuditRow(entity, orgId, id, tx), match },
          actorId,
          requestId,
        }, tx)
        return id
      }, { idempotencyKey: requestId })
      return { status: 200, body: { id: newId } }
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return { status: e.status, body: { error: e.message } }
      if (e instanceof SetupCreateConflict) return { status: e.status, body: { error: e.message, code: e.code } }
      if (pgErrorCode(e) === '23505' || pgErrorCode(e) === '23P01') {
        return duplicateConflict(entity.key)
      }
      return { status: 400, body: { error: describeDbError(e) } }
    }
  }

  try {
    const members = multirefField(entity)
    const memberIds = members && Array.isArray(body[members.key])
      ? [...new Set((body[members.key] as unknown[]).map(String).filter((v) => UUID_RE.test(v)))]
      : undefined
    const match = setupCreateMatch(memberIds === undefined ? {} : { members: memberIds })
    const claimMatch = { orgId, table: entity.table, key: requestId, match, orgScoped: entity.orgScoped }
    const newId = await setupWriteTransaction(entity, orgId, body, undefined, async (tx) => {
      // The claim resolves before the insert and the member sync below, so
      // an exact retry returns having written neither.
      const claim = await claimSetupCreate(tx, claimMatch)
      if (claim.kind === 'replay') return claim.id
      const inserted = ((await tx.execute(sql`
        insert into ${sql.raw(entity.table)} (${colSql}) values (${valSql})
        on conflict (id) do nothing
        returning ${sql.raw(idColumn(entity))} as id`)))
      const insertedRow = inserted.rows[0]
      if (!insertedRow) {
        // Lost the same-key insert race: re-resolve the claim in this same
        // transaction — replay, or refuse.
        const raced = await claimSetupCreate(tx, claimMatch)
        if (raced.kind === 'replay') return raced.id
        throw new Error('not found')
      }
      const id = String(insertedRow.id)
      if (members && Array.isArray(body[members.key])) {
        await syncMembers(orgId, id, (body[members.key] as unknown[]).map(String), tx)
      }
      await audit({
        orgId: entity.orgScoped ? orgId : null,
        table: entity.table,
        rowId: id,
        action: 'insert',
        changes: { after: await loadSetupAuditRow(entity, orgId, id, tx), match },
        actorId,
        requestId,
      }, tx)
      return id
    }, { idempotencyKey: requestId })
    return { status: 200, body: { id: newId } }
  } catch (e) {
    if (e instanceof SetupWriteRefusal) return { status: e.status, body: { error: e.message } }
    if (e instanceof SetupCreateConflict) return { status: e.status, body: { error: e.message, code: e.code } }
    const databaseError = e as { constraint?: string; cause?: { constraint?: string; message?: string }; message?: string }
    if ((databaseError.cause?.constraint ?? databaseError.constraint) === 'depreciation_book_posted_policy') {
      return { status: 409, body: { error: databaseError.cause?.message ?? databaseError.message } }
    }
    // The natural-key preflight above is an autocommit read, so two concurrent
    // creates can both pass it; the storage UNIQUE constraint is the authority
    // and surfaces here as a deterministic 409, with no partial row or audit
    // (the insert and its audit share one transaction).
    if (pgErrorCode(e) === '23505') {
      return duplicateConflict(entity.key)
    }
    // Effective-range exclusion constraints (SQLSTATE 23P01) arbitrate overlap
    // races the same way: typed 409, never raw Postgres text (F-t09-016).
    if (pgErrorCode(e) === '23P01') {
      return overlapConflict(entity.key)
    }
    return { status: 400, body: { error: describeDbError(e) } }
  }
}


/** Update one setup record; `rawBody.id` addresses the row (PATCH semantics). */
export async function updateSetupRecord(
  actor: SetupActor,
  entityKey: string,
  rawBody: Record<string, unknown>,
): Promise<SetupWriteResult> {
  const { orgId, id: actorId } = actor
  const entity = resolveEntity(entityKey)
  if (!entity) return { status: 404, body: { error: 'unknown setup entity' } }
  if (!(await setupEntityEnabled(entity, orgId))) return { status: 404, body: { error: 'unknown setup entity' } }
  const owned = bomCommandOnly(entity)
  if (owned) return owned
  if (entity.readOnly) return { status: 405, body: { error: 'read-only' } }

  const body = normalizeHrmDocumentTemplateInput(entity.key, normalizeHrmBenefitPlanInput(entity.key, normalizeHrmPipelineStageInput(entity.key, normalizeHrmLeavePolicyInput(entity.key, normalizeHrmReviewTemplateInput(entity.key, normalizeHrmCompensationInput(entity.key, normalizeHrmProcessTemplateInput(entity.key, normalizeTaxReturnFormInput(entity.key, rawBody))))))))
  const id = String(body.id ?? '')
  if (!id) return { status: 400, body: { error: 'id required' } }
  if (entity.dataSource !== 'extension-settings' && idColumn(entity) === 'id' && !UUID_RE.test(id)) {
    return { status: 404, body: { error: 'not found' } }
  }

  if (entity.dataSource === 'extension-settings') {
    try { return { status: 200, body: await saveExtensionSettingRow(orgId, actorId, [...actor.permissions], body) } }
    catch (error) {
      const status = error instanceof Error && 'status' in error && error.status === 409 ? 409 : 400
      return { status: status, body: { error: error instanceof Error ? error.message : 'Invalid module setting' } }
    }
  }

  // HR-15: home announcements live in org settings JSON, not a table.
  if (entity.dataSource === 'home-announcements') {
    try { return { status: 200, body: await saveHomeAnnouncementRow(orgId, id, body) } }
    catch (error) {
      const status = error instanceof Error && 'status' in error && error.status === 404 ? 404 : 400
      return { status: status, body: { error: error instanceof Error ? error.message : 'Invalid announcement' } }
    }
  }

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
  // Same folded-slot cover as the create path: the normalizer ran above.
  const built = buildRow(await entityForValidation(patchEntity), body, { forCreate: false, coverFoldedSlots: true })
  if ('error' in built) return { status: 400, body: { error: built.error, code: 'invalid' } }
  const integrityError = await validateEntityIntegrity(entity, body, orgId, id)
  if (integrityError) {
    if (integrityError === 'not found') return { status: 404, body: { error: integrityError } }
    // Typed user-correctable failure (F-t06-023): the code lets surfaces map
    // stably while the message reads as user language.
    return { status: 400, body: { error: integrityError, code: 'invalid' } }
  }

  if (entity.key === 'accounting-books') {
    try {
      await setupWriteTransaction(entity, orgId, body, id, (tx) =>
        saveSetupBook(entity, orgId, actorId, body, tx, { id }))
      return { status: 200, body: { id } }
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return { status: e.status, body: { error: e.message } }
      const message = (e as Error).message
      const error = message === 'primary-required' || message === 'primary-active-required' || message === 'not found'
        ? message
        : describeDbError(e)
      return { status: error === 'not found' ? 404 : 400, body: { error } }
    }
  }

  if (entity.key === 'item-rate-books') {
    // Rate-book currency is Multi-currency configuration. Turning that
    // switch off must refuse a write; omitting currency keeps the
    // stored book.
    if (body.currency !== undefined && !multiCurrency) {
      return { status: 404, body: { error: 'not found' } }
    }
    try {
      await setupWriteTransaction(entity, orgId, body, id, (tx) =>
        saveSetupBook(entity, orgId, actorId, body, tx, { id }))
      return { status: 200, body: { id } }
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return { status: e.status, body: { error: e.message } }
      const message = (e as Error).message
      const error = ['not found', 'default-required'].includes(message) ? message : describeDbError(e)
      return { status: error === 'not found' ? 404 : 400, body: { error } }
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

        // Request match image for the successor insert audit, mirroring the
        // POST path: the exact coerced columns the insert stores (actor
        // context included), so the evidence names the request it came from.
        const successorMatch: Record<string, unknown> = {}
        for (const column of successorColumns) {
          if (column === 'org_id') successorMatch[column] = orgId
          else if (column === 'code') successorMatch[column] = String(current.code)
          else if (column === 'created_by' || column === 'updated_by') successorMatch[column] = actorId
          else if (column === 'effective_to') successorMatch[column] = effectiveTo ?? null
          else successorMatch[column] = valueFor(column) ?? null
        }

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
          changes: { after: await loadSetupAuditRow(entity, orgId, successorId, tx), match: successorMatch },
          actorId,
        }, tx)
        return successorId
      })
      return { status: 200, body: { id: versionId } }
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return { status: e.status, body: { error: e.message } }
      const code = pgErrorCode(e)
      if (code === '23505' || code === '23P01') {
        return duplicateConflict(entity.key)
      }
      const message = (e as Error).message
      if (message === 'not found') return { status: 404, body: { error: message } }
      if (message === 'effective-from-must-follow-current') {
        return { status: 400, body: { error: 'A changed derived rule must start after its current effective date' } }
      }
      if (message === 'effective-to-before-effective-from') {
        return { status: 400, body: { error: 'effectiveTo cannot precede effectiveFrom' } }
      }
      return { status: 400, body: { error: describeDbError(e) } }
    }
  }

  if (entity.key === 'recognition-rules') {
    // A rule is priced history once any obligation references it: rebuilding
    // that obligation's unposted schedule (or snapshotting it for amendment)
    // reads the pinned rule row, so changing the policy in place would
    // silently reprice and retime earned revenue. A policy edit on a used
    // rule therefore creates a successor version (same code, version + 1)
    // that new obligations use; items repoint at the successor while
    // existing obligations keep their pinned row. Name and active-flag edits
    // — and any edit to an unused rule — stay in place.
    const policyColumns = [
      'method', 'is_forecast', 'recognition_periods', 'start_date_source',
      'end_date_source', 'period_offset', 'start_offset_days',
      'initial_amount_percent', 'deferred_account_id', 'recognized_account_id',
    ]
    const builtByColumn = new Map(built.cols.map((column) => [column.column, column.value]))
    try {
      const versionId = await setupWriteTransaction(entity, orgId, body, id, async (tx) => {
        const currentRes = ((await tx.execute(sql`
          select * from recognition_rules
           where id = ${id} and org_id = ${orgId}
           for update`)))
        const current = currentRes.rows[0] as Record<string, unknown> | undefined
        if (!current) throw new Error('not found')

        // Omission is not a change: buildRow materializes unsubmitted
        // nullable fields as explicit nulls, so only a submitted field can
        // move the policy. A submitted blank that buildRow omits likewise
        // leaves the stored value alone.
        const valueFor = (column: string) => {
          const key = entity.fields.find((f) => toSnake(f.key) === column)?.key
          if (key === undefined || body[key] === undefined) return current[column]
          if (!builtByColumn.has(column)) return current[column]
          return builtByColumn.get(column)
        }
        const changedPolicy = policyColumns.some((column) =>
          comparableSetupValue(valueFor(column)) !== comparableSetupValue(current[column]))
        const used = ((await tx.execute(sql`
          select 1 from performance_obligations
           where org_id = ${orgId} and recognition_rule_id = ${id}
           limit 1`))).rows.length > 0

        if (!changedPolicy || !used) {
          const slotted = applyRuleSlotColumns(entity.key, body, built.cols)
          if ('error' in slotted) throw new SetupWriteRefusal(slotted.error, 400)
          // Write exactly the submitted fields: an omitted nullable field
          // must not be nulled out as a side effect of an unrelated edit.
          // (The drawer always submits full bodies, so it sees no change.)
          const submittedCols = slotted.cols.filter((c) => {
            const key = entity.fields.find((f) => toSnake(f.key) === c.column)?.key
            return key !== undefined && body[key] !== undefined
          })
          const setParts = submittedCols.map((c) => sql`${sql.raw(c.column)} = ${c.value}`)
          if (entity.actorCols) {
            setParts.push(sql`updated_by = ${actorId}`)
            setParts.push(sql`updated_at = now()`)
          }
          if (setParts.length === 0) throw new SetupWriteRefusal('nothing to update', 400)
          const before = await loadSetupAuditRow(entity, orgId, id, tx, true)
          if (!before) throw new Error('not found')
          const updated = ((await tx.execute(sql`
            update ${sql.raw(entity.table)} set ${sql.join(setParts, sql`, `)}
             where ${sql.raw(idColumn(entity))} = ${id} and org_id = ${orgId}
            returning ${sql.raw(idColumn(entity))} as id`)))
          if (updated.rows.length === 0) throw new Error('not found')
          const members = multirefField(entity)
          if (members && Array.isArray(body[members.key])) {
            await syncMembers(orgId, id, (body[members.key] as unknown[]).map(String), tx)
          }
          const after = await loadSetupAuditRow(entity, orgId, id, tx)
          await audit({
            orgId,
            table: entity.table,
            rowId: id,
            action: 'update',
            changes: { before, after },
            actorId,
          }, tx)
          return id
        }

        // The successor id is client-generated so the old row can be closed
        // first: at most one unsurpassed row may carry the code (the partial
        // unique index), while the old row's forward link needs its target.
        // The self-reference is deferrable, so both constraints are checked
        // at commit, when the chain is whole again.
        const successorId = randomUUID()
        await tx.execute(sql`SET CONSTRAINTS recognition_rules_superseded_by_fkey DEFERRED`)
        await tx.execute(sql`
          update recognition_rules
             set superseded_by = ${successorId},
                 is_active = false,
                 updated_at = now(), updated_by = ${actorId}
           where id = ${id} and org_id = ${orgId}`)
        const successorColumns = [
          'id', 'org_id', 'code', 'version', 'name', 'method', 'is_forecast',
          'recognition_periods', 'start_date_source', 'end_date_source',
          'period_offset', 'start_offset_days', 'initial_amount_percent',
          'deferred_account_id', 'recognized_account_id', 'is_active',
          'created_by', 'updated_by',
        ]
        const version = Number(current.version ?? 1) + 1
        const successorValues = successorColumns.map((column) => {
          if (column === 'id') return sql`${successorId}`
          if (column === 'org_id') return sql`${orgId}`
          if (column === 'code') return sql`${String(current.code)}`
          if (column === 'version') return sql`${version}`
          if (column === 'created_by' || column === 'updated_by') return sql`${actorId}`
          return sql`${valueFor(column) ?? null}`
        })
        const inserted = ((await tx.execute(sql`
          insert into recognition_rules (${sql.raw(successorColumns.join(', '))})
          values (${sql.join(successorValues, sql`, `)})
          returning id`)))
        if (inserted.rows.length !== 1) throw new Error('a successor rule version could not be created')
        await tx.execute(sql`
          update items
             set recognition_rule_id = ${successorId},
                 updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and recognition_rule_id = ${id}`)

        // Request match image for the successor insert audit, mirroring the
        // POST path: the exact coerced columns the insert stores (actor
        // context included), so the evidence names the request it came from.
        const successorMatch: Record<string, unknown> = {}
        for (const column of successorColumns) {
          if (column === 'id') continue
          if (column === 'org_id') successorMatch[column] = orgId
          else if (column === 'code') successorMatch[column] = String(current.code)
          else if (column === 'version') successorMatch[column] = version
          else if (column === 'created_by' || column === 'updated_by') successorMatch[column] = actorId
          else successorMatch[column] = valueFor(column) ?? null
        }

        await audit({
          orgId,
          table: entity.table,
          rowId: id,
          action: 'update',
          changes: { before: current, after: await loadSetupAuditRow(entity, orgId, id, tx) },
          actorId,
        }, tx)
        await audit({
          orgId,
          table: entity.table,
          rowId: successorId,
          action: 'insert',
          changes: { after: await loadSetupAuditRow(entity, orgId, successorId, tx), match: successorMatch },
          actorId,
        }, tx)
        return successorId
      })
      return { status: 200, body: { id: versionId } }
    } catch (e) {
      if (e instanceof SetupWriteRefusal) return { status: e.status, body: { error: e.message } }
      const code = pgErrorCode(e)
      if (code === '23505' || code === '23P01') {
        return duplicateConflict(entity.key)
      }
      const message = (e as Error).message
      if (message === 'not found') return { status: 404, body: { error: message } }
      return { status: 400, body: { error: describeDbError(e) } }
    }
  }

  const slottedUpdate = applyRuleSlotColumns(entity.key, body, built.cols)
  if ('error' in slottedUpdate) return { status: 400, body: { error: slottedUpdate.error } }
  let updateCols = entity.key === 'fx-rates'
    ? slottedUpdate.cols.filter((column) => !['source', 'provider_config_id', 'imported_at'].includes(column.column))
    : slottedUpdate.cols
  if (entity.key === 'fx-rates' || entity.key === 'consolidated-fx-rates') {
    try {
      updateCols = persistFxRateCols(updateCols)
    } catch (error) {
      return { status: 400, body: {
        error: error instanceof CurrencyError ? error.message : 'Exchange rates must be an exact decimal',
      } }
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
  if (setParts.length === 0) return { status: 400, body: { error: 'nothing to update' } }

  const orgFilter = entity.orgScoped ? sql` and org_id = ${orgId}` : sql``
  // A pay-schedule re-scope re-resolves the schedule's uncommitted runs in
  // the same transaction. The outcome (and any warning) travels out through
  // this binding because the transaction callback's boolean cannot carry it.
  let scheduleRescope: { reresolved: number; untouched: number; warning?: string } | null = null
  try {
    const found = await setupWriteTransaction(entity, orgId, body, id, async (tx) => {
      const before = await loadSetupAuditRow(entity, orgId, id, tx, true)
      if (!before) return false
      const updated = ((await tx.execute(sql`
        update ${sql.raw(entity.table)} set ${sql.join(setParts, sql`, `)}
         where ${sql.raw(idColumn(entity))} = ${id}${orgFilter}
        returning ${sql.raw(idColumn(entity))} as id`)))
      if (updated.rows.length === 0) {
        // customer-price-level-assignments: deactivating a never-effective
        // (starts-today) assignment removes the row in
        // customer_price_level_end_date_on_deactivate instead of end-dating
        // it — end-dating to yesterday would violate
        // customer_price_level_dates, and any storable window would still
        // price today. The before-image was row-locked above, so a row that
        // was present and is now gone was revoked by this same statement:
        // record the delete the trigger performed, not a missing row.
        if (entity.key === 'customer-price-level-assignments'
          && before.is_active === true
          && updateCols.some((column) => column.column === 'is_active' && column.value === false)
          && !(await loadSetupAuditRow(entity, orgId, id, tx))) {
          await audit({
            orgId: entity.orgScoped ? orgId : null,
            table: entity.table,
            rowId: id,
            action: 'delete',
            changes: { before },
            actorId,
          }, tx)
          return true
        }
        return false
      }
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
      if (entity.key === 'pay-schedules') {
        // Entity and currency re-resolve together on every uncommitted run;
        // committed history stays frozen. A re-scope the runs cannot follow
        // (a subsidiary whose currency disagrees with its payroll pack) keeps
        // the saved schedule and reports the remedy as a warning — the next
        // calculation re-attempts the move, so this never strands a run in
        // silence.
        const beforeSubsidiary = before.subsidiary_id == null ? null : String(before.subsidiary_id)
        const afterSubsidiary = after?.subsidiary_id == null ? null : String(after.subsidiary_id)
        if (beforeSubsidiary !== afterSubsidiary && afterSubsidiary) {
          try {
            const scope = await rescopePayScheduleRuns(tx, { orgId, payScheduleId: id, actorId })
            scheduleRescope = scope
          } catch (e) {
            scheduleRescope = {
              reresolved: 0,
              untouched: 0,
              warning: e instanceof Error ? e.message : String(e),
            }
          }
        }
      }
      return true
    })
    if (!found) return { status: 404, body: { error: 'not found' } }
    return { status: 200, body: { id, ...(scheduleRescope ? { rescope: scheduleRescope } : {}) } }
  } catch (e) {
    if (e instanceof SetupWriteRefusal) return { status: e.status, body: { error: e.message } }
    const databaseError = e as { constraint?: string; cause?: { constraint?: string; message?: string }; message?: string }
    if (['asset_category_posted_policy', 'pay_component_historical_policy', 'depreciation_book_posted_policy'].includes(databaseError.cause?.constraint ?? databaseError.constraint ?? '')) {
      return { status: 409, body: { error: databaseError.cause?.message ?? databaseError.message } }
    }
    // Same storage-authority mapping as POST: an edit that moves a row onto an
    // occupied natural key (codes are editable on several entities) is a
    // duplicate conflict, not a generic save failure. Edits that newly
    // overlap an effective range map the same way (F-t09-016).
    if (pgErrorCode(e) === '23505') {
      return duplicateConflict(entity.key)
    }
    if (pgErrorCode(e) === '23P01') {
      return overlapConflict(entity.key)
    }
    return { status: 400, body: { error: describeDbError(e) } }
  }
}


/** Delete (or archive) one setup record by id (DELETE semantics). */
export async function deleteSetupRecord(
  actor: SetupActor,
  entityKey: string,
  id: string,
): Promise<SetupWriteResult> {
  const { orgId, id: actorId } = actor
  const entity = resolveEntity(entityKey)
  if (!entity) return { status: 404, body: { error: 'unknown setup entity' } }
  if (!(await setupEntityEnabled(entity, orgId))) return { status: 404, body: { error: 'unknown setup entity' } }
  const owned = bomCommandOnly(entity)
  if (owned) return owned
  if (entity.allowDelete === false) return { status: 405, body: { error: 'Module setting history is preserved' } }
  if (entity.readOnly) return { status: 405, body: { error: 'read-only' } }
  if (entity.key === 'accounting-books') {
    return { status: 405, body: { error: 'archive-only' } }
  }

  // HR-15: home announcements delete from org settings JSON.
  if (entity.dataSource === 'home-announcements') {
    try {
      await deleteHomeAnnouncementRow(orgId, id)
      return { status: 200, body: { ok: true } }
    } catch (error) {
      const status = error instanceof Error && 'status' in error && error.status === 404 ? 404 : 400
      return { status: status, body: { error: error instanceof Error ? error.message : 'Invalid announcement' } }
    }
  }

  if (!id) return { status: 400, body: { error: 'id required' } }
  if (idColumn(entity) === 'id' && !UUID_RE.test(id)) {
    return { status: 404, body: { error: 'not found' } }
  }

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
    if (!found) return { status: 404, body: { error: 'not found' } }
    return { status: 200, body: { ok: true } }
  } catch (e) {
    if (e instanceof SetupWriteRefusal) return { status: e.status, body: { error: e.message } }
    if (e instanceof Error && e.message === 'default-required') {
      return { status: 409, body: { error: 'default-required' } }
    }
    const databaseError = e as { constraint?: string; cause?: { constraint?: string; message?: string }; message?: string }
    if (['pay_component_historical_policy', 'depreciation_book_posted_policy'].includes(databaseError.cause?.constraint ?? databaseError.constraint ?? '')) {
      return { status: 409, body: { error: databaseError.cause?.message ?? databaseError.message } }
    }
    // Foreign-key violation → the record is referenced elsewhere.
    if (pgErrorCode(e) === '23503') {
      return { status: 409, body: { error: 'in-use', code: 'in-use' } }
    }
    return { status: 400, body: { error: describeDbError(e) } }
  }
}
