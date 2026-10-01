import { importRowError } from './row-error'
import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { ResourcingRefusal } from '@openbooks/engine/src/resourcing/errors.ts'
import { upsertAssignment, validateAssignmentPlan } from '@openbooks/engine/src/resourcing/assignments.ts'
import { loadRetainerKpis } from '../resourcing/retainer-kpis'
import { readEntityListPage } from '../list/entity-reader'
import { findUnownedCustomReferences, loadFieldDefs, unknownCustomFieldKey, validateCustomValues } from '../custom-fields'
import {
  duplicateImportRowIndexes,
  enforceExportRowLimit,
  importRowAction,
  MAX_EXPORT_ROWS,
  orgFeatureEnabled,
  RefResolver,
  type DataResource,
  type ReadCtx,
  type ReadResult,
  type WriteCtx,
} from './resource-core'
import type { CellValue, ImportMode, ResourceDescriptor, ResourceField, RowError, WriteOutcome } from './types'

/**
 * Assignment plan import/export and retainer-balance export.
 *
 * Assignment import delegates per row to the landed `upsertAssignment`
 * writer — the same validator, Sunday fence, decimal refusal, booking
 * rules, custom-field defs, subsidiary lock, and natural-key upsert the
 * assignment API route uses — so a file cannot plant what the drawer
 * refuses. Export reads through the shared entity reader over the
 * `resourcing_assignment` source (the native list predicate and scope),
 * never a second query. Retainer balances are export-only through the
 * landed `loadRetainerKpis` balance source (engine `balanceOf` over posted
 * drawdowns, per currency); balances are never persisted and never totaled
 * across currencies. There is no retainer or drawdown import surface.
 */

export const ASSIGNMENTS_KEY = 'resourcing-assignments'
export const RETAINER_BALANCES_KEY = 'retainer-balances'

export const ASSIGNMENTS_DESCRIPTOR: ResourceDescriptor = {
  key: ASSIGNMENTS_KEY,
  label: 'Assignment plan',
  group: 'Records',
  iconKey: 'clipboard-list',
  readPermission: 'resourcing.read',
  writePermission: 'resourcing.manage',
  supportsImport: true,
  naturalKey: 'project + subject + weekStart',
  scopedWrite: true,
}

export const RETAINER_BALANCES_DESCRIPTOR: ResourceDescriptor = {
  key: RETAINER_BALANCES_KEY,
  label: 'Retainer balances',
  group: 'Records',
  iconKey: 'receipt',
  readPermission: 'retainers.read',
  writePermission: 'retainers.manage',
  supportsImport: false,
  naturalKey: 'currency',
}

const ASSIGNMENT_FIELDS: ResourceField[] = [
  { key: 'project', label: 'Project (code or name)', kind: 'reference', required: true, ref: { resource: 'projects', by: 'code' } },
  { key: 'employee', label: 'Employee (name, number, or id)', kind: 'reference', ref: { resource: 'employees', by: 'name' } },
  { key: 'jobTitle', label: 'Job title (generic booking)', kind: 'text' },
  { key: 'weekStart', label: 'Week starting Sunday (YYYY-MM-DD)', kind: 'date', required: true },
  { key: 'plannedHours', label: 'Planned hours', kind: 'number', required: true },
  {
    key: 'booking', label: 'Booking', kind: 'select',
    options: [{ value: 'soft', label: 'Soft' }, { value: 'hard', label: 'Hard' }],
  },
  { key: 'isBillable', label: 'Billable', kind: 'boolean' },
]

export const RETAINER_BALANCE_FIELDS: ResourceField[] = [
  { key: 'currency', label: 'Currency', kind: 'text' },
  { key: 'balance', label: 'Remaining balance', kind: 'currency' },
  { key: 'drawn', label: 'Drawn (posted)', kind: 'currency' },
]

function cell(src: Record<string, unknown>, key: string): string {
  const value = src[key]
  return value === null || value === undefined ? '' : String(value).trim()
}

type StoredAssignment = {
  id: string
  employee_party_id: string | null
  job_title: string | null
  planned_hours: string
  is_billable: boolean
  booking: string
}

