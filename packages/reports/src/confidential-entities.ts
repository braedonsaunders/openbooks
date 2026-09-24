import { queryIdentifier } from './custom-record-entities'
import type { ReportEntity, ReportEntityColumn } from './entities'

/**
 * Source-level payroll confidentiality for the line-grain report entities.
 *
 * Readers WITHOUT payroll.read must never isolate one employee's net pay —
 * not through a limit:1 plan, an amount equality oracle, a party/entry
 * breakout, or a sort — while every total still ties to the ledger. Masking
 * identity expressions is not enough (per-leg amounts survive), and
 * collapsing AFTER the query is too late (LIMIT already kept the
 * pre-collapse row). So restricted readers compile against a pre-collapsed
 * grain: party-tagged payroll legs are aggregated per (entry, account,
 * currency) INSIDE the entity FROM, before any caller filter, breakout,
 * grouping, sort, or LIMIT in any mode.
 *
 * Mechanism: the restricted entity reads from a UNION ALL of two arms with
 * identical output columns —
 * - the detail arm: every non-payroll-leg row at line grain, untouched;
 * - the collapsed arm: payroll legs grouped by entry/account/currency, money
 *   summed exactly, identity replaced by the restricted label, everything
 *   else carried as the group MINIMUM (legs of one group share entry-level
 *   values; the minimum is deterministic and exact for single-row groups).
 * The two arms are disjoint by construction (NOT leg vs leg), and the leg
 * predicate is NULL-safe (coalesced), so no row vanishes from both arms.
 * Granted readers get the base entity untouched — byte-identical plans.
 */

export const PAYROLL_RESTRICTED_PARTY_LABEL = 'Payroll (restricted)'

/** Collapse group for one entity: entry + account + currency affinity. */
type CollapseSpec = {
  /** Extra JOIN fragment the base FROM needs for the leg signal. */
  docJoin: string
  /** SQL boolean, TRUE exactly for collapsible party-tagged payroll legs. */
  leg: string
  /** GROUP BY expressions for the collapsed arm. */
  groupBy: string[]
  /** Per-column overrides for the collapsed arm (identity masking). */
  mask: (column: ReportEntityColumn) => string | null
}

const LEDGER_DOC_JOIN =
  ' LEFT JOIN documents dsrc ON dsrc.id = je.source_document_id AND dsrc.org_id = jl.org_id'

function ledgerMask(column: ReportEntityColumn): string | null {
  if (column.key === 'party_name') return `'${PAYROLL_RESTRICTED_PARTY_LABEL}'`
  if (column.key === 'party_id') return 'NULL'
  // The entry memo ("Net pay RUN-001") carries no per-employee identity; a
  // line memo can carry a cheque number, so collapsed rows fall back to it.
  if (column.key === 'memo') return 'min(je.memo)'
  return null
}

function transactionMask(column: ReportEntityColumn): string | null {
  if (column.key === 'party_name') return `'${PAYROLL_RESTRICTED_PARTY_LABEL}'`
  if (column.key === 'employee_name') return `'${PAYROLL_RESTRICTED_PARTY_LABEL}'`
  // Line descriptions can carry per-employee references; the collapsed row
  // keeps none of them.
  if (column.key === 'description') return 'NULL'
  return null
}

const SPECS: Record<string, CollapseSpec> = {
  ledger_lines: {
    docJoin: LEDGER_DOC_JOIN,
    leg: `(coalesce(dsrc.kind, '') = 'pay_run' or coalesce(je.origin, '') = 'payroll') and jl.party_id is not null`,
    groupBy: ['je.id', 'jl.account_id', 'jl.currency', 'sub.base_currency'],
    mask: ledgerMask,
  },
  transaction_lines: {
    docJoin: '',
    leg: `coalesce(d.kind, '') = 'pay_run' and (dl.party_id is not null or dl.employee_id is not null)`,
    groupBy: ['dl.document_id', 'dl.account_id', 'd.currency'],
    mask: transactionMask,
  },
}

function quoteKey(key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Cannot collapse unquotable column ${key}`)
  return queryIdentifier(key)
}

/**
 * The restricted reading of one line-grain entity: payroll legs arrive
 * pre-collapsed per (entry, account, currency) with masked identity and
 * summed money; every other row arrives untouched at line grain. Returns the
 * base entity unchanged for granted readers (byte-identical plans) and for
 * entities with no collapsible payroll grain, so callers apply this blindly
 * per reader grant.
 */
export function payrollRestrictedEntity(entity: ReportEntity, canSeePayroll: boolean): ReportEntity {
  if (canSeePayroll) return entity
  const spec = SPECS[entity.key]
  if (!spec) return entity
  const detailCols = entity.columns.map((c) => `${c.expr} AS ${quoteKey(c.key)}`).join(', ')
  const collapsedCols = entity.columns
    .map((c) => {
      const masked = spec.mask(c)
      if (masked) return `${masked} AS ${quoteKey(c.key)}`
      if (c.kind === 'money') return `sum(${c.expr}) AS ${quoteKey(c.key)}`
      // Postgres has no min(boolean): legs of one group share their flags,
      // and AND fails closed where they ever differ.
      if (c.kind === 'boolean') return `bool_and(${c.expr}) AS ${quoteKey(c.key)}`
      // Postgres has no min(uuid) either: group members share their ids, so
      // the text minimum cast back is exact and deterministic.
      if (c.kind === 'uuid') return `min(${c.expr}::text)::uuid AS ${quoteKey(c.key)}`
      return `min(${c.expr}) AS ${quoteKey(c.key)}`
    })
    .join(', ')
  // Scope ids are uuids: min() them through text, like uuid columns below.
  const scopeMin = (expr: string | undefined): string =>
    expr ? `min(${expr}::text)::uuid` : 'NULL'
  const from = `((SELECT ${detailCols}, ${entity.orgColumn} AS ${quoteKey('__org_id')}, ${entity.subsidiaryScope?.column ?? 'NULL'} AS ${quoteKey('__subsidiary_id')}, ${entity.bookScope ? entity.bookScope.column : 'NULL'} AS ${quoteKey('__book_id')} FROM ${entity.from}${spec.docJoin} WHERE NOT (${spec.leg})) UNION ALL (SELECT ${collapsedCols}, ${scopeMin(entity.orgColumn)} AS ${quoteKey('__org_id')}, ${scopeMin(entity.subsidiaryScope?.column)} AS ${quoteKey('__subsidiary_id')}, ${entity.bookScope ? scopeMin(entity.bookScope.column) : 'NULL'} AS ${quoteKey('__book_id')} FROM ${entity.from}${spec.docJoin} WHERE ${spec.leg} GROUP BY ${spec.groupBy.join(', ')})) rc`
  const columns = entity.columns.map((c) => ({ ...c, expr: `rc.${quoteKey(c.key)}` }))
  return {
    ...entity,
    from,
    orgColumn: `rc.${quoteKey('__org_id')}`,
    subsidiaryScope: entity.subsidiaryScope ? { ...entity.subsidiaryScope, column: `rc.${quoteKey('__subsidiary_id')}` } : entity.subsidiaryScope,
    bookScope: entity.bookScope ? { column: `rc.${quoteKey('__book_id')}` } : undefined,
    columns,
  }
}
