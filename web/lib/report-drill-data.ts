import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { REPORT_ENTITY_MAP, defaultColumnsFor, validateCustomQuery, type ReportCustomQuery, type ReportRuleGroup } from '@openbooks/reports'
import type { Authz } from './authz'
import { canRunReportEntity } from './report-authz'
import { executeReport, loadReportDefinition } from './custom-reports'
import { loadView } from './views'
import { agingDetail, transactionDetail } from './reports'
import { getMoneyFormatter } from './money-server'
import type { ReportDrillResponse, ReportDrillTarget } from './report-drill'
import type { StatementDimFilter } from './statement-matrix'
import type { DimFilter } from './reports'
import { subsidiaryVisibleFilter } from './subsidiaries'
import { decimalAdd, decimalCmp, decimalNeg, decimalSum } from './statement-format'

export const REPORT_DRILL_PAGE_SIZE = 50

interface OrderDrillSqlRow {
  id: string; kind: string; date: string; document_number: string;
  party: string | null; status: string; total: unknown
}
interface TimeDrillSqlRow {
  id: string; date: string; employee: string; project: string | null;
  memo: string | null; hours: unknown
}
interface EntryDocumentSqlRow { id: string; kind: string | null; doc_id: string | null }
interface BudgetScenarioSqlRow { book_id: string; from_date: string; to_date: string }
interface BudgetVarianceSqlRow {
  source: 'actual' | 'budget'; key: string; period: string; entry_number: string | null;
  number: string | null; account: string; detail: string | null; amount: unknown;
  entry_id: string | null; doc_kind: string | null; doc_id: string | null
}
interface BudgetLineSqlRow {
  id: string; period: string; number: string | null; account: string;
  note: string | null; amount: unknown
}

const dimSql = (dims: StatementDimFilter | undefined, alias: 'bl' | 'l') => {
  const column = (name: string) => sql.raw(`${alias}.${name}`)
  return sql`${dims?.departmentId ? sql`and ${column('department_id')} = ${dims.departmentId}` : sql``}
    ${dims?.projectId ? sql`and ${column('project_id')} = ${dims.projectId}` : sql``}
    ${dims?.locationId ? sql`and ${column('location_id')} = ${dims.locationId}` : sql``}
    ${dims?.classId ? sql`and ${column('class_id')} = ${dims.classId}` : sql``}`
}

/** A non-voided order remains open while any line has unconverted quantity. */
const openOrderPredicate = sql`
  d.status <> 'voided'
  and exists (
    select 1
      from document_lines line
     where line.org_id = d.org_id
       and line.document_id = d.id
       and line.quantity_billed < line.quantity
  )`

const linkedOrderPredicate = sql`
  exists (
    select 1
      from document_links link
     where link.from_document_id = d.id
       and link.org_id = d.org_id
  )`

/**
 * Budget lines have no subsidiary column. A dimension can still carry an
 * entity owner, so every assigned dimension must either be shared (null owner)
 * or belong to the caller's allowed subsidiaries. Lines with no entity-owned
 * dimension cannot be attributed safely and are denied for restricted callers.
 */
function budgetSubsidiaryFilter(authz: Authz): ReturnType<typeof sql> {
  const allowed = authz.allowedSubsidiaryIds
  if (allowed === null) return sql``
  if (allowed.size === 0) return sql`and false`
  const ids = `{${[...allowed].join(',')}}`
  return sql`and (
    (
      (bl.project_id is not null and exists (
        select 1 from projects bp_owner
         where bp_owner.id = bl.project_id and bp_owner.org_id = bl.org_id
           and bp_owner.subsidiary_id = any(${ids}::uuid[])))
      or (bl.department_id is not null and exists (
        select 1 from departments bd_owner
         where bd_owner.id = bl.department_id and bd_owner.org_id = bl.org_id
           and bd_owner.subsidiary_id = any(${ids}::uuid[])))
      or (bl.location_id is not null and exists (
        select 1 from locations bx_owner
         where bx_owner.id = bl.location_id and bx_owner.org_id = bl.org_id
           and bx_owner.subsidiary_id = any(${ids}::uuid[])))
      or (bl.class_id is not null and exists (
        select 1 from classes bc_owner
         where bc_owner.id = bl.class_id and bc_owner.org_id = bl.org_id
           and bc_owner.subsidiary_id = any(${ids}::uuid[])))
    )
    and
    (bl.project_id is null or exists (
      select 1 from projects bp
       where bp.id = bl.project_id and bp.org_id = bl.org_id
         and (bp.subsidiary_id is null or bp.subsidiary_id = any(${ids}::uuid[]))))
    and (bl.department_id is null or exists (
      select 1 from departments bd
       where bd.id = bl.department_id and bd.org_id = bl.org_id
         and (bd.subsidiary_id is null or bd.subsidiary_id = any(${ids}::uuid[]))))
    and (bl.location_id is null or exists (
      select 1 from locations bx
       where bx.id = bl.location_id and bx.org_id = bl.org_id
         and (bx.subsidiary_id is null or bx.subsidiary_id = any(${ids}::uuid[]))))
    and (bl.class_id is null or exists (
      select 1 from classes bc
       where bc.id = bl.class_id and bc.org_id = bl.org_id
         and (bc.subsidiary_id is null or bc.subsidiary_id = any(${ids}::uuid[]))))
  )`
}

