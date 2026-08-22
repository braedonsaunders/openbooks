import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { ListViewConfig } from '@openbooks/customization'
import { AP_KINDS, AR_KINDS } from '../document-kinds'
import {
  DOCUMENT_BUILT_IN_EXPR,
  DOCUMENT_SORTS,
  PAYMENT_BANK_ID_EXPR,
  PAYMENT_BUILT_IN_EXPR,
  PAYMENT_SORTS,
  BANK_TRANSACTION_ACCOUNT_MATCH,
  bankTransactionWhere,
  payRunWhere,
  type AdhocFilters,
} from '../customization/list-query'

/**
 * Document-list data sources — the SQL half of the universal list page. Every
 * `documents`-backed list (bills, invoices, orders, payments…) shares the same
 * toolbar/table/view machinery (components/record-list-view.tsx); this registry
 * is the ONLY place their queries differ: which kinds, which joins, which
 * built-in column expressions, and where each entity cell drills through to.
 *
 * A record type is customizable (saved views, column picker) iff it is in the
 * customization registry (packages/customization). This source supplies the SQL
 * for its built-in columns; custom (cf_*) columns are handled generically.
 */
export interface DocListSource {
  /** Customization record type key (must exist in RECORD_TYPES). */
  recordType: string
  /** Document kinds this list includes (multi-kind lists show a type badge). */
  kinds: readonly string[]
  /** URL param the reference cell toggles to open the drawer: /base?<param>=<id>. */
  drawerParam: string
  /** Show a DocTypeBadge beside the reference number (mixed-kind lists). */
  multiKind?: boolean
  /** Extra FROM joins beyond `documents d left join parties p`. Aliased freely. */
  joins?: SQL
  /** Built-in column key → SELECT expression. */
  builtInExpr: Record<string, SQL>
  /** Sort key → ORDER BY expression. */
  sorts: Record<string, SQL>
  /** Always-selected extra fields (ids for drill-through links). */
  extraSelect?: SQL
  /** Column key → row→href builder for entity drill-through. */
  links?: Record<string, (row: any) => string | RelatedPartyTarget | null>
  /** Additional record-specific quick filters beyond kind and status. */
  quickFilters?: DocQuickFilter[]
  /** URL key for the mixed-kind picker (default `kind`). */
  kindParamKey?: string
  /** Render and apply the common `from` / `to` date range controls. */
  dateRange?: boolean
  /** Suppress the built-in document-status chips (sources whose quick filters
   *  present a richer merged status, e.g. the pay-run lifecycle). */
  hideStatusFilter?: boolean
  /** Source-specific WHERE extension for list-only aggregates. */
  where?: (
    kinds: readonly string[],
    view: ListViewConfig,
    adhoc: AdhocFilters,
    orgId: string,
    allowedSubsidiaryIds?: Set<string> | null,
  ) => SQL
}

export interface DocQuickFilter {
  paramKey: string
  filterKey: string
  loadOptions?: (orgId: string) => Promise<{ value: string; label: string; count?: number }[]>
  searchSelect?: boolean
}

export interface RelatedPartyTarget {
  kind: 'party'
  id: string
  role: 'customer' | 'vendor' | 'employee'
}

/** The `documents d left join parties p` base every source builds on. */
export const DOCUMENT_BASE_JOIN = sql`left join parties p on p.id = d.party_id and p.org_id = d.org_id`

/** party_id → vendor/customer/employee drawer href. */
const partyLink = (role: RelatedPartyTarget['role']) => (row: any): RelatedPartyTarget | null =>
  row.party_id ? { kind: 'party', id: String(row.party_id), role } : null

/** A standard documents list source (number/party/date/ref/total/status). */
function documentSource(cfg: {
  recordType: string
  kinds: readonly string[]
  drawerParam: string
  multiKind?: boolean
  partyRole?: RelatedPartyTarget['role']
  builtInExpr?: Record<string, SQL>
  joins?: SQL
  extraSelect?: SQL
  links?: Record<string, (row: any) => string | null>
  quickFilters?: DocQuickFilter[]
}): DocListSource {
  return {
    recordType: cfg.recordType,
    kinds: cfg.kinds,
    drawerParam: cfg.drawerParam,
    multiKind: cfg.multiKind,
    joins: cfg.joins,
    builtInExpr: cfg.builtInExpr ?? DOCUMENT_BUILT_IN_EXPR,
    sorts: DOCUMENT_SORTS,
    extraSelect: cfg.extraSelect ?? sql`d.party_id`,
    links: {
      ...(cfg.partyRole ? { party_name: partyLink(cfg.partyRole) } : {}),
      ...(cfg.links ?? {}),
    },
    quickFilters: cfg.quickFilters,
  }
}