async function findStored(orgId: string, projectId: string, weekStart: string, employeePartyId: string | null, jobTitle: string | null, scope: ReadonlySet<string> | null): Promise<StoredAssignment | null> {
  // The project join pins the row to the caller's scope: out-of-scope rows
  // classify as absent, so dry-run and commit agree before any persistence.
  const scopeCond = scope === null
    ? sql`true`
    : scope.size === 0 ? sql`false` : sql`p.subsidiary_id in (${sql.join([...scope].map((id) => sql`${id}`), sql`, `)})`
  // A separate IS NULL placeholder has no PostgreSQL type when the selected
  // subject is an employee. Choose the exact natural-key predicate instead.
  const subjectCond = employeePartyId === null
    ? sql`a.employee_party_id is null and a.job_title = ${jobTitle}`
    : sql`a.employee_party_id = ${employeePartyId}::uuid`
  const rows = (await db.execute<StoredAssignment>(sql`
    select a.id, a.employee_party_id, a.job_title, a.planned_hours::text, a.is_billable, a.booking
      from res_assignments a inner join projects p on p.id = a.project_id
     where a.org_id = ${orgId} and a.project_id = ${projectId} and a.week_start = ${weekStart}::date
       and (${subjectCond})
       and ${scopeCond}
     limit 1`)).rows
  return rows[0] ?? null
}

async function projectIdByCodeOrName(orgId: string, raw: string, scope: ReadonlySet<string> | null): Promise<string | null> {
  const scopeCond = scope === null
    ? sql`true`
    : scope.size === 0 ? sql`false` : sql`subsidiary_id in (${sql.join([...scope].map((id) => sql`${id}`), sql`, `)})`
  const rows = (await db.execute<{ id: string }>(sql`
    select id from projects where org_id = ${orgId} and (code = ${raw} or name = ${raw}) and ${scopeCond} limit 1`)).rows
  return rows[0]?.id ?? null
}

function duplicateKey(src: Record<string, unknown>): string | null {
  const project = cell(src, 'project')
  const subject = cell(src, 'employee') || cell(src, 'jobTitle')
  const week = cell(src, 'weekStart')
  if (!project || !subject || !week) return null
  return `${project.toLowerCase()}\0${subject.toLowerCase()}\0${week}`
}