/** Merge a report-selected subsidiary with the caller's legal-entity scope. */
function ledgerDims(
  target: Extract<ReportDrillTarget, { kind: 'ledger' }>,
  authz: Authz,
): DimFilter {
  const rawDims = target.dims as StatementDimFilter & { subsidiaryIds?: string[] } | undefined
  const requested = target.subsidiaryId
    ? [target.subsidiaryId]
    : rawDims?.subsidiaryIds
  const subsidiaryIds = authz.allowedSubsidiaryIds === null
    ? requested
    : requested
      ? requested.filter((id) => authz.allowedSubsidiaryIds!.has(id))
      : [...authz.allowedSubsidiaryIds]
  return {
    ...target.dims,
    ...(subsidiaryIds ? { subsidiaryIds } : {}),
  }
}

function paginate<T>(rows: T[], page: number): T[] {
  const start = (page - 1) * REPORT_DRILL_PAGE_SIZE
  return rows.slice(start, start + REPORT_DRILL_PAGE_SIZE)
}

async function ledgerData(target: Extract<ReportDrillTarget, { kind: 'ledger' }>, authz: Authz, page: number): Promise<ReportDrillResponse> {
  const { money } = await getMoneyFormatter(authz.user.orgId)
  const dims = ledgerDims(target, authz)
  const [tc, tr, result] = await Promise.all([
    getTranslations('common'),
    getTranslations('reports'),
    transactionDetail({
      accountIds: target.accountIds,
      accountTypes: target.accountTypes,
      from: target.from,
      to: target.to,
      mode: target.mode,
      dims,
      basis: target.basis,
      partyIds: target.partyIds,
      projectCustomerId: target.projectCustomerId,
      unassignedProjectCustomer: target.unassignedProjectCustomer,
      projectSearch: target.projectSearch,
      activeProjectsOnly: target.activeProjectsOnly,
      profitSigned: target.profitSigned,
      cashOnly: target.cashOnly,
      limit: REPORT_DRILL_PAGE_SIZE,
      offset: (page - 1) * REPORT_DRILL_PAGE_SIZE,
      orgId: authz.user.orgId,
    }),
  ])
  return {
    title: target.label,
    description: tr('drillDrawer.supporting'),
    summary: [
      { label: tr('detail.netTotal'), value: money(result.net) },
      { label: tr('trialBalance.columns.debits'), value: money(result.totalDebit) },
      { label: tr('trialBalance.columns.credits'), value: money(result.totalCredit) },
    ],
    columns: [
      { label: tc('labels.date') },
      { label: tc('transactionTypes.journalEntry') },
      { label: tc('labels.account') },
      { label: tc('labels.description') },
      { label: tr('trialBalance.columns.debits'), align: 'right' },
      { label: tr('trialBalance.columns.credits'), align: 'right' },
    ],
    rows: result.lines.map((line) => ({
      key: line.lineId,
      cells: [
        line.date,
        line.entryNumber,
        [line.accountNumber, line.accountName].filter(Boolean).join(' · '),
        [line.party, line.memo].filter(Boolean).join(' · '),
        decimalCmp(line.amount, '0') > 0 ? money(line.amount) : '',
        decimalCmp(line.amount, '0') < 0 ? money(decimalNeg(line.amount)) : '',
      ],
      transaction: { entryId: line.entryId, docKind: line.docKind, docId: line.docId },
    })),
    linkColumn: 1,
    page,
    perPage: REPORT_DRILL_PAGE_SIZE,
    total: result.count,
  }
}

