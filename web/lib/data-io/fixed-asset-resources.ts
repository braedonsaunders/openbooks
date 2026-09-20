import 'server-only'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { buildAllSchedules } from '@openbooks/engine/src/assets/depreciation.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { cmp, normalizeMoney, toUnits } from '@openbooks/engine/src/money/money.ts'
import { canonicalDecimal } from '../exact-decimal'
import {
  RefResolver,
  subsidiaryReadFilter,
  type DataResource,
  type ReadCtx,
  type WriteCtx,
} from './resource-core'
import type { CellValue, ResourceDescriptor, ResourceField, WriteOutcome } from './types'

/**
 * Fixed assets as an import/export resource, including the mid-life
 * onboarding carry-in (migration 0156).
 *
 * A tenant arriving with years of history in a legacy system has a whole
 * register to load — dozens or hundreds of assets, each with an original
 * cost, an in-service date, and an accumulated figure measured through the
 * cutover. Typing those into the drawer one asset at a time is how a row
 * gets skipped, and a skipped row is a whole asset missing from the books.
 * So the bulk path is the generic import/export machinery — the same mapping
 * wizard, dry-run preview and CSV/XLSX/JSON parsers every other resource
 * uses — rather than a bespoke uploader with its own file handling.
 *
 * Every write goes through the same validators the flyout API uses
 * (exact money, set-together opening figures, basis cap, in-service-month
 * fence, posted-history lock), and an in-service row rebuilds its schedule
 * through the engine — so an import cannot bypass the continuation contract
 * and pre-cutover months are never caught up or double counted.
 */

const MAX_EXPORT_ROWS = 50_000

export const FIXED_ASSETS_KEY = 'fixed-assets'

export const FIXED_ASSETS_DESCRIPTOR: ResourceDescriptor = {
  key: FIXED_ASSETS_KEY,
  label: 'Fixed assets',
  group: 'Master data',
  iconKey: 'landmark',
  readPermission: 'assets.read',
  writePermission: 'assets.manage',
  supportsImport: true,
  naturalKey: 'assetNumber',
  scopedWrite: true,
}

const METHODS = ['straight_line', 'declining_balance', 'manual', 'units_of_production'] as const
const CONVENTIONS = ['full_month', 'half_month', 'stub_day', 'prorated'] as const
const STATUSES = ['draft', 'in_service'] as const

const FIELDS: ResourceField[] = [
  { key: 'assetNumber', label: 'Asset number', kind: 'text', required: true },
  { key: 'name', label: 'Asset name', kind: 'text', required: true },
  { key: 'description', label: 'Description', kind: 'long_text' },
  { key: 'category', label: 'Category (name)', kind: 'text', required: true },
  { key: 'subsidiary', label: 'Subsidiary (name)', kind: 'text', ref: { resource: 'subsidiaries', by: 'name' } },
  { key: 'acquisitionCost', label: 'Acquisition cost', kind: 'currency', required: true },
  { key: 'salvageValue', label: 'Salvage value', kind: 'currency' },
  { key: 'acquiredOn', label: 'Acquired on (YYYY-MM-DD)', kind: 'date' },
  { key: 'inServiceOn', label: 'In service on (YYYY-MM-DD)', kind: 'date' },
  {
    key: 'status', label: 'Status', kind: 'select', required: true,
    options: [
      { value: 'draft', label: 'Draft' },
      { value: 'in_service', label: 'In service' },
    ],
  },
  {
    key: 'method', label: 'Depreciation method', kind: 'select', required: true,
    options: [
      { value: 'straight_line', label: 'Straight line' },
      { value: 'declining_balance', label: 'Declining balance' },
      { value: 'manual', label: 'Manual (evidence based)' },
      { value: 'units_of_production', label: 'Units of production' },
    ],
  },
  { key: 'lifeMonths', label: 'Useful life (months)', kind: 'number' },
  { key: 'ratePercent', label: 'Declining rate (%/year)', kind: 'percent' },
  {
    key: 'convention', label: 'Convention', kind: 'select',
    options: [
      { value: 'full_month', label: 'Full month' },
      { value: 'half_month', label: 'Half month' },
      { value: 'stub_day', label: 'Stub day' },
      { value: 'prorated', label: 'Prorated' },
    ],
  },
  { key: 'unitsTotal', label: 'Lifetime units', kind: 'number' },
  { key: 'assetAccount', label: 'Asset account (number)', kind: 'reference', required: true, ref: { resource: 'accounts', by: 'number' } },
  { key: 'accumAccount', label: 'Accumulated depreciation account (number)', kind: 'reference', required: true, ref: { resource: 'accounts', by: 'number' } },
  { key: 'expenseAccount', label: 'Depreciation expense account (number)', kind: 'reference', required: true, ref: { resource: 'accounts', by: 'number' } },
  { key: 'openingAccumulated', label: 'Opening accumulated depreciation', kind: 'currency' },
  { key: 'openingAsOf', label: 'Opening as-of date (YYYY-MM-DD)', kind: 'date' },
  { key: 'serialNumber', label: 'Serial number', kind: 'text' },
]

