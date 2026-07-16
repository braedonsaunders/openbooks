import 'server-only'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { runRecordFlows } from '@openbooks/engine/src/flows/index.ts'
import { nextDocumentNumber } from './bills'
import { DOC_KINDS, docKindConfig, type DocKindConfig } from './document-kinds'

/**
 * Unified line-based posting-document machinery.
 *
 * The `documents` table is a single supertype keyed by `kind`; the posting
 * engine (engine/src/posting.ts) holds the per-kind GL rules. The UI for
 * vendor bills, customer invoices, credit memos, card charges, checks, and
 * transfers is structurally identical — a header (party or funding source +
 * dates + memo) and a line grid (account + amount + tax + dimensions). This
 * module is the single source of truth for how each kind is loaded and
 * draft-created, so the drawer, the API, and the list pages never diverge.
 *
 * The kind configuration (client-safe) lives in lib/document-kinds.ts and is
 * re-exported here. The shared math (number sequences, tax computation,
 * tax-rate lookup) lives in lib/bills.ts and is re-exported here; it is fully
 * kind-agnostic.
 */

export { computeBillTotals, taxRateMap, nextDocumentNumber, type BillLineInput } from './bills'
export {
  DOC_KINDS,
  AP_KINDS,
  AR_KINDS,
  BANK_KINDS,
  docKindConfig,
  createPermission,
  postPermission,
  readPermission,
  type DocKindConfig,
  type DocFamily,
  type PermNamespace,
} from './document-kinds'

// ---------------------------------------------------------------------------
// Draft creation + loading
// ---------------------------------------------------------------------------

/** Resolve the org's base currency (used when minting a draft). */
async function orgBaseCurrency(orgId: string): Promise<string> {
  const r = (await db.execute(
    sql`select base_currency from orgs where id = ${orgId}`,
  )) as unknown as { rows: { base_currency: string }[] }
  return r.rows[0]?.base_currency ?? 'CAD'
}