async function agingData(target: Extract<ReportDrillTarget, { kind: 'aging' }>, authz: Authz, page: number): Promise<ReportDrillResponse> {
  const { money } = await getMoneyFormatter(authz.user.orgId)
  const [tc, tr, result] = await Promise.all([
    getTranslations('common'),
    getTranslations('reports'),
    agingDetail(target.side, target.asOf, target.dims, authz.user.orgId),
  ])
  const rows = result.rows.filter((row) => (!target.partyId || row.partyId === target.partyId) && (!target.bucket || row.bucket === target.bucket))
  return {
    title: target.label,
    description: tr('drillDrawer.supporting'),
    summary: [{ label: tc('labels.total'), value: money(decimalSum(rows.map((row) => row.open))) }],
    columns: [
      { label: tc('labels.party') },
      { label: tc('labels.reference') },
      { label: tr('aging.columns.due') },
      { label: tr('aging.columns.age'), align: 'right' },
      { label: tr('aging.columns.bucket') },
      { label: tc('labels.openBalance'), align: 'right' },
    ],
    rows: paginate(rows, page).map((row) => ({
      key: row.docId,
      cells: [row.partyName, row.reference, row.dueDate, row.ageDays, tr(`aging.buckets.${row.bucket}`), money(row.open)],
      transaction: { entryId: row.docId, docKind: row.docKind, docId: row.docId },
    })),
    linkColumn: 1,
    page,
    perPage: REPORT_DRILL_PAGE_SIZE,
    total: rows.length,
  }
}

async function orderData(target: Extract<ReportDrillTarget, { kind: 'orders' }>, authz: Authz, page: number): Promise<ReportDrillResponse> {
  const { money } = await getMoneyFormatter(authz.user.orgId)
  const [tc, tr] = await Promise.all([getTranslations('common'), getTranslations('reports')])
  const scope = target.scope
  const subsidiaryFilter = subsidiaryVisibleFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)
  const predicate = scope === 'voided'
    ? sql`d.status = 'voided'`
    : scope === 'converted'
      ? linkedOrderPredicate
      : scope === 'conversion'
        ? sql`d.status <> 'voided' and (${openOrderPredicate} or ${linkedOrderPredicate})`
        : openOrderPredicate
  const offset = (page - 1) * REPORT_DRILL_PAGE_SIZE
  const [count, result] = await Promise.all([
    db.execute(sql`select count(*)::int as n from documents d where d.org_id = ${authz.user.orgId} and d.kind = ${target.orderKind} ${subsidiaryFilter} and ${predicate}`),
    db.execute(sql`
      select d.id, d.kind, d.document_number, d.document_date::text as date, d.status,
             p.display_name as party, d.total
        from documents d left join parties p on p.id = d.party_id and p.org_id = d.org_id
       where d.org_id = ${authz.user.orgId} and d.kind = ${target.orderKind} ${subsidiaryFilter} and ${predicate}
       order by d.document_date desc, d.document_number desc
       limit ${REPORT_DRILL_PAGE_SIZE} offset ${offset}`),
  ])
  const total = Number(count.rows[0]?.n ?? 0)
  return {
    title: target.label,
    description: tr('drillDrawer.supporting'),
    summary: [{ label: tc('labels.lines'), value: total.toLocaleString() }],
    columns: [
      { label: tc('labels.date') }, { label: tc('labels.number') }, { label: tc('labels.party') },
      { label: tc('labels.status') }, { label: tc('labels.total'), align: 'right' },
    ],
    rows: (result.rows as unknown as OrderDrillSqlRow[]).map((row) => ({
      key: row.id,
      cells: [row.date, row.document_number, row.party, row.status, money(String(row.total))],
      transaction: { entryId: row.id, docKind: row.kind, docId: row.id },
    })),
    linkColumn: 1,
    page,
    perPage: REPORT_DRILL_PAGE_SIZE,
    total,
  }
}