function cell(src: Record<string, unknown>, key: string): string {
  const raw = src[key]
  if (raw === null || raw === undefined) return ''
  return String(raw).trim()
}

function moneyCell(label: string, raw: string, opts?: { required?: boolean; allowNegative?: boolean }): string | null {
  if (!raw) {
    if (opts?.required) throw new Error(`${label} is required`)
    return null
  }
  const cleaned = raw.replace(/[,$\s]/g, '')
  const exact = canonicalDecimal(cleaned, 4)
  if (exact === null) throw new Error(`${label} must be an exact decimal (got "${raw}")`)
  let amount: string
  try {
    amount = normalizeMoney(exact)
  } catch {
    throw new Error(`${label} must be an exact decimal (got "${raw}")`)
  }
  if (!opts?.allowNegative && cmp(amount, '0') < 0) throw new Error(`${label} must be non-negative`)
  return amount
}

function dateCell(label: string, raw: string, opts?: { required?: boolean }): string | null {
  if (!raw) {
    if (opts?.required) throw new Error(`${label} is required`)
    return null
  }
  if (!isIsoCalendarDate(raw)) throw new Error(`${label} must be a real calendar date (YYYY-MM-DD)`)
  return raw
}

function intCell(label: string, raw: string, opts?: { required?: boolean; min?: number; max?: number }): number | null {
  if (!raw) {
    if (opts?.required) throw new Error(`${label} is required`)
    return null
  }
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a whole number (got "${raw}")`)
  const value = Number(raw)
  if (opts?.min !== undefined && value < opts.min) throw new Error(`${label} must be at least ${opts.min}`)
  if (opts?.max !== undefined && value > opts.max) throw new Error(`${label} must be at most ${opts.max}`)
  return value
}

/** Asset categories have no import surface of their own: resolve by name, refuse ambiguity. */
async function resolveCategory(orgId: string, raw: string): Promise<string> {
  const name = raw.trim()
  if (!name) throw new Error('Category (name) is required')
  const matches = (await db.execute<{ id: string }>(sql`
    select id from asset_categories where org_id = ${orgId} and lower(name) = lower(${name}) limit 2`))
    .rows
  if (matches.length === 0) {
    throw new Error(`unknown asset category "${name}" — create it under Fixed assets first`)
  }
  if (matches.length > 1) throw new Error(`asset category "${name}" matches more than one category`)
  return matches[0]!.id
}

async function rootSubsidiaryId(orgId: string): Promise<string> {
  const found = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries
     where org_id = ${orgId} and parent_id is null and not is_elimination and is_active
     order by name limit 1`)).rows[0]
  if (!found) throw new Error('no active root subsidiary exists to own the asset')
  return found.id
}

