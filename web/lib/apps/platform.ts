import 'server-only'

import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { AppPlatformAdapter } from '@openbooks/engine/src/apps-runtime.ts'
import type { SessionUser } from '@/lib/auth'
import { pgTextArrayLiteral } from '@/lib/pg-array'
import { permissionSetCovers } from '@/lib/permissions'
import {
  loadApiSchema,
  resolveApiType,
  type ApiField,
  type ApiOperation,
  type ApiRecordTypeSchema,
  type ResolvedApiType,
} from '@/lib/api/schema-registry'
import { createRecord, deleteRecord, updateRecord, type WriteResult } from '@/lib/api/writers'
import {
  documentRevisionProjection,
  normalizeDocumentRecordRevisions,
} from '@/lib/documents'
import { isUuid } from '@/lib/list-params'

type PlatformOperation = ApiOperation | 'schema'

export class AppPlatformError extends Error {
  readonly name = 'AppPlatformError'
  constructor(
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export interface AppPlatformContext {
  orgId: string
  user: SessionUser
  grantedPermissions: readonly string[]
  userCan: (permission: string) => boolean
  /** Null means unrestricted; a Set enforces the caller's subsidiary scope. */
  allowedSubsidiaryIds: ReadonlySet<string> | null
}

type ListFilter = {
  field: string
  operator?: 'eq' | 'ne' | 'contains' | 'startsWith' | 'in' | 'isNull'
  value?: unknown
}

type ListOptions = {
  q?: string
  page?: number
  perPage?: number
  filters?: ListFilter[]
  sort?: { field?: string; direction?: 'asc' | 'desc' }
}

const CUSTOM_RECORD_BASE_FIELDS = new Set([
  'id',
  'record_number',
  'status',
  'created_at',
  'created_by',
  'updated_at',
  'updated_by',
])

function hasAppGrant(ctx: AppPlatformContext, permission: string): boolean {
  return permissionSetCovers(new Set(ctx.grantedPermissions), permission)
}

function canUsePermission(ctx: AppPlatformContext, permission: string): boolean {
  return hasAppGrant(ctx, permission) && ctx.userCan(permission)
}

function permissionFor(resolved: ResolvedApiType, operation: PlatformOperation): string | null {
  if (operation === 'list' || operation === 'get') return resolved.readPermission
  if (operation === 'create' || operation === 'update' || operation === 'delete') return resolved.writePermission
  return null
}

async function requireOperation(
  ctx: AppPlatformContext,
  typeKey: string,
  operation: Exclude<PlatformOperation, 'schema'>,
): Promise<ResolvedApiType> {
  const resolved = await resolveApiType(ctx.orgId, typeKey)
  if (!resolved) throw new AppPlatformError(`unknown record type: ${typeKey}`, 404)
  if (!resolved.operations.includes(operation)) {
    throw new AppPlatformError(`${typeKey} does not support ${operation}`, 405)
  }
  const permission = permissionFor(resolved, operation)
  if (!permission || !canUsePermission(ctx, permission)) {
    throw new AppPlatformError(`missing permission: ${permission ?? 'operation unavailable'}`, 403)
  }
  return resolved
}

function exposedOperations(ctx: AppPlatformContext, type: ApiRecordTypeSchema): ApiOperation[] {
  return type.operations.filter((operation) => {
    const permission = operation === 'list' || operation === 'get' ? type.readPermission : type.writePermission
    return !!permission && canUsePermission(ctx, permission)
  })
}

async function schemaForContext(ctx: AppPlatformContext): Promise<ApiRecordTypeSchema[]> {
  const schema = await loadApiSchema(ctx.orgId)
  return schema.flatMap((type) => {
    const operations = exposedOperations(ctx, type)
    return operations.length > 0 ? [{ ...type, operations }] : []
  })
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function quoteIdentifier(identifier: string): SQL {
  return sql.raw(`"${identifier.replace(/"/g, '""')}"`)
}

function fieldExpression(resolved: ResolvedApiType, field: ApiField | null, name: string): SQL {
  if (resolved.dynamic && !CUSTOM_RECORD_BASE_FIELDS.has(name)) {
    return sql`data ->> ${name}`
  }
  if (!resolved.dynamic && field?.custom && name.startsWith('cf_')) {
    return sql`custom ->> ${name.slice(3)}`
  }
  return quoteIdentifier(name)
}

function allowedField(schema: ApiRecordTypeSchema, name: string): ApiField | null | undefined {
  const field = schema.fields.find((candidate) => candidate.name === name)
  if (field) return field
  if (schema.dynamic && CUSTOM_RECORD_BASE_FIELDS.has(name)) return null
  return undefined
}

function filterCondition(expression: SQL, filter: ListFilter, textBacked: boolean): SQL {
  const op = filter.operator ?? 'eq'
  if (op === 'isNull') return filter.value === false ? sql`${expression} is not null` : sql`${expression} is null`
  if (op === 'in') {
    if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100) {
      throw new AppPlatformError(`filter ${filter.field}: in requires 1–100 values`)
    }
    const values = filter.value.map((value) => (textBacked ? String(value) : value))
    return sql`(${sql.join(values.map((value) => sql`${expression} = ${value}`), sql` or `)})`
  }
  if (filter.value === undefined || filter.value === null) {
    throw new AppPlatformError(`filter ${filter.field}: value is required for ${op}`)
  }
  const comparable = textBacked ? String(filter.value) : filter.value
  if (op === 'eq') return sql`${expression} = ${comparable}`
  if (op === 'ne') return sql`${expression} <> ${comparable}`
  const escaped = String(filter.value).replace(/[\\%_]/g, (character) => `\\${character}`)
  if (op === 'contains') return sql`cast(${expression} as text) ilike ${`%${escaped}%`}`
  if (op === 'startsWith') return sql`cast(${expression} as text) ilike ${`${escaped}%`}`
  throw new AppPlatformError(`filter ${filter.field}: unknown operator ${op}`)
}

async function listRecords(
  ctx: AppPlatformContext,
  typeKey: string,
  rawOptions: Record<string, unknown>,
): Promise<unknown> {
  const resolved = await requireOperation(ctx, typeKey, 'list')
  const typeSchema = (await loadApiSchema(ctx.orgId)).find((type) => type.key === typeKey)
  if (!typeSchema) throw new AppPlatformError(`schema unavailable for record type: ${typeKey}`, 404)
  const options = rawOptions as ListOptions
  const page = clampInteger(options.page, 1, 10_000, 1)
  const perPage = clampInteger(options.perPage, 1, 100, 25)
  const filters = Array.isArray(options.filters) ? options.filters : []
  if (filters.length > 20) throw new AppPlatformError('a list call supports at most 20 filters')

  const conditions: SQL[] = [sql`org_id = ${ctx.orgId}`]
  if (resolved.documentKinds) {
    conditions.push(sql`kind = any(${pgTextArrayLiteral(resolved.documentKinds)}::text[])`)
  }
  if (resolved.dynamic) conditions.push(sql`type_key = ${resolved.key}`)
  if (ctx.allowedSubsidiaryIds && typeSchema.fields.some((field) => field.name === 'subsidiary_id')) {
    const ids = [...ctx.allowedSubsidiaryIds]
    conditions.push(ids.length > 0 ? sql`subsidiary_id in ${ids}` : sql`false`)
  }

  const q = typeof options.q === 'string' ? options.q.trim().slice(0, 500) : ''
  if (q) {
    const escaped = q.replace(/[\\%_]/g, (character) => `\\${character}`)
    conditions.push(sql`cast(${quoteIdentifier(resolved.searchColumn)} as text) ilike ${`%${escaped}%`}`)
  }

  for (const filter of filters) {
    if (!filter || typeof filter.field !== 'string') throw new AppPlatformError('every filter needs a field')
    const field = allowedField(typeSchema, filter.field)
    if (field === undefined) throw new AppPlatformError(`unknown filter field: ${filter.field}`)
    const textBacked = (resolved.dynamic && !CUSTOM_RECORD_BASE_FIELDS.has(filter.field)) || !!field?.custom
    conditions.push(filterCondition(fieldExpression(resolved, field, filter.field), filter, textBacked))
  }

  const sortField = options.sort?.field || 'created_at'
  const sortSchema = allowedField(typeSchema, sortField)
  if (sortSchema === undefined) throw new AppPlatformError(`unknown sort field: ${sortField}`)
  const sortExpression = fieldExpression(resolved, sortSchema, sortField)
  const direction = options.sort?.direction === 'asc' ? sql.raw('asc') : sql.raw('desc')
  const table = quoteIdentifier(resolved.table)
  const where = sql.join(conditions, sql` and `)

  const [records, count] = (await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select *${documentRevisionProjection(resolved.table)} from ${table}
       where ${where}
       order by ${sortExpression} ${direction}
       limit ${perPage} offset ${(page - 1) * perPage}`),
    db.execute<{ n: string | number }>(sql`select count(*) as n from ${table} where ${where}`),
  ]))

  return {
    records: normalizeDocumentRecordRevisions(resolved.table, records.rows),
    total: Number(count.rows[0]?.n ?? 0),
    page,
    perPage,
  }
}

async function getRecord(ctx: AppPlatformContext, typeKey: string, id: string): Promise<unknown> {
  if (!isUuid(id)) throw new AppPlatformError('invalid record id', 400)
  const resolved = await requireOperation(ctx, typeKey, 'get')
  const typeSchema = (await loadApiSchema(ctx.orgId)).find((type) => type.key === typeKey)
  const subsidiaryScope =
    ctx.allowedSubsidiaryIds && typeSchema?.fields.some((field) => field.name === 'subsidiary_id')
      ? [...ctx.allowedSubsidiaryIds]
      : null
  const table = quoteIdentifier(resolved.table)
  const result = (await db.execute<Record<string, unknown>>(sql`
    select *${documentRevisionProjection(resolved.table)} from ${table}
     where id = ${id} and org_id = ${ctx.orgId}
       ${resolved.documentKinds ? sql`and kind = any(${pgTextArrayLiteral(resolved.documentKinds)}::text[])` : sql``}
       ${resolved.dynamic ? sql`and type_key = ${resolved.key}` : sql``}
       ${subsidiaryScope ? (subsidiaryScope.length > 0 ? sql`and subsidiary_id in ${subsidiaryScope}` : sql`and false`) : sql``}
     limit 1`))
  return normalizeDocumentRecordRevisions(resolved.table, result.rows)[0] ?? null
}

async function writableFields(ctx: AppPlatformContext, resolved: ResolvedApiType): Promise<ApiField[]> {
  if (resolved.writer.kind !== 'entity') return []
  return (await loadApiSchema(ctx.orgId)).find((type) => type.key === resolved.key)?.fields ?? []
}

function unwrapWrite(result: WriteResult): unknown {
  if (result.status >= 400) {
    const body = result.body as { error?: unknown } | null
    throw new AppPlatformError(String(body?.error ?? 'record write failed'), result.status, result.body)
  }
  return result.body
}

async function writeRecord(
  ctx: AppPlatformContext,
  operation: 'create' | 'update' | 'delete',
  typeKey: string,
  id?: string,
  body: Record<string, unknown> = {},
): Promise<unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppPlatformError('record body must be an object', 400)
  }
  const resolved = await requireOperation(ctx, typeKey, operation)
  if (
    resolved.writer.kind === 'document' &&
    body.action === 'post'
  ) {
    const postPermission = resolved.writer.docKind === 'vendor_bill' ? 'ap.post' : 'ar.post'
    if (!canUsePermission(ctx, postPermission)) {
      throw new AppPlatformError(`missing permission: ${postPermission}`, 403)
    }
  }
  await assertSubsidiaryWriteScope(ctx, resolved, typeKey, operation, id, body)
  if (operation !== 'create' && (!id || !isUuid(id))) throw new AppPlatformError('invalid record id', 400)
  const fields = await writableFields(ctx, resolved)
  if (operation === 'create') return unwrapWrite(await createRecord(ctx.user, resolved, fields, body))
  if (operation === 'update') return unwrapWrite(await updateRecord(ctx.user, resolved, fields, id!, body))
  return unwrapWrite(await deleteRecord(ctx.user, resolved, id!))
}

async function assertSubsidiaryWriteScope(
  ctx: AppPlatformContext,
  resolved: ResolvedApiType,
  typeKey: string,
  operation: 'create' | 'update' | 'delete',
  id: string | undefined,
  body: Record<string, unknown>,
): Promise<void> {
  if (!ctx.allowedSubsidiaryIds) return
  const schema = (await loadApiSchema(ctx.orgId)).find((type) => type.key === typeKey)
  if (!schema?.fields.some((field) => field.name === 'subsidiary_id')) return

  const requested = body.subsidiaryId ?? body.subsidiary_id
  if (requested !== undefined && requested !== null && !ctx.allowedSubsidiaryIds.has(String(requested))) {
    throw new AppPlatformError('record is outside the caller subsidiary scope', 403)
  }
  if (operation === 'create') {
    if (requested === undefined || requested === null) {
      const allowed = [...ctx.allowedSubsidiaryIds]
      if (allowed.length !== 1) {
        throw new AppPlatformError('subsidiaryId is required for this record', 422)
      }
      if (resolved.writer.kind === 'document') body.subsidiaryId = allowed[0]
      else body.subsidiary_id = allowed[0]
    }
    return
  }
  if (!id) return

  const table = quoteIdentifier(resolved.table)
  const allowed = [...ctx.allowedSubsidiaryIds]
  const found = (await db.execute(sql`
    select 1 from ${table}
     where id = ${id} and org_id = ${ctx.orgId}
       ${allowed.length > 0 ? sql`and subsidiary_id in ${allowed}` : sql`and false`}
     limit 1`))
  if (!found.rows[0]) throw new AppPlatformError('record is outside the caller subsidiary scope', 403)
}

export function createAppPlatformAdapter(ctx: AppPlatformContext): AppPlatformAdapter {
  return {
    schema: () => schemaForContext(ctx),
    list: (typeKey, options) => listRecords(ctx, typeKey, options),
    get: (typeKey, id) => getRecord(ctx, typeKey, id),
    create: (typeKey, body) => writeRecord(ctx, 'create', typeKey, undefined, body),
    update: (typeKey, id, body) => writeRecord(ctx, 'update', typeKey, id, body),
    delete: (typeKey, id) => writeRecord(ctx, 'delete', typeKey, id),
  }
}