async function timeData(target: Extract<ReportDrillTarget, { kind: 'time' }>, authz: Authz, page: number): Promise<ReportDrillResponse> {
  const [tc, tr] = await Promise.all([getTranslations('common'), getTranslations('reports')])
  const project = target.projectId ? sql`and te.project_id = ${target.projectId}` : sql``
  const customer = target.projectCustomerId
    ? sql`and te.project_id in (
        select p.id from projects p
         where p.org_id = ${authz.user.orgId} and p.customer_id = ${target.projectCustomerId}
      )`
    : target.unassignedProjectCustomer
      ? sql`and te.project_id in (
          select p.id from projects p
           where p.org_id = ${authz.user.orgId} and p.customer_id is null
        )`
      : sql``
  const search = target.projectSearch?.trim()
    ? sql`and te.project_id in (
        select p.id
          from projects p
          left join parties cu on cu.id = p.customer_id and cu.org_id = p.org_id
         where p.org_id = ${authz.user.orgId}
           and (p.name ilike ${`%${target.projectSearch.trim()}%`} or cu.display_name ilike ${`%${target.projectSearch.trim()}%`})
      )`
    : sql``
  const activeProjects = target.activeProjectsOnly
    ? sql`and te.project_id in (
        select p.id from projects p
         where p.org_id = ${authz.user.orgId} and p.is_active
      )`
    : sql``
  const subsidiaryFilter = subsidiaryVisibleFilter(sql`coalesce(p.subsidiary_id, e.subsidiary_id)`, authz.allowedSubsidiaryIds)
  const offset = (page - 1) * REPORT_DRILL_PAGE_SIZE
  const [count, result] = await Promise.all([
    db.execute(sql`select count(*)::int as n, coalesce(sum(te.hours), 0) as hours
                     from time_entries te
                     join parties e on e.id = te.employee_party_id and e.org_id = te.org_id
                     left join projects p on p.id = te.project_id and p.org_id = te.org_id
                    where te.org_id = ${authz.user.orgId} and te.status = 'approved'
                      and te.worked_on >= ${target.from} and te.worked_on <= ${target.to}
                      ${project} ${customer} ${search} ${activeProjects} ${subsidiaryFilter}`),
    db.execute(sql`
      select te.id, te.worked_on::text as date, e.display_name as employee, p.name as project, te.memo, te.hours
        from time_entries te
        join parties e on e.id = te.employee_party_id and e.org_id = te.org_id
        left join projects p on p.id = te.project_id and p.org_id = te.org_id
       where te.org_id = ${authz.user.orgId} and te.status = 'approved'
         and te.worked_on >= ${target.from} and te.worked_on <= ${target.to} ${project} ${customer} ${search} ${activeProjects} ${subsidiaryFilter}
       order by te.worked_on desc, e.display_name
       limit ${REPORT_DRILL_PAGE_SIZE} offset ${offset}`),
  ])
  return {
    title: target.label,
    description: tr('drillDrawer.supporting'),
    summary: [{ label: tr('projectProfitability.columns.hours'), value: String(count.rows[0]?.hours ?? 0) }],
    columns: [
      { label: tc('labels.date') }, { label: tc('labels.employee') }, { label: tc('labels.project') },
      { label: tc('labels.memo') }, { label: tr('projectProfitability.columns.hours'), align: 'right' },
    ],
    rows: (result.rows as unknown as TimeDrillSqlRow[]).map((row) => ({ key: row.id, cells: [row.date, row.employee, row.project, row.memo, Number(row.hours)] })),
    page,
    perPage: REPORT_DRILL_PAGE_SIZE,
    total: Number(count.rows[0]?.n ?? 0),
  }
}

function customSupportColumns(entityKey: string): string[] {
  if (entityKey === 'ledger_lines') return ['entry_id']
  if (entityKey === 'journal_entries') return ['id', 'source_document_id']
  if (entityKey === 'documents') return ['kind', 'id']
  if (entityKey === 'transaction_lines') return ['kind', 'document_id']
  return []
}