interface ParsedAsset {
  assetNumber: string
  name: string
  description: string | null
  categoryId: string
  subsidiaryId: string
  acquisitionCost: string
  salvageValue: string
  acquiredOn: string | null
  inServiceOn: string | null
  status: (typeof STATUSES)[number]
  /** Null only when keeping a stored custom formula method (drawer-only, never chosen by import). */
  method: string | null
  lifeMonths: number | null
  ratePercent: string | null
  convention: (typeof CONVENTIONS)[number]
  unitsTotal: string | null
  assetAccountId: string
  accumAccountId: string
  expenseAccountId: string
  openingAccumulated: string | null
  openingAsOf: string | null
  serialNumber: string | null
}

async function parseRow(
  orgId: string,
  src: Record<string, unknown>,
  resolver: RefResolver,
  stored: StoredAsset | null,
): Promise<ParsedAsset> {
  const assetNumber = cell(src, 'assetNumber')
  if (!assetNumber) throw new Error('Asset number is required')
  // Blank-keeps-stored: an export re-imported verbatim must be a no-op, so
  // blank cells fall back to the stored row (inserts fall back to the product
  // defaults, then the required checks below fire). This also protects rows
  // whose custom formula method has no import spelling: the method cell
  // exports blank and stays untouched.
  const name = cell(src, 'name') || stored?.name || null
  if (!name) throw new Error('Asset name is required')
  const categoryRaw = cell(src, 'category')
  const categoryId = categoryRaw
    ? await resolveCategory(orgId, categoryRaw)
    : (stored?.category_id ?? null)
  if (!categoryId) throw new Error('Category (name) is required')

  const subsidiaryRaw = cell(src, 'subsidiary')
  const subsidiaryId = subsidiaryRaw
    ? ((await resolver.resolveId({ resource: 'subsidiaries', by: 'name' }, subsidiaryRaw)) ??
      (() => { throw new Error(`unknown subsidiary "${subsidiaryRaw}"`) })())
    : (stored?.subsidiary_id ?? await rootSubsidiaryId(orgId))

  const costRaw = cell(src, 'acquisitionCost')
  const acquisitionCost = costRaw
    ? moneyCell('Acquisition cost', costRaw, { required: true })!
    : (stored ? String(stored.acquisition_cost) : null)
  if (!acquisitionCost) throw new Error('Acquisition cost is required')
  const salvageRaw = cell(src, 'salvageValue')
  const salvageValue = salvageRaw
    ? moneyCell('Salvage value', salvageRaw)!
    : (stored ? String(stored.salvage_value) : '0.0000')
  if (cmp(salvageValue, acquisitionCost) > 0) throw new Error('Salvage value cannot exceed acquisition cost')

  const acquiredRaw = cell(src, 'acquiredOn')
  const acquiredOn = acquiredRaw ? dateCell('Acquired on', acquiredRaw) : (stored?.acquired_on ?? null)
  const statusCell = cell(src, 'status').toLowerCase()
  if (statusCell && !(STATUSES as readonly string[]).includes(statusCell)) {
    throw new Error(`Status must be draft or in_service (got "${cell(src, 'status')}")`)
  }
  const status = (statusCell || stored?.status || 'draft') as ParsedAsset['status']
  if (stored && stored.status === 'in_service' && status === 'draft') {
    throw new Error('an in-service asset cannot return to draft through import')
  }
  const inServiceRaw = cell(src, 'inServiceOn')
  const inServiceOn = inServiceRaw
    ? dateCell('In service on', inServiceRaw)
    : (stored?.in_service_on ?? null)
  if (status === 'in_service' && !inServiceOn) throw new Error('In service on is required for in-service assets')

  const methodCell = cell(src, 'method').toLowerCase()
  if (methodCell && !(METHODS as readonly string[]).includes(methodCell)) {
    throw new Error(`Depreciation method must be one of ${METHODS.join(', ')} (got "${cell(src, 'method')}")`)
  }
  // A null method is a custom formula method (drawer-only): it validates
  // nothing here and can only be kept, never chosen. Inserts default a blank
  // method to straight line; updates keep the stored one.
  const method: string | null = methodCell || stored?.depreciation_method || (!stored ? 'straight_line' : null)
  const methodChanged = !!stored && !!methodCell && methodCell !== stored.depreciation_method
  const lifeRaw = cell(src, 'lifeMonths')
  let lifeMonths: number | null
  if (lifeRaw) {
    lifeMonths = intCell('Useful life (months)', lifeRaw, { min: 1 })
  } else if (methodChanged || !stored) {
    lifeMonths = null
  } else {
    lifeMonths = stored.useful_life_months
  }
  if (!stored && method !== 'manual' && method !== null && lifeMonths === null) {
    throw new Error('Useful life (months) is required')
  }
  if (methodChanged && method !== 'manual' && method !== null && lifeMonths === null) {
    throw new Error('Useful life (months) is required when changing the depreciation method')
  }
  const rateRaw = cell(src, 'ratePercent')
  let ratePercent: string | null = null
  if (rateRaw) {
    const cleaned = rateRaw.replace(/[%,\s]/g, '')
    const exact = canonicalDecimal(cleaned, 4)
    if (exact === null) throw new Error('Declining rate must be an exact decimal')
    ratePercent = normalizeMoney(exact)
    if (cmp(ratePercent, '0') <= 0 || cmp(ratePercent, '100') > 0) {
      throw new Error('Declining rate must be above 0 and at most 100')
    }
  } else if (!methodChanged) {
    ratePercent = stored?.depreciation_rate_percent ?? null
  }
  if (method === 'declining_balance' && ratePercent === null) {
    throw new Error('Declining rate (%/year) is required for declining balance')
  }
  const conventionCell = cell(src, 'convention').toLowerCase()
  if (conventionCell && !(CONVENTIONS as readonly string[]).includes(conventionCell)) {
    throw new Error(`Convention must be one of ${CONVENTIONS.join(', ')} (got "${cell(src, 'convention')}")`)
  }
  const convention = (conventionCell || stored?.depreciation_convention || 'full_month') as ParsedAsset['convention']
  const unitsRaw = cell(src, 'unitsTotal')
  let unitsTotal: string | null
  if (unitsRaw) {
    unitsTotal = moneyCell('Lifetime units', unitsRaw)!
  } else if (methodChanged || !stored) {
    unitsTotal = null
  } else {
    unitsTotal = stored.depreciation_units_total
  }
  if (unitsTotal !== null && cmp(unitsTotal, '0') <= 0) throw new Error('Lifetime units must be positive')
  if (method === 'units_of_production' && unitsTotal === null) {
    throw new Error('Lifetime units are required for units of production')
  }

  const requireAccount = async (key: string, label: string, fallback: string | null): Promise<string> => {
    const raw = cell(src, key)
    if (!raw) {
      if (fallback) return fallback
      throw new Error(`${label} is required`)
    }
    const id = await resolver.resolveId({ resource: 'accounts', by: 'number' }, raw)
    if (!id) throw new Error(`unknown account number "${raw}" for ${label}`)
    return id
  }
  const assetAccountId = await requireAccount('assetAccount', 'Asset account (number)', stored?.asset_account_id ?? null)
  const accumAccountId = await requireAccount('accumAccount', 'Accumulated depreciation account (number)', stored?.accumulated_depreciation_account_id ?? null)
  const expenseAccountId = await requireAccount('expenseAccount', 'Depreciation expense account (number)', stored?.depreciation_expense_account_id ?? null)

  // The mid-life carry-in: pre-cutover accumulated plus its as-of date, both
  // or neither, inside the depreciable basis, not before the in-service
  // month — the same contract the flyout API enforces.
  const openingRaw = cell(src, 'openingAccumulated')
  const asOfRaw = cell(src, 'openingAsOf')
  const openingAccumulated = openingRaw
    ? moneyCell('Opening accumulated depreciation', openingRaw)!
    : (stored?.opening_accumulated_depreciation ?? null)
  const openingAsOf = asOfRaw
    ? dateCell('Opening as-of date', asOfRaw)!
    : (stored?.opening_accumulated_as_of ?? null)
  if ((openingAccumulated === null) !== (openingAsOf === null)) {
    throw new Error('Opening accumulated depreciation and its as-of date must be set together')
  }
  if (
    openingAccumulated !== null &&
    toUnits(openingAccumulated) > toUnits(acquisitionCost) - toUnits(salvageValue)
  ) {
    throw new Error('Opening accumulated depreciation cannot exceed cost minus salvage')
  }
  if (
    openingAccumulated !== null &&
    cmp(openingAccumulated, '0') > 0 &&
    inServiceOn !== null &&
    openingAsOf !== null &&
    openingAsOf.slice(0, 7) < inServiceOn.slice(0, 7)
  ) {
    throw new Error('Opening as-of date cannot precede the in-service month')
  }

  return {
    assetNumber,
    name,
    description: cell(src, 'description') || null,
    categoryId,
    subsidiaryId,
    acquisitionCost,
    salvageValue,
    acquiredOn,
    inServiceOn,
    status,
    method,
    lifeMonths,
    ratePercent,
    convention,
    unitsTotal,
    assetAccountId,
    accumAccountId,
    expenseAccountId,
    openingAccumulated,
    openingAsOf,
    serialNumber: cell(src, 'serialNumber') || null,
  }
}

