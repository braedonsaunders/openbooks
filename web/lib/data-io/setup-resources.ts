/** Setup-registry import/export resources. */

import 'server-only'
import { loadExtensionSettingRows } from '../setup/extension-settings'
import { loadHomeAnnouncementRows } from '../setup/home-announcements'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { COUNTRY_CODES } from '../countries'
import { featureEnabled, featureGateLockKey, resolvedFeatureState } from '../features'
import { SETUP_ENTITY_BY_KEY, setupEntityForFeatureState, toSnake, type SetupEntity, type SetupField } from '../setup/registry'
import { buildRow, coerceBoolean, idColumn, type Coerced } from '../setup/coerce'
import { filingAccountProblem } from '@openbooks/engine/src/payroll/filing-registry.ts'
import { payComponentTreatmentProblem } from '@openbooks/engine/src/payroll/treatment-bases.ts'
import { validateEntityIntegrity } from '../setup/write'
import { payPeriodsPerYearProblem } from '@openbooks/engine/src/payroll/run-calendar.ts'
import { isSetupBookEntity, saveSetupBook } from '../setup/books'
import { auditSetupChange as audit, loadSetupAuditRow } from '../setup/audit'
import { setupReadProjection, setupReadSource } from '../setup/read-shape'
import {
  enforceExportRowLimit,
  exportCell,
  MAX_EXPORT_ROWS,
  RefResolver,
  type DataResource,
  type WriteCtx,
} from './resource-core'
import {
  type CellValue,
  type ImportMode,
  type ResourceDescriptor,
  type ResourceField,
  type ResourceRefTarget,
  type WriteOutcome,
} from './types'

// Drizzle treats bare JS arrays in SQL templates as row constructors. Keep
// array-valued setup fields as a single driver parameter for PostgreSQL.
const bindSetupValue = (value: unknown) => Array.isArray(value) ? sql.param(value) : value
/**
 * Pay-schedule calendar integrity on the import path (I5-platform-158). The
 * interactive editor refuses a frequency/periods-per-year mismatch because
 * statutory annualization uses periods-per-year as factor P, but the import
 * writer applied only generic coercion — so a monthly schedule with 24
 * periods imported cleanly and mis-withheld every pay. Run the same merged
 * validator the editor uses, on both preview and commit, before anything is
 * persisted: built columns win, the stored row fills gaps on update (exactly
 * the editor's body-over-current merge), and an unknowable pair is skipped
 * the way the editor skips it rather than refused.
 */
async function payScheduleImportProblem(
  entityKey: string,
  built: Coerced[],
  current: { frequency: unknown; periods_per_year: unknown } | null,
): Promise<string | null> {
  if (entityKey !== 'pay-schedules') return null
  const col = (name: string) => built.find((c) => c.column === name)?.value
  const frequency = String(col('frequency') ?? (current?.frequency as string | null) ?? '')
  const periodsPerYear = Number(col('periods_per_year') ?? current?.periods_per_year)
  if (!Number.isFinite(periodsPerYear)) return null
  return payPeriodsPerYearProblem(frequency, periodsPerYear)
}

async function loadPayScheduleCurrent(
  orgId: string,
  existingId: string,
): Promise<{ frequency: unknown; periods_per_year: unknown } | null> {
  const current = (await db.execute(sql`
    select frequency, periods_per_year from pay_schedules
     where id = ${existingId} and org_id = ${orgId}
     limit 1`)) as { rows: { frequency: unknown; periods_per_year: unknown }[] }
  return current.rows[0] ?? null
}

// --- Setup-registry resources -------------------------------------------------

const SETUP_KIND_MAP: Record<SetupField['kind'], ResourceField['kind']> = {
  text: 'text',
  country: 'select',
  textarea: 'long_text',
  integer: 'number',
  decimal: 'number',
  percent: 'percent',
  boolean: 'boolean',
  date: 'date',
  select: 'select',
  ref: 'reference',
  multiref: 'multiselect',
  json: 'long_text',
  // String-list fields round-trip through the shared setup coercer.
  stringArray: 'long_text',
}

function refNaturalKey(ref: string): string {
  if (ref === 'accounts') return 'number'
  const entity = SETUP_ENTITY_BY_KEY.get(ref)
  return entity?.naturalKey ?? 'id'
}

/** A ref target whose rows are referenced by natural key (the stored value
 *  IS the key, e.g. a registration's form code) — never resolved to a row
 *  id on import nor to a label on export. */