async function customData(target: Extract<ReportDrillTarget, { kind: 'custom' }>, authz: Authz, page: number): Promise<ReportDrillResponse> {
  const tr = await getTranslations('reports')
  const source = target.source === 'definition'
    ? await loadReportDefinition(authz.user.orgId, target.id)
    : await loadView(authz.user.orgId, target.id, authz.user.id, authz.permissions)
  const stored = source?.query
  if (!stored) throw new Error('report_not_found')
  const entity = REPORT_ENTITY_MAP[stored.entity]
  if (!entity) throw new Error('report_entity_not_found')
  // A drill returns the report's OWN supporting rows, so it owes the same
  // entity gate the runner and the export owe. `loadView` already applies it
  // for saved views; a stored definition reached this far unchecked.
  if (!(await canRunReportEntity(authz, stored))) throw new Error('report_entity_forbidden')
  const support = customSupportColumns(entity.key)
  // Supporting rows show the REPORT'S OWN columns (they carry the drilled
  // amounts); catalog defaults only when the plan has none (summarize mode).
  const planColumns = (stored.mode === 'rows' ? stored.columns ?? [] : [])
    .filter((key) => entity.columns.some((column) => column.key === key))
  const visible = planColumns.length > 0 ? planColumns : defaultColumnsFor(entity, 8)
  const columns = [...visible, ...support.filter((key) => !visible.includes(key))]
  // An aggregate drill scopes the supporting rows to exactly the clicked
  // bucket (all breakout predicates), never the whole report. Unknown fields
  // fail the whole scope closed — better no rows than the wrong rows.
  let sectionFilter: ReportRuleGroup | null = null
  if (target.filter?.length) {
    const rules: ReportRuleGroup['rules'] = []
    for (const scope of target.filter) {
      if (!entity.columns.some((column) => column.key === scope.field)) throw new Error('report_drill_scope_invalid')
      if (scope.empty) rules.push({ field: scope.field, op: 'is_null' })
      else if (scope.from && scope.to) {
        rules.push({ field: scope.field, op: 'gte', value: scope.from })
        rules.push({ field: scope.field, op: 'lte', value: scope.to })
      } else rules.push({ field: scope.field, op: 'eq', value: scope.value ?? '' })
    }
    sectionFilter = { combinator: 'and', rules }
  }
  const detailQuery = validateCustomQuery({
    ...stored,
    filters: sectionFilter
      ? { combinator: 'and', rules: [...(stored.filters ? [stored.filters] : []), sectionFilter] }
      : stored.filters,
    mode: 'rows',
    columns,
    breakouts: [],
    measures: [],
    groupBy: null,
    limit: 10_000,
  } satisfies ReportCustomQuery)
  const { money } = await getMoneyFormatter(authz.user.orgId)
  const result = await executeReport(authz.user.orgId, detailQuery, 10_000)
  const allRows = result.groups.flatMap((group) => group.rows)
  const visibleIndexes = visible.map((key) => columns.indexOf(key))
  const supportIndex = Object.fromEntries(support.map((key) => [key, columns.indexOf(key)]))
  const pageRows = paginate(allRows, page)

  const entryIds = pageRows.map((row) => {
    const idx = supportIndex.entry_id ?? supportIndex.id
    return idx === undefined ? null : String(row[idx] ?? '')
  }).filter(Boolean)
  const entryDocs = new Map<string, { kind: string | null; id: string | null }>()
  if ((entity.key === 'ledger_lines' || entity.key === 'journal_entries') && entryIds.length) {
    const docs = (await db.execute(sql`
      select je.id, d.kind, d.id as doc_id
        from journal_entries je left join documents d on d.id = je.source_document_id and d.org_id = je.org_id
       where je.org_id = ${authz.user.orgId} and je.id in ${entryIds}`)) as unknown as { rows: EntryDocumentSqlRow[] }
    for (const row of docs.rows) entryDocs.set(row.id, { kind: row.kind, id: row.doc_id })
  }
  return {
    title: target.label,
    description: tr('drillDrawer.supporting'),
    summary: [{ label: tr('custom.runner.columns.rows'), value: allRows.length.toLocaleString() }],
    columns: visible.map((key) => {
      const column = entity.columns.find((c) => c.key === key)
      return {
        label: column?.label ?? key,
        align: column?.kind === 'money' || column?.kind === 'number' ? ('right' as const) : undefined,
      }
    }),
    rows: pageRows.map((row, index) => {
      let transaction: ReportDrillResponse['rows'][number]['transaction']
      if (entity.key === 'documents' || entity.key === 'transaction_lines') {
        const idKey = entity.key === 'documents' ? 'id' : 'document_id'
        const id = String(row[supportIndex[idKey]!] ?? '')
        const kind = String(row[supportIndex.kind!] ?? '')
        if (id && kind) transaction = { entryId: id, docKind: kind, docId: id }
      } else if (entity.key === 'ledger_lines' || entity.key === 'journal_entries') {
        const idKey = entity.key === 'ledger_lines' ? 'entry_id' : 'id'
        const entryId = String(row[supportIndex[idKey]!] ?? '')
        const doc = entryDocs.get(entryId)
        if (entryId) transaction = { entryId, docKind: doc?.kind, docId: doc?.id }
      }
      const cells = visibleIndexes.map((i, vi) => {
        const value = row[i] ?? null
        const kind = entity.columns.find((c) => c.key === visible[vi])?.kind
        // Money columns render currency-formatted, like every native drill.
        if (kind === 'money' && value != null && value !== '') {
          return money(String(value))
        }
        return value
      })
      return { key: `${page}:${index}`, cells, transaction }
    }),
    linkColumn: pageRows.some(() => ['ledger_lines', 'journal_entries', 'documents', 'transaction_lines'].includes(entity.key)) ? 0 : undefined,
    page,
    perPage: REPORT_DRILL_PAGE_SIZE,
    total: allRows.length,
  }
}