type StoredAsset = {
  id: string
  status: string
  name: string
  description: string | null
  category_id: string
  subsidiary_id: string
  acquisition_cost: string
  salvage_value: string
  acquired_on: string | null
  in_service_on: string | null
  depreciation_method: string | null
  useful_life_months: number | null
  depreciation_rate_percent: string | null
  depreciation_convention: string | null
  depreciation_units_total: string | null
  asset_account_id: string
  accumulated_depreciation_account_id: string
  depreciation_expense_account_id: string
  opening_accumulated_depreciation: string | null
  opening_accumulated_as_of: string | null
  serial_number: string | null
}

async function findMatches(orgId: string, assetNumber: string): Promise<StoredAsset[]> {
  return (await db.execute<StoredAsset>(sql`
    select id, status, name, description, category_id, subsidiary_id,
           acquisition_cost, salvage_value, acquired_on::text, in_service_on::text,
           depreciation_method, useful_life_months, depreciation_rate_percent,
           depreciation_convention, depreciation_units_total,
           asset_account_id, accumulated_depreciation_account_id,
           depreciation_expense_account_id,
           opening_accumulated_depreciation::text as opening_accumulated_depreciation,
           opening_accumulated_as_of::text as opening_accumulated_as_of,
           serial_number
      from fixed_assets
     where org_id = ${orgId} and lower(asset_number) = lower(${assetNumber}) limit 3`)).rows
}