export function assignmentPlanResource(orgId: string): DataResource {
  return {
    descriptor: ASSIGNMENTS_DESCRIPTOR,
    fields: async () => ASSIGNMENT_FIELDS,
    columns: async () => ASSIGNMENT_FIELDS.map((f) => ({ key: f.key, label: f.label })),
    read: async (ctx: ReadCtx): Promise<ReadResult> => {
      // The export route gates resourcing.read and threads the actor; the
      // resource rechecks the effective feature and reads through the safe
      // reader only. Context and scope are required own properties, never
      // defaulted: a missing context, an inherited or absent actor, or an
      // omitted scope throws instead of widening to unrestricted. An
      // explicit null scope stays unrestricted.
      if (!ctx || typeof ctx !== 'object') {
        throw new Error('read context is required — the export route threads the acting user into every resource read')
      }
      if (!Object.hasOwn(ctx, 'actorId') || ctx.actorId === undefined) {
        throw new Error('actorId is required — the export route threads the acting user into every resource read')
      }
      if (!Object.hasOwn(ctx, 'allowedSubsidiaryIds') || ctx.allowedSubsidiaryIds === undefined) {
        throw new Error('allowedSubsidiaryIds is required — pass the caller subsidiary scope explicitly')
      }
      if (!(await orgFeatureEnabled(orgId, 'resourcing'))) {
        throw new Error('resourcing feature is disabled — turn on Resourcing under Company Settings → Features to export the assignment plan')
      }
      const scope = ctx.allowedSubsidiaryIds
      const rows: Record<string, CellValue>[] = []
      let page = 1
      for (;;) {
        const result = await readEntityListPage({
          recordType: 'resourcing_assignment',
          orgId,
          actorId: ctx.actorId,
          allowedSubsidiaryIds: scope,
          sort: 'week',
          dir: 'asc',
          page,
          perPage: ctx.page?.size ?? 100,
          ...(ctx.page ? { cursor: { afterId: ctx.page.after } } : {}),
        })
        if (!result.ok) throw new Error(`${result.error}: ${result.remedy}`)
        for (const row of result.rows) {
          rows.push({
            project: (row.project_id as string) ?? '',
            employee: (row.employee_party_id as string) ?? '',
            jobTitle: (row.job_title as string) ?? '',
            weekStart: String(row.week_start ?? ''),
            plannedHours: String(row.planned_hours ?? ''),
            booking: (row.booking as string) ?? '',
            isBillable: row.is_billable === true,
          })
        }
        if (ctx.page) {
          ctx.page.done = !result.cursorHasMore
          ctx.page.next = result.rows.length ? String(result.rows[result.rows.length - 1]!.id) : ctx.page.after
          break
        }
        if (result.rows.length < 100) break
        page += 1
        if (rows.length > MAX_EXPORT_ROWS) break
      }
      if (!ctx.page) enforceExportRowLimit(rows, 'Assignment plan')
      return { fields: ASSIGNMENT_FIELDS, columns: ASSIGNMENT_FIELDS.map((f) => ({ key: f.key, label: f.label })), rows }
    },
    write: async (rows: Record<string, unknown>[], mode: ImportMode, ctx: WriteCtx): Promise<WriteOutcome> => {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      const fail = (index: number, message: string, field?: string) => {
        outcome.failed += 1
        const error: RowError = field === undefined ? { row: index + 1, message } : { row: index + 1, message, field }
        outcome.errors.push(error)
      }
      // Authority runs before any input, lookup, or storage work: the actor,
      // the resourcing.manage grant in the caller's permissions, the
      // authoritative feature, then the caller's explicit scope. Authority
      // outages rethrow — they never read as disabled.
      if (!ctx || typeof ctx !== 'object' || !Object.hasOwn(ctx, 'actorId') || ctx.actorId === undefined) {
        return { created: 0, updated: 0, failed: Math.max(rows.length, 1), errors: [{ row: 0, message: 'actorId is required — the import route threads the acting user into every resource write' }] }
      }
      if (!ctx.permissions || !ctx.permissions.has('resourcing.manage')) {
        return { created: 0, updated: 0, failed: Math.max(rows.length, 1), errors: [{ row: 0, message: 'resourcing.manage is required to import the assignment plan — ask an administrator for the grant, then import again' }] }
      }
      if (!(await orgFeatureEnabled(orgId, 'resourcing'))) {
        for (let index = 0; index < rows.length; index++) {
          fail(index, 'resourcing feature is disabled — turn on Resourcing under Company Settings → Features, then import again')
        }
        return outcome
      }
      // Scope is required, never defaulted: an omitted scope refuses instead
      // of widening to unrestricted. Every lookup below is pinned to it.
      if (!Object.hasOwn(ctx, 'allowedSubsidiaryIds') || ctx.allowedSubsidiaryIds === undefined) {
        return { created: 0, updated: 0, failed: Math.max(rows.length, 1), errors: [{ row: 0, message: 'allowedSubsidiaryIds is required — pass the caller subsidiary scope explicitly' }] }
      }
      // An empty file writes nothing: report it instead of an {ok} no-op.
      if (rows.length === 0) {
        return { created: 0, updated: 0, failed: 1, errors: [{ row: 0, message: 'the file contains no assignment rows — add at least one project booking week' }] }
      }
      const scope = ctx.allowedSubsidiaryIds
      const definitions = await loadFieldDefs('res_assignments')
      const resolver = new RefResolver(orgId)
      const resolvedKeys: (string | null)[] = rows.map(() => null)
      const dupes = duplicateImportRowIndexes(rows.map(duplicateKey))
      for (let index = 0; index < rows.length; index++) {
        const src = rows[index]!
        try {
          if (dupes.has(index)) throw new Error('this project, subject, and week appears more than once in the file — keep one row per booking week')
          const projectRaw = cell(src, 'project')
          if (!projectRaw) throw new Error('Project is required')
          const projectId = (await resolver.resolveId({ resource: 'projects', by: 'code' }, projectRaw))
            ?? await projectIdByCodeOrName(orgId, projectRaw, scope)
          if (!projectId) throw new Error(`unknown project "${projectRaw}" — use the project code or name`)
          const employeeRaw = cell(src, 'employee')
          const jobTitleRaw = cell(src, 'jobTitle')
          const employeePartyId = employeeRaw
            ? ((await resolver.resolveId({ resource: 'employees', by: 'name' }, employeeRaw)) ?? (() => { throw new Error(`unknown employee "${employeeRaw}" — use the name, payroll number, or id`) })())
            : null
          const jobTitle = employeePartyId ? null : jobTitleRaw || null
          if ((employeePartyId === null) === (jobTitle === null)) {
            throw new Error('an assignment must identify exactly one employee or generic job title')
          }
          const weekStart = cell(src, 'weekStart')
          if (!weekStart) throw new Error('Week starting Sunday is required')
          resolvedKeys[index] = JSON.stringify([projectId, employeePartyId, jobTitle, weekStart])
          const customSrc = (src.custom !== undefined ? src.custom : {}) as Record<string, unknown>
          const unknownKey = unknownCustomFieldKey(definitions, customSrc)
          if (unknownKey) throw new Error(`unknown custom field: ${unknownKey}`)
          const validatedCustom = validateCustomValues(definitions, customSrc)
          if (!validatedCustom.ok) throw new Error('correct the highlighted custom fields')
          const unowned = await findUnownedCustomReferences(orgId, definitions, validatedCustom.cleaned)
          if (unowned.length > 0) throw new Error(`custom field "${unowned[0]!.label}" references a record outside this organization`)
          const plannedRaw = cell(src, 'plannedHours')
          const plannedHours = plannedRaw || ''
          if (!plannedHours) throw new Error('Planned hours are required')
          const bookingRaw = cell(src, 'booking').toLowerCase()
          const booking = (bookingRaw || 'hard') as 'soft' | 'hard'
          const billableRaw = cell(src, 'isBillable')
          const candidate = {
            orgId,
            actorId: ctx.actorId,
            allowedSubsidiaryIds: scope,
            projectId,
            weekStart,
            plannedHours,
            booking,
            isBillable: billableRaw === '' ? true : billableRaw.toLowerCase() === 'true',
            custom: validatedCustom.cleaned,
            ...(employeePartyId ? { employeePartyId } : { jobTitle: jobTitle! }),
          }
          // Dry-run and commit share this governed decision — authority,
          // scope, and the canonical writer validation under the pinned org
          // transaction — and differ only at the persistence call below.
          try {
            await withOrgTransaction(orgId, () => validateAssignmentPlan(db, candidate))
          } catch (error) {
            if (error instanceof ResourcingRefusal) throw new Error(`${error.code}: ${error.remedy}`)
            throw error
          }
          const stored = await findStored(orgId, projectId, weekStart, employeePartyId, jobTitle, scope)
          const action = importRowAction(mode, stored !== null)
          if (action === 'conflict') throw new Error(`assignment for "${projectRaw}" in week ${weekStart} already exists`)
          const parsed = candidate
          if (ctx.dryRun) {
            if (stored) outcome.updated += 1
            else outcome.created += 1
            continue
          }
          await upsertAssignment(parsed)
          if (stored) outcome.updated += 1
          else outcome.created += 1
        } catch (error) {
          if (error instanceof ResourcingRefusal) fail(index, `${error.code}: ${error.remedy}`, error.field)
          else fail(index, importRowError(error))
        }
      }
      await ctx.recordKeys?.(resolvedKeys)
      return outcome
    },
  }
}

