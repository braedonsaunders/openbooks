import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { AP_KINDS, AR_KINDS } from '../document-kinds'
import {
  DOCUMENT_BUILT_IN_EXPR,
  DOCUMENT_SORTS,
  PAYMENT_BANK_ID_EXPR,
  PAYMENT_BUILT_IN_EXPR,
  PAYMENT_SORTS,
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
  links?: Record<string, (row: any) => string | null>
}

/** The `documents d left join parties p` base every source builds on. */
export const DOCUMENT_BASE_JOIN = sql`left join parties p on p.id = d.party_id`

/** party_id → vendor/customer/employee drawer href. */
const partyLink = (role: 'vendors' | 'customers' | 'employees') => (row: any) =>
  row.party_id ? `/entities/${role}?party=${row.party_id}` : null

/** A standard documents list source (number/party/date/ref/total/status). */
function documentSource(cfg: {
  recordType: string
  kinds: readonly string[]
  drawerParam: string
  multiKind?: boolean
  partyRole?: 'vendors' | 'customers' | 'employees'
  builtInExpr?: Record<string, SQL>
  joins?: SQL
  extraSelect?: SQL
  links?: Record<string, (row: any) => string | null>
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
  }
}

const SOURCES: Record<string, DocListSource> = {
  vendor_bill: documentSource({
    recordType: 'vendor_bill',
    kinds: AP_KINDS,
    drawerParam: 'doc',
    multiKind: true,
    partyRole: 'vendors',
  }),
  customer_invoice: documentSource({
    recordType: 'customer_invoice',
    kinds: AR_KINDS,
    drawerParam: 'doc',
    multiKind: true,
    partyRole: 'customers',
  }),
  vendor_payment: {
    recordType: 'vendor_payment',
    kinds: ['vendor_payment'],
    drawerParam: 'payment',
    // The custom bank account (`ca`) is referenced by the funding-account exprs.
    joins: sql`left join accounts ca on ca.id = (d.custom->>'bankAccountId')::uuid`,
    builtInExpr: PAYMENT_BUILT_IN_EXPR,
    sorts: PAYMENT_SORTS,
    extraSelect: sql`d.party_id, ${PAYMENT_BANK_ID_EXPR} as bank_account_id`,
    links: {
      party_name: partyLink('vendors'),
      bank_account: (row: any) => (row.bank_account_id ? `/accounts/${row.bank_account_id}` : null),
    },
  },
  customer_payment: {
    recordType: 'customer_payment',
    kinds: ['customer_payment'],
    drawerParam: 'payment',
    joins: sql`left join accounts ca on ca.id = (d.custom->>'bankAccountId')::uuid`,
    builtInExpr: PAYMENT_BUILT_IN_EXPR,
    sorts: PAYMENT_SORTS,
    extraSelect: sql`d.party_id, ${PAYMENT_BANK_ID_EXPR} as bank_account_id`,
    links: {
      party_name: partyLink('customers'),
      bank_account: (row: any) => (row.bank_account_id ? `/accounts/${row.bank_account_id}` : null),
    },
  },
  // Orders — single kind, non-posting; edited via OrderDrawer (drawerParam set
  // per page's URL param). Conversion progress lives in a report, not here.
  quote: documentSource({ recordType: 'quote', kinds: ['quote'], drawerParam: 'estimate', partyRole: 'customers' }),
  sales_order: documentSource({ recordType: 'sales_order', kinds: ['sales_order'], drawerParam: 'order', partyRole: 'customers' }),
  purchase_order: documentSource({ recordType: 'purchase_order', kinds: ['purchase_order'], drawerParam: 'order', partyRole: 'vendors' }),
}

export function listSource(recordType: string): DocListSource | undefined {
  return SOURCES[recordType]
}