/** Posted lines or lifecycle events fix the figures a re-import may touch. */
async function assetHasHistory(orgId: string, assetId: string): Promise<boolean> {
  const rows = (await db.execute<{ n: string }>(sql`
    select count(*)::text as n from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
     where s.org_id = ${orgId} and s.asset_id = ${assetId} and l.posted_amount is not null
    union all
    select count(*)::text as n from asset_events where org_id = ${orgId} and asset_id = ${assetId}`)).rows
  return rows.some((r) => r.n !== '0')
}

export function fixedAssetsResource(orgId: string): DataResource {
  return {
    descriptor: FIXED_ASSETS_DESCRIPTOR,
    async fields() {
      return FIELDS
    },
    async columns() {
      return FIELDS.map((f) => ({ key: f.key, label: f.label }))
    },
    async read(readCtx?: ReadCtx) {
      const rows = (await db.execute<Record<string, CellValue>>(sql`
        select a.asset_number as "assetNumber",
               a.name as "name",
               a.description as "description",
               c.name as "category",
               s.name as "subsidiary",
               a.acquisition_cost::text as "acquisitionCost",
               a.salvage_value::text as "salvageValue",
               a.acquired_on::text as "acquiredOn",
               a.in_service_on::text as "inServiceOn",
               a.status as "status",
               a.depreciation_method as "method",
               a.useful_life_months as "lifeMonths",
               a.depreciation_rate_percent::text as "ratePercent",
               a.depreciation_convention as "convention",
               a.depreciation_units_total::text as "unitsTotal",
               aa.number as "assetAccount",
               ad.number as "accumAccount",
               ae.number as "expenseAccount",
               a.opening_accumulated_depreciation::text as "openingAccumulated",
               a.opening_accumulated_as_of::text as "openingAsOf",
               a.serial_number as "serialNumber"
          from fixed_assets a
          join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
          join subsidiaries s on s.id = a.subsidiary_id and s.org_id = a.org_id
          left join accounts aa on aa.id = a.asset_account_id and aa.org_id = a.org_id
          left join accounts ad on ad.id = a.accumulated_depreciation_account_id and ad.org_id = a.org_id
          left join accounts ae on ae.id = a.depreciation_expense_account_id and ae.org_id = a.org_id
         where a.org_id = ${orgId}
           ${subsidiaryReadFilter(sql`a.subsidiary_id`, readCtx?.allowedSubsidiaryIds)}
         order by a.asset_number
         limit ${MAX_EXPORT_ROWS}`)).rows
      return { fields: FIELDS, columns: FIELDS.map((f) => ({ key: f.key, label: f.label })), rows }
    },
    async write(rows, mode, ctx: WriteCtx) {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      const resolver = new RefResolver(orgId)

      for (let index = 0; index < rows.length; index++) {
        const rowNo = index + 1
        const src = rows[index]!
        try {
          const numberCell = cell(src, 'assetNumber')
          if (!numberCell) throw new Error('Asset number is required')
          const matches = await findMatches(ctx.orgId, numberCell)
          if (matches.length > 1) {
            throw new Error(`asset number "${numberCell}" matches more than one asset — disambiguate before importing`)
          }
          const stored = matches[0] ?? null
          // Validate in both modes so the wizard's preview is a real preview.
          const parsed = await parseRow(ctx.orgId, src, resolver, stored)
          if (ctx.allowedSubsidiaryIds && !ctx.allowedSubsidiaryIds.has(parsed.subsidiaryId)) {
            throw new Error('the asset’s subsidiary is outside your subsidiary access')
          }
          if (!stored) {
            if (ctx.dryRun) {
              outcome.created++
              continue
            }
            const assetId = randomUUID()
            await db.execute(sql`
              insert into fixed_assets
                (id, org_id, subsidiary_id, category_id, asset_number, name, description, status,
                 acquired_on, in_service_on, acquisition_cost, salvage_value,
                 depreciation_method, useful_life_months, depreciation_rate_percent,
                 depreciation_convention, depreciation_units_total,
                 asset_account_id, accumulated_depreciation_account_id,
                 depreciation_expense_account_id,
                 opening_accumulated_depreciation, opening_accumulated_as_of,
                 serial_number, custom, created_by, updated_by)
              values (${assetId}, ${ctx.orgId}, ${parsed.subsidiaryId}, ${parsed.categoryId},
                      ${parsed.assetNumber}, ${parsed.name}, ${parsed.description}, ${parsed.status},
                      ${parsed.acquiredOn}, ${parsed.inServiceOn}, ${parsed.acquisitionCost}, ${parsed.salvageValue},
                      ${parsed.method}, ${parsed.lifeMonths}, ${parsed.ratePercent},
                      ${parsed.convention}, ${parsed.unitsTotal},
                      ${parsed.assetAccountId}, ${parsed.accumAccountId},
                      ${parsed.expenseAccountId},
                      ${parsed.openingAccumulated}, ${parsed.openingAsOf},
                      ${parsed.serialNumber}, '{}'::jsonb, ${ctx.actorId}, ${ctx.actorId})`)
            if (parsed.status === 'in_service') {
              try {
                await buildAllSchedules(assetId, ctx.orgId, ctx.actorId)
              } catch (error) {
                throw new Error(
                  `schedule build failed: ${error instanceof Error ? error.message : 'unknown error'}`,
                )
              }
            }
            outcome.created++
            continue
          }

          // Update path. parseRow already resolved blank cells to the stored
          // row, so an export re-imported verbatim compares equal here.
          if (mode === 'insert') {
            throw new Error(`asset number "${parsed.assetNumber}" already exists`)
          }
          if (stored.status !== 'draft' && stored.status !== 'in_service') {
            throw new Error(`only draft or in-service assets can be updated by import (status is ${stored.status})`)
          }
          const history = await assetHasHistory(ctx.orgId, stored.id)
          const basisChanged =
            parsed.acquisitionCost !== String(stored.acquisition_cost) ||
            parsed.salvageValue !== String(stored.salvage_value) ||
            (parsed.method ?? null) !== stored.depreciation_method ||
            (parsed.lifeMonths ?? null) !== stored.useful_life_months ||
            (parsed.ratePercent ?? null) !== (stored.depreciation_rate_percent ?? null) ||
            parsed.convention !== (stored.depreciation_convention ?? 'full_month') ||
            (parsed.unitsTotal ?? null) !== (stored.depreciation_units_total ?? null) ||
            (parsed.openingAccumulated ?? null) !== (stored.opening_accumulated_depreciation ?? null) ||
            (parsed.openingAsOf ?? null) !== (stored.opening_accumulated_as_of ?? null) ||
            parsed.categoryId !== stored.category_id ||
            parsed.assetAccountId !== stored.asset_account_id ||
            parsed.accumAccountId !== stored.accumulated_depreciation_account_id ||
            parsed.expenseAccountId !== stored.depreciation_expense_account_id ||
            parsed.subsidiaryId !== stored.subsidiary_id ||
            (parsed.inServiceOn ?? null) !== (stored.in_service_on ?? null) ||
            parsed.status !== stored.status
          if (history && basisChanged) {
            throw new Error('posted depreciation or lifecycle events already reference this asset — change only name, description, or serial number')
          }
          if (ctx.dryRun) {
            outcome.updated++
            continue
          }
          // Blank-keeps-stored: only overwrite a column when the file spoke.
          await db.execute(sql`
            update fixed_assets
               set name = ${parsed.name},
                   description = ${parsed.description},
                   category_id = ${parsed.categoryId},
                   subsidiary_id = ${parsed.subsidiaryId},
                   acquisition_cost = ${parsed.acquisitionCost},
                   salvage_value = ${parsed.salvageValue},
                   acquired_on = ${parsed.acquiredOn},
                   in_service_on = ${parsed.inServiceOn},
                   status = ${parsed.status},
                   depreciation_method = ${parsed.method},
                   useful_life_months = ${parsed.lifeMonths},
                   depreciation_rate_percent = ${parsed.ratePercent},
                   depreciation_convention = ${parsed.convention},
                   depreciation_units_total = ${parsed.unitsTotal},
                   asset_account_id = ${parsed.assetAccountId},
                   accumulated_depreciation_account_id = ${parsed.accumAccountId},
                   depreciation_expense_account_id = ${parsed.expenseAccountId},
                   opening_accumulated_depreciation = ${parsed.openingAccumulated},
                   opening_accumulated_as_of = ${parsed.openingAsOf},
                   serial_number = ${parsed.serialNumber},
                   updated_by = ${ctx.actorId}
             where id = ${stored.id} and org_id = ${ctx.orgId}`)
          if (parsed.status === 'in_service' && !history) {
            try {
              await buildAllSchedules(stored.id, ctx.orgId, ctx.actorId)
            } catch (error) {
              throw new Error(
                `schedule build failed: ${error instanceof Error ? error.message : 'unknown error'}`,
              )
            }
          }
          outcome.updated++
        } catch (error) {
          outcome.failed++
          outcome.errors.push({
            row: rowNo,
            message: error instanceof Error ? error.message : 'write failed',
          })
        }
      }
      return outcome
    },
  }
}