/** Org-level control accounts from orgs.settings.controlAccounts. */
export async function controlDeps(orgId: string) {
  const r = (await db.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`)) as any
  const c = r.rows[0]?.c ?? {}
  return {
    control: {
      ar: c.ar,
      ap: c.ap,
      bank: c.bank,
      taxCollected: c.taxCollected,
      taxPaid: c.taxPaid,
      employeePayable: c.employeePayable,
    },
  }
}

/** Instant-into-draft: mint an empty draft document for a kind, return id + number. */
export async function createDocumentDraft(orgId: string, userId: string, kind: string) {
  const cfg = docKindConfig(kind)
  if (!cfg) throw new Error(`unknown document kind "${kind}"`)
  const currency = await orgBaseCurrency(orgId)
  const documentNumber = await nextDocumentNumber(orgId, kind, cfg.numberPrefix)
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId,
      kind,
      documentNumber,
      documentDate: new Date().toISOString().slice(0, 10),
      currency,
      subtotal: '0',
      taxTotal: '0',
      total: '0',
      createdBy: userId,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber })
  // on_create flows fire AFTER the insert commits. runRecordFlows never
  // throws into the caller (failures land on the flow_runs row), and it is
  // awaited — not detached — so it runs inside this request's RLS org scope.
  await runRecordFlows({ kind: 'on_create' }, kind, doc.id, { orgId, userId })
  return doc
}

/**
 * Full document payload for a drawer: header + lines. For open-item kinds
 * (invoices, credits) the applied amount is summed from un-reversed
 * applications against the posted entry's control open-item line, and
 * `balance_due` = total − applied.
 */
export async function loadDocument(id: string) {
  const doc = (await db.execute(sql`
    select d.*, p.display_name as party_name, e.id as entry_id,
           ${sql`case when d.status = 'posted' then ap.applied end`} as applied,
           ${sql`case when d.status = 'posted' then d.total - ap.applied end`} as balance_due
      from documents d
      left join parties p on p.id = d.party_id
      left join journal_entries e on e.id = d.posted_entry_id
      left join lateral (
        select coalesce(sum(a.amount), 0) as applied
          from journal_lines jl
          join applications a on a.to_line_id = jl.id and a.unapplied_at is null
         where jl.entry_id = d.posted_entry_id and jl.is_open_item
      ) ap on true
     where d.id = ${id}
  `)) as unknown as { rows: Record<string, unknown>[] }
  if (!doc.rows[0]) return null
  const lines = (await db.execute(sql`
    select l.id, l.line_number, l.account_id, l.item_id, l.description, l.quantity, l.unit,
           l.unit_price, l.amount, l.tax_code_id, l.tax_amount,
           l.tax_overridden, l.department_id, l.project_id, l.location_id, l.class_id, l.custom
      from document_lines l
     where l.document_id = ${id}
     order by l.line_number
  `)) as unknown as { rows: Record<string, unknown>[] }
  return { doc: doc.rows[0], lines: lines.rows }
}

// ---------------------------------------------------------------------------
// Picker option loaders (shared by every list page's drawer hydration)
// ---------------------------------------------------------------------------

export interface Opt {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
  label?: string
  last_four?: string
  network?: string
  liability_account_id?: string
}

export async function partyOptions(role: 'vendor' | 'customer'): Promise<Opt[]> {
  const filter =
    role === 'vendor'
      ? sql`custom->>'nsKind' = 'vendor'`
      : sql`(custom->>'nsKind' = 'customer'
             or exists (select 1 from customer_roles cr where cr.party_id = parties.id))`
  const r = (await db.execute(sql`
    select id, display_name from parties
     where ${filter} and is_active
     order by display_name limit 2000
  `)) as unknown as { rows: Opt[] }
  return r.rows
}

export async function accountOptions(cfg: DocKindConfig): Promise<Opt[]> {
  const typeFilter = cfg.accountTypes
    ? sql` and a.type in (${sql.join(cfg.accountTypes.map((ty) => sql`${ty}`), sql`, `)})`
    : sql``
  const r = (await db.execute(sql`
    select id, number, name from accounts a
     where a.is_active and not a.is_summary ${typeFilter}
     order by a.number nulls last
  `)) as unknown as { rows: Opt[] }
  return r.rows
}

export async function taxCodeOptions(): Promise<Opt[]> {
  const r = (await db.execute(sql`
    select tc.id, tc.code, tc.name, coalesce(tr.rate_percent, 0) as rate
      from tax_codes tc
      left join lateral (
        select rate_percent from tax_rates
         where tax_code_id = tc.id and effective_from <= now()
         order by effective_from desc limit 1) tr on true
     where tc.is_active order by tc.code
  `)) as unknown as { rows: Opt[] }
  return r.rows
}

export async function dimensionOptions() {
  const [departments, projects, locations, classes] = await Promise.all([
    db.execute(sql`select id, name from departments where is_active order by name`) as any,
    db.execute(sql`select id, name from projects where is_active order by name limit 2000`) as any,
    db.execute(sql`select id, name from locations where is_active order by name`) as any,
    db.execute(sql`select id, name from classes where is_active order by name`) as any,
  ])
  return {
    departments: departments.rows as Opt[],
    projects: projects.rows as Opt[],
    locations: locations.rows as Opt[],
    classes: classes.rows as Opt[],
  }
}

/** Active catalog items (for the optional line `item` column). */
export async function itemOptions(): Promise<Opt[]> {
  const r = (await db.execute(sql`
    select id, code, name from items where is_active order by coalesce(code, name), name limit 2000
  `)) as unknown as { rows: Opt[] }
  return r.rows
}

/** Active corporate cards (for card_charge / card_refund funding source). */
export async function cardOptions(): Promise<Opt[]> {
  const r = (await db.execute(sql`
    select pc.id, pc.label, pc.last_four, pc.network, pc.liability_account_id, p.display_name as holder
      from payment_cards pc
      left join parties p on p.id = pc.holder_party_id
     where pc.is_active
     order by pc.label
  `)) as unknown as { rows: any[] }
  return r.rows.map((c) => ({
    id: c.id,
    label: c.last_four ? `${c.label}` : c.label,
    display_name: c.last_four ? `${c.network ?? ''} •••• ${c.last_four} — ${c.holder ?? ''}`.trim() : c.label,
    last_four: c.last_four,
    network: c.network,
    liability_account_id: c.liability_account_id,
  }))
}

/** Reconcilable bank accounts (for check funding source + transfer legs). */
export async function bankAccountOptions(): Promise<Opt[]> {
  const r = (await db.execute(sql`
    select id, number, name from accounts
     where is_active and not is_summary and reconcilable and type = 'asset_bank'
     order by number nulls last
  `)) as unknown as { rows: Opt[] }
  return r.rows
}