export function retainerBalancesResource(orgId: string): DataResource {
  return {
    descriptor: RETAINER_BALANCES_DESCRIPTOR,
    fields: async () => RETAINER_BALANCE_FIELDS,
    columns: async () => RETAINER_BALANCE_FIELDS.map((f) => ({ key: f.key, label: f.label })),
    read: async (ctx: ReadCtx): Promise<ReadResult> => {
      // The landed balance source: engine balanceOf over posted drawdowns,
      // aggregated per currency. No cross-currency total exists anywhere here.
      // Context and scope are required own properties, never defaulted: a
      // missing context, an inherited or absent actor, or an omitted scope
      // throws instead of widening to unrestricted.
      if (!ctx || typeof ctx !== 'object') {
        throw new Error('read context is required — the export route threads the acting user into every resource read')
      }
      if (!Object.hasOwn(ctx, 'actorId') || ctx.actorId === undefined) {
        throw new Error('actorId is required — the export route threads the acting user into every resource read')
      }
      if (!Object.hasOwn(ctx, 'allowedSubsidiaryIds') || ctx.allowedSubsidiaryIds === undefined) {
        throw new Error('allowedSubsidiaryIds is required — pass the caller subsidiary scope explicitly')
      }
      if (!(await orgFeatureEnabled(orgId, 'retainerBilling'))) {
        throw new Error('retainer billing feature is disabled — turn on Retainer billing under Company Settings → Features to export balances')
      }
      const kpis = await loadRetainerKpis(orgId, ctx.allowedSubsidiaryIds, await businessToday(orgId))
      if (ctx.page) { ctx.page.done = true; ctx.page.next = null }
      const rows = kpis.perCurrency.map((slot) => ({
        currency: slot.currency,
        balance: slot.balance,
        drawn: slot.drawn,
      }))
      return { fields: RETAINER_BALANCE_FIELDS, columns: RETAINER_BALANCE_FIELDS.map((f) => ({ key: f.key, label: f.label })), rows }
    },
    write: async (rows: Record<string, unknown>[]): Promise<WriteOutcome> => {
      // Export-only by descriptor contract; a direct write is refused row by row.
      return {
        created: 0,
        updated: 0,
        failed: rows.length,
        errors: rows.map((_, index) => ({ row: index + 1, message: 'retainer balances are export-only — drawdowns are drafted from the retainer drawer, never imported' })),
      }
    },
  }
}