async function budgetData(target: Extract<ReportDrillTarget, { kind: 'budget' }>, authz: Authz, page: number): Promise<ReportDrillResponse> {
  const { money } = await getMoneyFormatter(authz.user.orgId)
  const scenario = (await db.execute(sql`
    select bs.book_id, min(ap.starts_on)::text as from_date, max(ap.ends_on)::text as to_date
      from budget_scenarios bs
      join accounting_periods ap on ap.org_id = bs.org_id and ap.fiscal_year = bs.fiscal_year and not ap.is_adjustment
     where bs.id = ${target.scenarioId} and bs.org_id = ${authz.user.orgId}
     group by bs.book_id`)) as unknown as { rows: BudgetScenarioSqlRow[] }
  const row = scenario.rows[0]
  if (!row) throw new Error('scenario_not_found')
  if (target.scope === 'actual') {
    return ledgerData({ kind: 'ledger', label: target.label, accountIds: target.accountIds, accountTypes: target.accountTypes, from: row.from_date, to: row.to_date, mode: 'flow', dims: target.dims }, authz, page)
  }
  const [tc, tr] = await Promise.all([getTranslations('common'), getTranslations('reports')])
  const offset = (page - 1) * REPORT_DRILL_PAGE_SIZE
  const account = target.accountIds?.length
    ? sql`and bl.account_id in (with recursive sub as (select id from accounts where org_id = ${authz.user.orgId} and id in ${target.accountIds} union all select a.id from accounts a join sub on a.parent_id = sub.id where a.org_id = ${authz.user.orgId}) select id from sub)`
    : target.accountTypes?.length ? sql`and a.type in ${target.accountTypes}` : sql``
  const dims = dimSql(target.dims, 'bl')
  const subsidiaryFilter = budgetSubsidiaryFilter(authz)
  const actualSubsidiaryFilter = subsidiaryVisibleFilter(sql`l.subsidiary_id`, authz.allowedSubsidiaryIds)
  if (target.scope === 'variance') {
    const actualAccount = target.accountIds?.length
      ? sql`and l.account_id in (with recursive sub as (select id from accounts where org_id = ${authz.user.orgId} and id in ${target.accountIds} union all select child.id from accounts child join sub on child.parent_id = sub.id where child.org_id = ${authz.user.orgId}) select id from sub)`
      : target.accountTypes?.length ? sql`and a.type in ${target.accountTypes}` : sql``
    const actualDims = dimSql(target.dims, 'l')
    const support = sql`
      with support as (
        select 'actual'::text as source, e.id::text as key, e.posting_date as sort_date,
               e.posting_date::text as period, e.entry_number,
               a.number, a.name as account, coalesce(l.memo, e.memo) as detail,
               case when a.type in ('income', 'income_other') then -l.amount else l.amount end as amount,
               e.id as entry_id, d.kind as doc_kind, d.id as doc_id
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
          join accounts a on a.id = l.account_id and a.org_id = l.org_id
          left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
         where l.org_id = ${authz.user.orgId} and e.book_id = ${row.book_id}
           and e.posting_date >= ${row.from_date} and e.posting_date <= ${row.to_date}
           ${actualAccount} ${actualDims} ${actualSubsidiaryFilter}
        union all
        select 'budget'::text as source, bl.id::text as key, ap.starts_on as sort_date,
               ap.name as period, null::text as entry_number,
               a.number, a.name as account, bl.note as detail,
               case when a.type in ('income', 'income_other') then -bl.amount else bl.amount end as amount,
               null::uuid as entry_id, null::text as doc_kind, null::uuid as doc_id
          from budget_lines bl
          join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
          join accounting_periods ap on ap.id = bl.period_id and ap.org_id = bl.org_id
         where bl.org_id = ${authz.user.orgId} and bl.scenario_id = ${target.scenarioId}
           ${account} ${dims} ${subsidiaryFilter}
      )`
    const [totals, rows] = await Promise.all([
      db.execute(sql`${support}
        select count(*)::int as n,
               coalesce(sum(amount) filter (where source = 'actual'), 0) as actual,
               coalesce(sum(amount) filter (where source = 'budget'), 0) as budget
          from support`),
      db.execute(sql`${support}
        select source, key, period, entry_number, number, account, detail, amount,
               entry_id, doc_kind, doc_id
          from support
         order by sort_date, source, number nulls last, key
         limit ${REPORT_DRILL_PAGE_SIZE} offset ${offset}`),
    ])
    const totalRow = totals.rows[0] ?? { n: 0, actual: 0, budget: 0 }
    const actual = String(totalRow.actual)
    const budget = String(totalRow.budget)
    return {
      title: target.label,
      description: tr('drillDrawer.supporting'),
      summary: [
        { label: tr('budget.actual'), value: money(actual) },
        { label: tr('budget.budget'), value: money(budget) },
        { label: tr('budget.variance'), value: money(decimalAdd(actual, decimalNeg(budget))) },
      ],
      columns: [
        { label: tc('labels.type') }, { label: tc('labels.period') },
        { label: tc('transactionTypes.journalEntry') }, { label: tc('labels.account') },
        { label: tc('labels.description') }, { label: tc('labels.amount'), align: 'right' },
      ],
      rows: (rows.rows as unknown as BudgetVarianceSqlRow[]).map((item) => ({
        key: `${item.source}:${item.key}`,
        cells: [
          item.source === 'actual' ? tr('budget.actual') : tr('budget.budget'),
          item.period,
          item.entry_number,
          [item.number, item.account].filter(Boolean).join(' · '),
          item.detail,
          money(String(item.amount)),
        ],
        transaction: item.entry_id
          ? { entryId: item.entry_id, docKind: item.doc_kind, docId: item.doc_id }
          : undefined,
      })),
      linkColumn: 2,
      page,
      perPage: REPORT_DRILL_PAGE_SIZE,
      total: Number(totalRow.n),
    }
  }
  const [count, rows] = await Promise.all([
    db.execute(sql`select count(*)::int as n, coalesce(sum(bl.amount), 0) as amount from budget_lines bl join accounts a on a.id = bl.account_id and a.org_id = bl.org_id where bl.org_id = ${authz.user.orgId} and bl.scenario_id = ${target.scenarioId} ${account} ${dims} ${subsidiaryFilter}`),
    db.execute(sql`
      select bl.id, ap.name as period, a.number, a.name as account, bl.note, bl.amount
        from budget_lines bl join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
        join accounting_periods ap on ap.id = bl.period_id and ap.org_id = bl.org_id
       where bl.org_id = ${authz.user.orgId} and bl.scenario_id = ${target.scenarioId} ${account} ${dims}
         ${subsidiaryFilter}
       order by ap.starts_on, a.number nulls last, a.name
       limit ${REPORT_DRILL_PAGE_SIZE} offset ${offset}`),
  ])
  return {
    title: target.label,
    description: tr('drillDrawer.supporting'),
    summary: [{ label: tc('labels.total'), value: money(String(count.rows[0]?.amount ?? 0)) }],
    columns: [{ label: tc('labels.period') }, { label: tc('labels.account') }, { label: tc('labels.memo') }, { label: tc('labels.amount'), align: 'right' }],
    rows: (rows.rows as unknown as BudgetLineSqlRow[]).map((item) => ({ key: item.id, cells: [item.period, [item.number, item.account].filter(Boolean).join(' · '), item.note, money(String(item.amount))] })),
    page,
    perPage: REPORT_DRILL_PAGE_SIZE,
    total: Number(count.rows[0]?.n ?? 0),
  }
}

export async function loadReportDrillData(target: ReportDrillTarget, authz: Authz, page: number): Promise<ReportDrillResponse> {
  if (target.kind === 'ledger') return ledgerData(target, authz, page)
  if (target.kind === 'aging') return agingData(target, authz, page)
  if (target.kind === 'orders') return orderData(target, authz, page)
  if (target.kind === 'time') return timeData(target, authz, page)
  if (target.kind === 'budget') return budgetData(target, authz, page)
  return customData(target, authz, page)
}
