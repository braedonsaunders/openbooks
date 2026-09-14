import 'server-only'
import { db, withOrgTransaction, withTransactionSavepoint } from '@openbooks/engine/src/db.ts'
import { queryIdentifier as ident, queryLiteral as literal, type ReportColumnKind, type ReportEntityColumn } from '@openbooks/reports'
import { loadApiSchema, resolveApiType, type ApiField } from '../api/schema-registry'
import { customRecordReportCatalog } from '../custom-record-report-catalog'
import { appQueryPlanSchema, compileAppQuery, type AppQuerySource } from './query-plan'
import { AppPlatformError, type AppPlatformContext } from './platform'

const kindFor = (type: string): ReportColumnKind | null => ({
  string: 'text', 'string (uuid)': 'uuid', 'string (date)': 'date', 'string (date-time)': 'timestamp', number: 'number', boolean: 'boolean',
})[type] as ReportColumnKind | undefined ?? null

function apiColumn(field: ApiField, dynamic: boolean): ReportEntityColumn | null {
  const kind = kindFor(field.type)
  if (!kind || field.writeOnly || field.name === 'expectedUpdatedAt') return null
  let expr = `r.${ident(field.name)}`
  if (dynamic || field.custom) {
    expr = `nullif(r.${dynamic ? 'data' : 'custom'} ->> ${literal(dynamic ? field.name : field.name.slice(3))}, '')`
    const cast = ({ number: 'numeric', uuid: 'uuid', date: 'date', timestamp: 'timestamptz', boolean: 'boolean' } as Record<string,string>)[kind]
    if (cast) expr = `(${expr})::${cast}`
  }
  return { key: field.name, label: field.description || field.name, kind, expr }
}

export async function queryAppRecords(ctx: AppPlatformContext, raw: unknown) {
  if (JSON.stringify(raw ?? null).length > 65536) throw new AppPlatformError('Query plan exceeds 64 KB')
  const parsed = appQueryPlanSchema.safeParse(raw)
  if (!parsed.success) throw new AppPlatformError(parsed.error.issues.map(i => i.message).join('; '))
  const plan = parsed.data
  const schema = await loadApiSchema(ctx.orgId)
  const custom = await customRecordReportCatalog({ user: ctx.user, permissions: new Set(ctx.userCan('records.read') ? ['records.read'] : []), allowedSubsidiaryIds: ctx.allowedSubsidiaryIds === null ? null : new Set(ctx.allowedSubsidiaryIds) })
  const sources = new Map<string, AppQuerySource>()
  const { permissionSetCovers } = await import('../permissions')
  for (const key of new Set([plan.from.type, ...plan.joins.map(j => j.type)])) {
    const type = schema.find(s => s.key === key)
    const resolved = await resolveApiType(ctx.orgId, key)
    if (!type || !resolved || !type.operations.includes('list') || !ctx.userCan(type.readPermission) || !permissionSetCovers(new Set(ctx.grantedPermissions), type.readPermission)) throw new AppPlatformError(`Query source unavailable: ${key}`, 403)
    if (resolved.dynamic && !Object.hasOwn(custom, `custom:${key}`)) throw new AppPlatformError(`Query source unavailable: ${key}`, 403)
    const fields = resolved.dynamic
      ? custom[`custom:${key}`]!.columns.filter(c => c.key.startsWith('field_')).map(c => ({ ...c, key: c.key.slice(6) }))
      : type.fields.flatMap(f => { const c = apiColumn(f, false); return c ? [c] : [] })
    const base: ReportEntityColumn[] = resolved.dynamic ? [
      { key: 'id', label: 'ID', kind: 'uuid', expr: 'r.id' },
      { key: 'record_number', label: 'Record number', kind: 'text', expr: 'r.record_number' },
      { key: 'status', label: 'Status', kind: 'text', expr: 'r.status' },
      { key: 'created_at', label: 'Created', kind: 'timestamp', expr: 'r.created_at' },
      { key: 'updated_at', label: 'Updated', kind: 'timestamp', expr: 'r.updated_at' },
    ] : []
    const predicates: string[] = []
    if (resolved.dynamic) predicates.push(`r.type_key = ${literal(key)}`)
    if (resolved.documentKinds) predicates.push(`r.kind IN (${resolved.documentKinds.map(literal).join(',')})`)
    if (!resolved.dynamic && ctx.allowedSubsidiaryIds !== null && type.fields.some(f => f.name === 'subsidiary_id')) predicates.push(ctx.allowedSubsidiaryIds.size ? `r.subsidiary_id IN (${[...ctx.allowedSubsidiaryIds].map(literal).join(',')})` : 'FALSE')
    sources.set(key, { from: `${ident(resolved.table)} r`, orgColumn: 'r.org_id', predicates, columns: [...base, ...fields.filter(f => !base.some(b => b.key === f.key))] })
  }
  let compiled
  try { compiled = compileAppQuery(plan, sources, ctx.orgId) }
  catch (error) { throw new AppPlatformError(error instanceof Error ? error.message : 'Invalid query') }
  return withOrgTransaction(ctx.orgId, async () => {
    // Use the pinned client so backend queries see writes in their own atomic invocation.
    const client = db.$client
    const previous = await client.query("select current_setting('statement_timeout') as timeout")
    try {
      return await withTransactionSavepoint(db, async () => {
        await client.query("SET LOCAL statement_timeout = '5s'")
        const result = await client.query(compiled.text, compiled.values)
        if (Buffer.byteLength(JSON.stringify(result.rows), 'utf8') > 2 * 1024 * 1024) throw new AppPlatformError('Query result exceeds 2 MB; select fewer fields or narrow the filters')
        return { columns: compiled.selected, records: result.rows.slice(0, compiled.requestedLimit), hasMore: result.rows.length > compiled.requestedLimit, limit: compiled.requestedLimit }
      })
    } finally { await client.query("select set_config('statement_timeout', $1, true)", [previous.rows[0].timeout]) }
  })
}