function refTargetStoresKey(ref: string): boolean {
  return (SETUP_ENTITY_BY_KEY.get(ref)?.refValue ?? null) !== null
}

/**
 * Rows for the setup entities whose records live in org settings JSON
 * rather than in a table of their own. Their registry entry still names
 * table 'orgs' so the rest of the registry works, which means the plain
 * SELECT path would ask orgs for columns it does not have.
 *
 * The switch is exhaustive on purpose. home-announcements was added as a
 * second dataSource and this dispatcher still had only the one arm, so
 * exporting announcements asked `select title, body, audience, starts_on,
 * ends_on from orgs` and the whole resource matrix failed. The `never`
 * below turns the next one into a compile error instead.
 */
async function jsonBackedRows(
  source: NonNullable<SetupEntity['dataSource']>,
  orgId: string,
  resourceLabel: string,
): Promise<Record<string, unknown>[]> {
  switch (source) {
    case 'extension-settings':
      // In-memory sources have no LIMIT clause, so the sentinel gate runs
      // here: refuse rather than slice silently.
      return enforceExportRowLimit(
        (await loadExtensionSettingRows(orgId)) as Record<string, unknown>[],
        resourceLabel,
      )
    case 'home-announcements': {
      // The exporter reads raw[toSnake(fieldKey)]; this loader hands back
      // the camelCase record shape, so the keys are translated here and
      // not in the domain module.
      const rows = await loadHomeAnnouncementRows(orgId)
      return enforceExportRowLimit(rows, resourceLabel).map((row) => {
        const out: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(row)) out[toSnake(key)] = value
        return out
      })
    }
    default: {
      const unreachable: never = source
      throw new Error(`setup data source ${String(unreachable)} has no export arm`)
    }
  }
}

function setupFields(entity: SetupEntity): ResourceField[] {
  return entity.fields
    .filter((f) => f.kind !== 'multiref') // join-table fields aren't bulk-importable yet
    .map((f) => ({
      key: f.key,
      label: f.key,
      kind: SETUP_KIND_MAP[f.kind],
      required: f.required,
      options: f.kind === 'country'
        ? COUNTRY_CODES.map((code) => ({ value: code, label: code }))
        : f.options?.map((o) => ({ value: o.value, label: o.value })),
      // Only true reference fields resolve natural keys → ids on import. A
      // stringArray's `ref` is merely its type-ahead corpus — the values ARE
      // the stored strings. Likewise a ref whose target declares `refValue`
      // stores the natural key itself (a registration's returnFormCode IS
      // the form code): resolving it to a row id would write a uuid the
      // engine can never match, silently unlinking the row.
      ref: f.kind === 'ref' && f.ref && !refTargetStoresKey(f.ref)
        ? { resource: f.ref, by: refNaturalKey(f.ref) }
        : undefined,
    }))
}

export function setupDescriptor(entity: SetupEntity): ResourceDescriptor {
  return {
    key: entity.key,
    label: entity.key,
    group: 'Setup',
    iconKey: entity.iconKey || 'sliders',
    readPermission: 'admin.setup.manage',
    writePermission: 'admin.setup.manage',
    supportsImport: !entity.readOnly && !entity.dataSource,
    naturalKey: entity.naturalKey,
  }
}

async function gatedSetupEntity(entity: SetupEntity, orgId: string): Promise<SetupEntity> {
  const features = await resolvedFeatureState(orgId)
  const gated = setupEntityForFeatureState(entity, {
    multiSubsidiary: featureEnabled(features, 'multiSubsidiary'),
    equipment: featureEnabled(features, 'equipment'),
    fieldTickets: featureEnabled(features, 'fieldTickets'),
  })
  return entity.key === 'item-rate-books' && !featureEnabled(features, 'multiCurrency')
    ? { ...gated, fields: gated.fields.filter((field) => field.key !== 'currency') }
    : gated
}

