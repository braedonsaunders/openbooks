import { z } from 'zod'
import { compileCustomQuery, validateCustomQuery, compileRule, SqlParams, queryIdentifier as ident, queryLiteral as literal, type ReportEntity, type ReportEntityColumn, type ReportRuleGroup } from '@openbooks/reports'

const alias = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/)
const source = z.object({ type: z.string().min(1).max(150), as: alias }).strict()
const reference = z.object({ source: alias, field: z.string().min(1).max(150) }).strict()
export const appQueryPlanSchema = z.object({
  from: source,
  joins: z.array(source.extend({ kind: z.enum(['inner', 'left']), on: z.object({ left: reference, right: reference }).strict() })).max(4).default([]),
  select: z.array(reference).min(1).max(50),
  filters: z.unknown().optional(),
  sorts: z.array(z.object({ column: z.string().max(182), direction: z.enum(['asc','desc']) }).strict()).max(3).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
}).strict()
export interface AppQuerySource { from: string; columns: ReportEntityColumn[]; predicates: string[]; orgColumn: string }

/** Sources are server-generated and independently scoped BEFORE a left join. */
export function compileAppQuery(raw: unknown, sources: ReadonlyMap<string, AppQuerySource>, orgId: string) {
  const plan = appQueryPlanSchema.parse(raw)
  const seen = new Map<string, AppQuerySource>()
  const columns: ReportEntityColumn[] = []
  const parts: string[] = []
  const column = (r: { source: string; field: string }) => {
    const c = seen.get(r.source)?.columns.find(c => c.key === r.field)
    if (!c) throw new Error(`Unknown query field: ${r.source}.${r.field}`)
    return c
  }
  for (const [index, item] of [plan.from, ...plan.joins].entries()) {
    if (seen.has(item.as)) throw new Error('Query source aliases must be unique')
    const s = sources.get(item.type)
    if (!s) throw new Error(`Query source unavailable: ${item.type}`)
    const inner = `SELECT ${s.columns.map(c => `${c.expr} AS ${ident(c.key)}`).join(', ')}, ${s.orgColumn} AS "__org" FROM ${s.from} WHERE ${s.orgColumn} = ${literal(orgId)}${s.predicates.map(p => ` AND (${p})`).join('')}`
    const table = `(${inner}) AS ${ident(item.as)}`
    if (index === 0) parts.push(table)
    else {
      const join = plan.joins[index - 1]!
      if (join.on.right.source !== item.as || !seen.has(join.on.left.source)) throw new Error('Join must connect an earlier source to the new source')
      const left = column(join.on.left)
      const right = s.columns.find(c => c.key === join.on.right.field)
      if (!right || left.kind !== right.kind) throw new Error('Join fields must exist and have matching types')
      parts.push(`${join.kind === 'left' ? 'LEFT' : 'INNER'} JOIN ${table} ON ${ident(join.on.left.source)}.${ident(join.on.left.field)} = ${ident(item.as)}.${ident(join.on.right.field)} AND ${ident(plan.from.as)}."__org" = ${ident(item.as)}."__org"`)
    }
    seen.set(item.as, s)
    columns.push(...s.columns.map(c => ({ ...c, key: `${item.as}.${c.key}`, expr: `${ident(item.as)}.${ident(c.key)}` })))
  }
  const selected = plan.select.map(r => { column(r); return `${r.source}.${r.field}` })
  if (new Set(selected).size !== selected.length) throw new Error('Duplicate selected query field')
  for (const sort of plan.sorts ?? []) if (!columns.some(c => c.key === sort.column)) throw new Error(`Unknown sort field: ${sort.column}`)
  const entity: ReportEntity = { key: 'app_query', label: 'App query', category: 'apps', description: 'Joined record rows',
    from: parts.join('\n'), orgColumn: `${ident(plan.from.as)}."__org"`, subsidiaryScope: null, columns }
  const rawQuery = { entity: entity.key, mode: 'rows', columns: selected, filters: plan.filters as ReportRuleGroup | undefined, sorts: plan.sorts, limit: plan.limit + 1 }
  const query = validateCustomQuery(rawQuery, { [entity.key]: entity })
  const checkFilters = (group: ReportRuleGroup | null | undefined): void => {
    for (const rule of group?.rules ?? []) {
      if ('rules' in rule) checkFilters(rule)
      else if (!compileRule(entity, { column: rule.field, op: rule.op, value: rule.value }, new SqlParams())) throw new Error(`Incomplete or unsupported filter: ${rule.field}`)
    }
  }
  checkFilters(query.filters)
  const compiled = compileCustomQuery(entity, query, orgId, { maxRows: 1001 })
  return { ...compiled, selected, requestedLimit: plan.limit }
}