const SOURCES: Record<string, DocListSource> = {
  vendor_bill: documentSource({
    recordType: 'vendor_bill',
    kinds: AP_KINDS,
    drawerParam: 'doc',
    multiKind: true,
    partyRole: 'vendor',
  }),
  customer_invoice: documentSource({
    recordType: 'customer_invoice',
    kinds: AR_KINDS,
    drawerParam: 'doc',
    multiKind: true,
    partyRole: 'customer',
  }),
  vendor_payment: {
    recordType: 'vendor_payment',
    kinds: ['vendor_payment'],
    drawerParam: 'payment',
    // The custom bank account (`ca`) is referenced by the funding-account exprs.
    joins: sql`left join accounts ca on ca.id = (d.custom->>'bankAccountId')::uuid and ca.org_id = d.org_id`,
    builtInExpr: PAYMENT_BUILT_IN_EXPR,
    sorts: PAYMENT_SORTS,
    extraSelect: sql`d.party_id, ${PAYMENT_BANK_ID_EXPR} as bank_account_id`,
    links: {
      party_name: partyLink('vendor'),
      bank_account: (row: any) => (row.bank_account_id ? `/accounts?accountRegister=${row.bank_account_id}` : null),
    },
  },
  customer_payment: {
    recordType: 'customer_payment',
    kinds: ['customer_payment'],
    drawerParam: 'payment',
    joins: sql`left join accounts ca on ca.id = (d.custom->>'bankAccountId')::uuid and ca.org_id = d.org_id`,
    builtInExpr: PAYMENT_BUILT_IN_EXPR,
    sorts: PAYMENT_SORTS,
    extraSelect: sql`d.party_id, ${PAYMENT_BANK_ID_EXPR} as bank_account_id`,
    links: {
      party_name: partyLink('customer'),
      bank_account: (row: any) => (row.bank_account_id ? `/accounts?accountRegister=${row.bank_account_id}` : null),
    },
  },
  expense_report: documentSource({
    recordType: 'expense_report',
    kinds: ['expense_report'],
    drawerParam: 'expense',
    partyRole: 'employee',
    quickFilters: [{
      paramKey: 'employee',
      filterKey: 'party_id',
      loadOptions: async (orgId) => {
        const result = await db.execute(sql`
          select p.id::text as value, p.display_name as label, count(*)::int as count
            from documents d join parties p on p.id = d.party_id and p.org_id = d.org_id
           where d.org_id = ${orgId} and d.kind = 'expense_report'
           group by p.id, p.display_name
           order by p.display_name`) as any
        return result.rows
      },
    }],
  }),
  // Orders — single kind, non-posting; edited via OrderDrawer (drawerParam set
  // per page's URL param). Conversion progress lives in a report, not here.
  quote: documentSource({ recordType: 'quote', kinds: ['quote'], drawerParam: 'estimate', partyRole: 'customer' }),
  sales_order: documentSource({ recordType: 'sales_order', kinds: ['sales_order'], drawerParam: 'order', partyRole: 'customer' }),
  field_ticket: documentSource({
    recordType: 'field_ticket',
    kinds: ['field_ticket'],
    drawerParam: 'ticket',
    partyRole: 'customer',
    joins: sql`join field_tickets ft on ft.document_id = d.id and ft.org_id = d.org_id
               left join projects ftproj on ftproj.id = d.project_id and ftproj.org_id = d.org_id`,
    builtInExpr: {
      ...DOCUMENT_BUILT_IN_EXPR,
      project_name: sql`coalesce(ftproj.code || ' · ' || ftproj.name, ftproj.name)`,
      period: sql`initcap(ft.period)`,
    },
  }),
  purchase_order: documentSource({ recordType: 'purchase_order', kinds: ['purchase_order'], drawerParam: 'order', partyRole: 'vendor' }),
  // Pay runs — 1:1 pay_runs extension joined for period/totals columns; the
  // status column merges the run lifecycle with the document's posted state.
  // Rows open the pay-run wizard (a full page), not a drawer, via the links
  // override on the reference column. The where fn keeps its predicates
  // EXISTS-based so the joinless count queries stay valid.
  pay_run: {
    recordType: 'pay_run',
    kinds: ['pay_run'],
    drawerParam: 'run',
    dateRange: true,
    joins: sql`join pay_runs pr on pr.document_id = d.id and pr.org_id = d.org_id
               left join pay_schedules ps on ps.id = pr.pay_schedule_id and ps.org_id = pr.org_id`,
    builtInExpr: {
      document_number: sql`d.document_number`,
      schedule_name: sql`ps.name`,
      period: sql`pr.period_start::text || ' – ' || pr.period_end::text`,
      pay_date: sql`pr.pay_date::text`,
      gross_total: sql`pr.gross_total`,
      net_total: sql`pr.net_total`,
      employee_count: sql`pr.employee_count::text`,
      status: sql`case when d.status in ('draft', 'approved') then pr.run_status else d.status end`,
    },
    sorts: {
      number: sql`d.document_number`,
      schedule: sql`ps.name`,
      period: sql`pr.period_end`,
      date: sql`pr.pay_date`,
      gross: sql`pr.gross_total`,
      net: sql`pr.net_total`,
      employees: sql`pr.employee_count`,
      status: sql`d.status`,
    },
    links: {
      document_number: (row: any) => `/payroll/runs/${row.id}`,
    },
    where: payRunWhere,
    // The merged-stage chips replace the raw document-status chips (draft
    // covers three run stages, so the built-in chip would mislead).
    hideStatusFilter: true,
    quickFilters: [
      { paramKey: 'stage', filterKey: 'run_stage' },
      {
        paramKey: 'schedule',
        filterKey: 'pay_schedule_id',
        loadOptions: async (orgId) => {
          const result = await db.execute(sql`
            select s.id::text as value, s.name as label, count(pr.document_id)::int as count
              from pay_schedules s
              left join pay_runs pr on pr.pay_schedule_id = s.id and pr.org_id = s.org_id
             where s.org_id = ${orgId}
             group by s.id, s.name
             order by s.name`) as any
          return result.rows
        },
      },
    ],
  },
  bank_transaction: {
    recordType: 'bank_transaction',
    kinds: ['card_charge', 'card_refund', 'check', 'deposit', 'transfer'],
    drawerParam: 'doc',
    multiKind: true,
    kindParamKey: 'txKind',
    dateRange: true,
    joins: sql`left join lateral (
      select string_agg(distinct trim(coalesce(a.number || ' ', '') || a.name), ' · ') as names,
             min(trim(coalesce(a.number || ' ', '') || a.name)) as sort_name
        from accounts a
       where ${BANK_TRANSACTION_ACCOUNT_MATCH}
    ) bank_accounts on true`,
    builtInExpr: {
      document_number: sql`d.document_number`,
      transaction_kind: sql`d.kind`,
      account_names: sql`bank_accounts.names`,
      document_date: sql`d.document_date`,
      memo: sql`d.memo`,
      reference_number: sql`d.reference_number`,
      total: sql`d.total`,
      status: sql`d.status`,
    },
    sorts: {
      ...DOCUMENT_SORTS,
      kind: sql`d.kind`,
      account: sql`bank_accounts.sort_name`,
    },
    where: bankTransactionWhere,
    quickFilters: [{
      paramKey: 'account',
      filterKey: 'bank_account_id',
      searchSelect: true,
      loadOptions: async (orgId) => {
        const result = await db.execute(sql`
          select id::text as value, trim(coalesce(number || ' ', '') || name) as label
            from accounts
           where org_id=${orgId} and is_active and not is_summary and reconcilable
           order by number nulls last, name`) as any
        return result.rows
      },
    }],
  },
}

export function listSource(recordType: string): DocListSource | undefined {
  return SOURCES[recordType]
}