export function setupResource(entity: SetupEntity, orgId: string): DataResource {
  return {
    descriptor: setupDescriptor(entity),
    async fields() {
      return setupFields(await gatedSetupEntity(entity, orgId))
    },
    async columns() {
      return setupFields(await gatedSetupEntity(entity, orgId)).map((f) => ({ key: f.key, label: f.label }))
    },
    async read() {
      const fields = setupFields(await gatedSetupEntity(entity, orgId))
      const resolver = new RefResolver(orgId)
      const cols = fields.map((f) => toSnake(f.key))
      const resourceLabel = setupDescriptor(entity).label
      const result = entity.dataSource
        ? { rows: await jsonBackedRows(entity.dataSource, orgId, resourceLabel) }
        : (await db.execute(sql`
        select ${setupReadProjection(entity, cols)}
          from ${setupReadSource(entity)}
         ${entity.orgScoped ? sql`where org_id = ${orgId}` : sql``}
         order by ${sql.raw(idColumn(entity))}
         limit ${MAX_EXPORT_ROWS + 1}`)) as { rows: Record<string, unknown>[] }
      // Sentinel read: one row past the cap proves overflow; exactly at the
      // cap proves completeness. Refuse rather than truncate silently.
      if (!entity.dataSource) enforceExportRowLimit(result.rows, resourceLabel)
      const out: Record<string, CellValue>[] = []
      for (const raw of result.rows) {
        const row: Record<string, CellValue> = {}
        for (const f of fields) row[f.key] = await exportCell(f, raw[toSnake(f.key)], resolver)
        out.push(row)
      }
      return { fields, columns: fields.map((f) => ({ key: f.key, label: f.label })), rows: out }
    },
    async write(rows, mode, ctx) {
      const refuse = (message: string): WriteOutcome => ({
        created: 0, updated: 0, failed: rows.length,
        errors: rows.map((_, index) => ({ row: index + 1, message })),
      })
      if (entity.readOnly) return refuse('resource is read-only')
      if (entity.dataSource) return refuse('Use the module settings drawer for audited value changes')
      if (ctx.orgId !== orgId) return refuse('resource belongs to another organization')
      return withOrgTransaction(orgId, async () => {
        // Keep discovery, field validation and every row savepoint on the same
        // connection. A disable either precedes this import or waits for its
        // entire transaction, including the import job's audit evidence.
        await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${featureGateLockKey(orgId)}, 0))`)
        const features = await resolvedFeatureState(orgId)
        if (entity.featureKey && !featureEnabled(features, entity.featureKey)) return refuse('resource is not available')
        const gated = await gatedSetupEntity(entity, orgId)
        const available = new Set(gated.fields.map((field) => field.key))
        const unavailable = entity.fields.filter((field) => !available.has(field.key)).map((field) => field.key)
        if (!ctx.dryRun) return writeSetup(gated, rows, mode, ctx, unavailable)
        // A preview exercises the same storage constraints, policy guards and
        // audit writes as commit. Keep earlier rows visible to later rows in
        // this batch, then discard the entire batch without rolling back the
        // caller's surrounding import transaction or its job evidence.
        await db.execute(sql`savepoint setup_import_preview`)
        try {
          return await writeSetup(gated, rows, mode, { ...ctx, dryRun: false }, unavailable)
        } finally {
          await db.execute(sql`rollback to savepoint setup_import_preview`)
          await db.execute(sql`release savepoint setup_import_preview`)
        }
      })
    },
  }
}

/**
 * Pack-declaration fence for setup imports, mirroring the interactive setup
 * route (web/lib/setup/write.ts). The DB constraints on pay_components and
 * payroll_filing_accounts are shape-only by design, so the pack registry is
 * asked at the API boundary for creates and edits alike — against the MERGED
 * row (submitted columns over the stored row on update), never the raw
 * submission alone. Runs inside writeSetup, so import preview (which
 * exercises writeSetup under a savepoint) and commit share the refusal.
 */
async function setupPackProblem(
  entity: SetupEntity,
  cols: readonly Coerced[],
  existingId: string | null,
  orgId: string,
): Promise<string | null> {
  if (entity.key !== 'pay-components' && entity.key !== 'payroll-filing-accounts') return null
  const col = (name: string): unknown => cols.find((c) => c.column === name)?.value
  let current: Record<string, unknown> | null = null
  if (existingId) {
    const found = (await db.execute(entity.key === 'pay-components'
      ? sql`select country, tax_treatment from pay_components where id = ${existingId} and org_id = ${orgId}`
      : sql`select country, program_type, state_code from payroll_filing_accounts where id = ${existingId} and org_id = ${orgId}`)) as {
      rows: Record<string, unknown>[]
    }
    current = found.rows[0] ?? null
    if (!current) return 'row no longer exists'
  }
  if (entity.key === 'pay-components') {
    return payComponentTreatmentProblem({
      country: (col('country') as string | null | undefined)
        ?? (current?.country as string | null | undefined)
        ?? null,
      taxTreatment: (col('tax_treatment') as string | null | undefined)
        ?? (current?.tax_treatment as string | null | undefined)
        ?? null,
    })
  }
  const rawState = col('state_code') !== undefined ? col('state_code') : current?.state_code
  return filingAccountProblem({
    country: String(col('country') ?? current?.country ?? ''),
    programType: String(col('program_type') ?? current?.program_type ?? ''),
    stateCode: rawState == null || rawState === '' ? null : String(rawState),
  })
}

/**
 * Bulk insert/upsert into a Setup-registry table. Mirrors the interactive
 * route (api/admin/setup/[entity]): coerce via the shared registry validator,
 * resolve reference columns from natural keys, match update-vs-insert by the
 * entity's natural key, stamp org/actor columns, and audit every write. Each
 * mutation and its actual stored-row snapshot are committed together; the
 * row savepoint keeps one failed audit from leaking a configuration change or
 * aborting the import's outer transaction.
 */
async function writeSetup(
  entity: SetupEntity,
  rows: Record<string, unknown>[],
  mode: ImportMode,
  ctx: WriteCtx,
  unavailableFields: readonly string[],
): Promise<WriteOutcome> {
  const resolver = new RefResolver(ctx.orgId)
  const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
  // Refs whose target stores the natural key itself (refValue) are stored
  // verbatim — resolving them to row ids would corrupt the stored value.
  const refFields = entity.fields.filter((f) => f.kind === 'ref' && f.ref && !refTargetStoresKey(f.ref))

  for (let i = 0; i < rows.length; i++) {
    const rowNo = i + 1
    const src = { ...rows[i] }
    try {
      const unavailable = unavailableFields.find((key) => src[key] !== undefined && src[key] !== null && src[key] !== '')
      if (unavailable) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: `${unavailable} is not available` })
        continue
      }
      if (entity.key === 'pay-components' && src.supplementalWageCategory != null && src.supplementalWageCategory !== '') {
        const kind = String(src.kind ?? '')
        const nonPeriodic = coerceBoolean(src.nonPeriodic)
        if (kind !== 'earning' || !nonPeriodic) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: 'supplemental wage category requires a non-periodic earning' })
          continue
        }
      }

      // Resolve reference columns (natural key → uuid) before coercion.
      let refError: string | null = null
      for (const rf of refFields) {
        const human = src[rf.key]
        if (human === undefined || human === null || human === '') continue
        const target: ResourceRefTarget = { resource: rf.ref!, by: refNaturalKey(rf.ref!) }
        const id = await resolver.resolveId(target, human)
        if (!id) {
          refError = `${rf.key}: "${String(human)}" not found`
          break
        }
        src[rf.key] = id
      }
      if (refError) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: refError })
        continue
      }

      // Does a row with this natural key already exist? A row without its
      // natural key has no identity and would duplicate on every re-import,
      // so keyed entities refuse it outright (entities without a natural key
      // match nothing and insert, as before).
      let existingId: string | null = null
      if (entity.naturalKey) {
        const nkVal = String(src[entity.naturalKey] ?? '').trim()
        if (!nkVal) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: `${entity.naturalKey} is required` })
          continue
        }
        {
          const orgFilter = entity.orgScoped ? sql` and org_id = ${ctx.orgId}` : sql``
          const dup = (await db.execute(sql`
            select ${sql.raw(idColumn(entity))} as id from ${sql.raw(entity.table)}
             where ${sql.raw(toSnake(entity.naturalKey))} = ${nkVal}${orgFilter} limit 1`)) as {
            rows: { id: string }[]
          }
          existingId = dup.rows[0]?.id ?? null
        }
      }

      if (existingId && mode === 'insert') {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: `already exists (${entity.naturalKey}=${String(src[entity.naturalKey!])})` })
        continue
      }

      // Domain invariants the generic coercer cannot express run on the
      // merged import row exactly as the interactive writer runs them — in
      // preview and commit alike, before any persistence. The read sees the
      // same committed state the row write below will see.
      if (entity.key === 'tax-codes') {
        const problem = await validateEntityIntegrity(entity, src, ctx.orgId, existingId ?? undefined)
        if (problem) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: problem })
          continue
        }
      }

      if (isSetupBookEntity(entity)) {
        const built = buildRow(entity, src, { forCreate: !existingId })
        if ('error' in built) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: built.error })
          continue
        }
        const bookInput = { ...src }
        for (const key of unavailableFields) delete bookInput[key]
        await db.transaction(async (tx) => {
          await tx.execute(sql`savepoint setup_import_row`)
          try {
            await saveSetupBook(entity, ctx.orgId, ctx.actorId, bookInput, tx, {
              id: existingId ?? undefined, source: 'import', dryRun: ctx.dryRun,
            })
            await tx.execute(sql`release savepoint setup_import_row`)
          } catch (error) {
            await tx.execute(sql`rollback to savepoint setup_import_row`)
            await tx.execute(sql`release savepoint setup_import_row`)
            throw error
          }
        })
        if (existingId) outcome.updated++
        else outcome.created++
        continue
      }

      if (existingId) {
        const built = buildRow(entity, src, { forCreate: false })
        if ('error' in built) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: built.error })
          continue
        }
        const updatePackProblem = await setupPackProblem(entity, built.cols, existingId, ctx.orgId)
        if (updatePackProblem) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: updatePackProblem })
          continue
        }
        // I5-platform-155: a class under a misspelled or inactive regime (or
        // an incomplete MACRS class) must fail import exactly as the
        // interactive writer refuses it — same merged-row validator.
        if (entity.key === 'tax-pool-classes') {
          const classProblem = await validateEntityIntegrity(entity, src, ctx.orgId, existingId ?? undefined)
          if (classProblem) {
            outcome.failed++
            outcome.errors.push({ row: rowNo, message: classProblem })
            continue
          }
        }
        const scheduleProblem = await payScheduleImportProblem(
          entity.key,
          built.cols,
          entity.key === 'pay-schedules' ? await loadPayScheduleCurrent(ctx.orgId, existingId) : null,
        )
        if (scheduleProblem) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: scheduleProblem })
          continue
        }
        const supplementalWageCategory = built.cols.find((column) => column.column === 'supplemental_wage_category')?.value
        const storageCols = entity.key === 'pay-components'
          ? built.cols.filter((column) => column.column !== 'supplemental_wage_category')
          : built.cols
        if (!ctx.dryRun) {
          await db.transaction(async (tx) => {
            // The import route owns an outer org transaction. A nested
            // db.transaction participates in that unit, so this savepoint is
            // what lets one failed row roll back without stranding later rows
            // in an aborted transaction.
            await tx.execute(sql`savepoint setup_import_row`)
            try {
              const orgFilter = entity.orgScoped ? sql` and org_id = ${ctx.orgId}` : sql``
              const before = await loadSetupAuditRow(entity, ctx.orgId, existingId, tx, true)
              if (!before) throw new Error('row no longer exists')

              const setParts = storageCols.map((c) => sql`${sql.raw(c.column)} = ${bindSetupValue(c.value)}`)
              if (entity.actorCols) {
                setParts.push(sql`updated_by = ${ctx.actorId}`)
                setParts.push(sql`updated_at = now()`)
              }
              if (setParts.length > 0) {
                const updated = (await tx.execute(sql`
                  update ${sql.raw(entity.table)} set ${sql.join(setParts, sql`, `)}
                   where ${sql.raw(idColumn(entity))} = ${existingId}${orgFilter}
                  returning *`)) as { rows: Record<string, unknown>[] }
                if (!updated.rows[0]) throw new Error('row no longer exists')
                if (entity.key === 'pay-components' && src.supplementalWageCategory !== undefined) {
                  const classification = await tx.execute(sql`
                    update pay_component_earning_classifications
                       set supplemental_wage_category = ${supplementalWageCategory == null ? null : String(supplementalWageCategory)}
                     where org_id = ${ctx.orgId} and pay_component_id = ${existingId}
                    returning pay_component_id`)
                  if (!classification.rows.length) throw new Error('pay component classification is missing')
                }
                await audit(
                  {
                    orgId: entity.orgScoped ? ctx.orgId : null,
                    table: entity.table,
                    rowId: existingId,
                    action: 'update',
                    changes: {
                      source: 'import',
                      before,
                      after: await loadSetupAuditRow(entity, ctx.orgId, existingId, tx),
                    },
                    actorId: ctx.actorId,
                  },
                  tx,
                )
              }
              await tx.execute(sql`release savepoint setup_import_row`)
            } catch (error) {
              await tx.execute(sql`rollback to savepoint setup_import_row`)
              await tx.execute(sql`release savepoint setup_import_row`)
              throw error
            }
          })
        }
        outcome.updated++
      } else {
        const built = buildRow(entity, src, { forCreate: true })
        if ('error' in built) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: built.error })
          continue
        }
        const insertPackProblem = await setupPackProblem(entity, built.cols, null, ctx.orgId)
        if (insertPackProblem) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: insertPackProblem })
          continue
        }
        // I5-platform-155: same merged-row validator as the update branch —
        // preview and commit share the refusal through the row path.
        if (entity.key === 'tax-pool-classes') {
          const classProblem = await validateEntityIntegrity(entity, src, ctx.orgId, undefined)
          if (classProblem) {
            outcome.failed++
            outcome.errors.push({ row: rowNo, message: classProblem })
            continue
          }
        }
        const scheduleProblem = await payScheduleImportProblem(entity.key, built.cols, null)
        if (scheduleProblem) {
          outcome.failed++
          outcome.errors.push({ row: rowNo, message: scheduleProblem })
          continue
        }
        const supplementalWageCategory = built.cols.find((column) => column.column === 'supplemental_wage_category')?.value
        const storageCols = entity.key === 'pay-components'
          ? built.cols.filter((column) => column.column !== 'supplemental_wage_category')
          : built.cols
        if (!ctx.dryRun) {
          await db.transaction(async (tx) => {
            // See the update branch: this savepoint is required when the
            // caller already owns the import's outer transaction.
            await tx.execute(sql`savepoint setup_import_row`)
            try {
              const cols = [...storageCols]
              if (entity.orgScoped) cols.push({ column: 'org_id', value: ctx.orgId })
              if (entity.actorCols) {
                cols.push({ column: 'created_by', value: ctx.actorId })
                cols.push({ column: 'updated_by', value: ctx.actorId })
              }
              const colSql = sql.raw(cols.map((c) => c.column).join(', '))
              const valSql = sql.join(
                cols.map((c) => sql`${bindSetupValue(c.value)}`),
                sql`, `,
              )
              const ins = (await tx.execute(sql`
                insert into ${sql.raw(entity.table)} (${colSql}) values (${valSql})
                returning *`)) as { rows: Record<string, unknown>[] }
              const inserted = ins.rows[0]
              const rowId = String(inserted?.[idColumn(entity)] ?? '')
              if (!inserted || !rowId) throw new Error('insert did not return a row')
              if (entity.key === 'pay-components' && supplementalWageCategory !== undefined) {
                const classification = await tx.execute(sql`
                  update pay_component_earning_classifications
                     set supplemental_wage_category = ${supplementalWageCategory == null ? null : String(supplementalWageCategory)}
                   where org_id = ${ctx.orgId} and pay_component_id = ${rowId}
                  returning pay_component_id`)
                if (!classification.rows.length) throw new Error('pay component classification is missing')
              }
              await audit(
                {
                  orgId: entity.orgScoped ? ctx.orgId : null,
                  table: entity.table,
                  rowId,
                  action: 'insert',
                  changes: { source: 'import', before: null, after: await loadSetupAuditRow(entity, ctx.orgId, rowId, tx) },
                  actorId: ctx.actorId,
                },
                tx,
              )
              await tx.execute(sql`release savepoint setup_import_row`)
            } catch (error) {
              await tx.execute(sql`rollback to savepoint setup_import_row`)
              await tx.execute(sql`release savepoint setup_import_row`)
              throw error
            }
          })
        }
        outcome.created++
      }
    } catch (e) {
      outcome.failed++
      // Drizzle wraps the driver error, so the storage guard's message lives
      // on `cause` — surface that, never the wrapper's query echo.
      const cause = (e as { cause?: { message?: string } })?.cause
      const raw = cause?.message ?? (e as { message?: string })?.message ?? 'write failed'
      // A unique violation on import unambiguously means the row is already
      // there: the natural-key lookup found nothing only because the entity's
      // identity is composite (stock-locations, bom-components). Refuse it as
      // a duplicate naming the constraint instead of echoing storage text.
      const dup = /duplicate key value violates unique constraint "([^"]+)"/.exec(raw)
      outcome.errors.push({ row: rowNo, message: dup ? `already exists (${dup[1]})` : raw })
    }
  }
  return outcome
}
