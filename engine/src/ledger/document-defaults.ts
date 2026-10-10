import { sql } from 'drizzle-orm'
import type { SqlExecutor } from '../platform/db.ts'
import { addCalendarDays, isIsoCalendarDate } from '../platform/civil-date.ts'
import { isUuid } from '../platform/uuid.ts'
import { isFeatureEnabled } from '../organization/feature-state.ts'
import { docKindConfig, type DocKindConfig } from '../records/document-kinds.ts'

/**
 * Document header and line defaults: the one resolver behind the document
 * drawer's pre-save defaults and the server's create/edit writes.
 *
 * Due date. A kind that declares `dueDateFromTerms` (invoices and bills)
 * derives its due date from the party's active payment terms: document date
 * plus the terms' net days ("Due on receipt" is 0, "Net 15" is 15). A party
 * without terms derives nothing; the due date simply stays unset.
 *
 * Line account. Sales lines take the item's income account. Purchase lines
 * take the account the bill actually debits for the item: for a stocked item
 * in an inventory-enabled organization, the received-not-billed clearing
 * account when configured, else the inventory asset account (the same rule as
 * engine/src/inventory/documents-purchasing.ts); otherwise the item's expense
 * account, then the vendor's default expense account.
 *
 * Line tax. The party's tax code (customer for sales, vendor for purchases)
 * states the party's treatment — an exemption or its jurisdiction's code —
 * and takes precedence; otherwise the item's tax code.
 *
 * Every default must be usable as-is: inactive or summary accounts, accounts
 * outside the kind's allowed account types, and inactive tax codes are never
 * proposed. A missing default is reported as null with no source, never
 * replaced by a guess.
 */

export class DocumentDefaultsError extends Error {
  readonly status = 422
  constructor(message: string) {
    super(message)
    this.name = 'DocumentDefaultsError'
  }
}

export interface TermsDueDate {
  termsId: string
  termsName: string
  netDays: number
  dueDate: string
}

export type LineAccountSource = 'item_income' | 'inventory_clearing' | 'inventory_asset' | 'item_expense' | 'vendor_expense'
export type LineTaxSource = 'party' | 'item'

export interface DocumentLineDefault {
  itemId: string
  accountId: string | null
  accountSource: LineAccountSource | null
  taxCodeId: string | null
  taxSource: LineTaxSource | null
}

/** Due date for a document dated `documentDate` under terms of `netDays`. */
export function dueDateFromNetDays(documentDate: string, netDays: number): string {
  if (!isIsoCalendarDate(documentDate)) throw new DocumentDefaultsError('document date must be a calendar date (YYYY-MM-DD)')
  if (!Number.isSafeInteger(netDays) || netDays < 0) {
    throw new DocumentDefaultsError(`payment terms must state zero or more net days; found ${String(netDays)}. Correct the terms in Setup → Payment terms`)
  }
  return addCalendarDays(documentDate, netDays)
}

function partyRoleOf(cfg: DocKindConfig): 'customer' | 'vendor' | null {
  return cfg.partyRole ?? cfg.optionalPartyRole ?? null
}

/**
 * The due date the party's payment terms imply, or null when the kind does
 * not derive one, no party is named, or the party has no active terms.
 */
export async function resolveTermsDueDate(
  exec: SqlExecutor,
  orgId: string,
  input: { kind: string; partyId: string | null | undefined; documentDate: string },
): Promise<TermsDueDate | null> {
  const cfg = docKindConfig(input.kind)
  if (!cfg?.dueDateFromTerms || !input.partyId || !isUuid(input.partyId)) return null
  const role = partyRoleOf(cfg)
  if (!role) return null
  const roleTable = sql.raw(role === 'customer' ? 'customer_roles' : 'vendor_roles')
  const terms = (await exec.execute<{ id: string; name: string; net_days: number }>(sql`
    select pt.id, pt.name, pt.net_days
      from ${roleTable} r
      join payment_terms pt on pt.id = r.payment_terms_id and pt.org_id = r.org_id and pt.is_active
     where r.org_id = ${orgId} and r.party_id = ${input.partyId}`)).rows[0]
  if (!terms) return null
  const netDays = Number(terms.net_days)
  return { termsId: terms.id, termsName: terms.name, netDays, dueDate: dueDateFromNetDays(input.documentDate, netDays) }
}

interface ItemDefaultsRow {
  id: string
  income_account_id: string | null
  expense_account_id: string | null
  tax_code_id: string | null
  inventory_asset_account_id: string | null
  inventory_clearing_account_id: string | null
}

/**
 * Account and tax defaults for each named item on a line of `kind`, in the
 * order the items were named (duplicates collapse). Unknown, foreign or
 * inactive items are omitted.
 */
export async function resolveDocumentLineDefaults(
  exec: SqlExecutor,
  orgId: string,
  input: { kind: string; partyId?: string | null; itemIds: readonly string[] },
): Promise<DocumentLineDefault[]> {
  const cfg = docKindConfig(input.kind)
  const side = cfg?.lineDefaults
  const itemIds = [...new Set(input.itemIds.filter(isUuid))]
  if (!cfg || !side || itemIds.length === 0) return []

  const items = (await exec.execute<ItemDefaultsRow>(sql`
    select i.id, i.income_account_id, i.expense_account_id, i.tax_code_id,
           p.asset_account_id as inventory_asset_account_id,
           p.received_not_billed_account_id as inventory_clearing_account_id
      from items i
      left join item_inventory_profiles p on p.org_id = i.org_id and p.item_id = i.id
     where i.org_id = ${orgId} and i.is_active
       and i.id in (${sql.join(itemIds.map((id) => sql`${id}`), sql`, `)})`)).rows
  if (items.length === 0) return []

  const role = partyRoleOf(cfg)
  const partyId = input.partyId && isUuid(input.partyId) && role ? input.partyId : null
  const party = partyId
    ? (role === 'customer'
      ? (await exec.execute<{ tax_code_id: string | null; default_expense_account_id: string | null }>(sql`
          select tax_code_id, null::uuid as default_expense_account_id from customer_roles
           where org_id = ${orgId} and party_id = ${partyId} and is_active`)).rows[0]
      : (await exec.execute<{ tax_code_id: string | null; default_expense_account_id: string | null }>(sql`
          select tax_code_id, default_expense_account_id from vendor_roles
           where org_id = ${orgId} and party_id = ${partyId} and is_active`)).rows[0])
    : undefined
  const inventoryRouted = side === 'purchase' && items.some((item) => item.inventory_asset_account_id)
    ? await isFeatureEnabled(orgId, 'inventory', exec)
    : false

  const candidateAccounts = new Set<string>()
  const candidateTaxCodes = new Set<string>()
  for (const item of items) {
    for (const id of [item.income_account_id, item.expense_account_id, item.inventory_asset_account_id, item.inventory_clearing_account_id]) {
      if (id) candidateAccounts.add(id)
    }
    if (item.tax_code_id) candidateTaxCodes.add(item.tax_code_id)
  }
  if (party?.default_expense_account_id) candidateAccounts.add(party.default_expense_account_id)
  if (party?.tax_code_id) candidateTaxCodes.add(party.tax_code_id)

  const typeFilter = cfg.accountTypes
    ? sql` and type in (${sql.join(cfg.accountTypes.map((type) => sql`${type}`), sql`, `)})`
    : sql``
  const usableAccounts = candidateAccounts.size
    ? new Set((await exec.execute<{ id: string }>(sql`
        select id from accounts
         where org_id = ${orgId} and is_active and not is_summary ${typeFilter}
           and id in (${sql.join([...candidateAccounts].map((id) => sql`${id}`), sql`, `)})`)).rows.map((row) => row.id))
    : new Set<string>()
  const usableTaxCodes = candidateTaxCodes.size
    ? new Set((await exec.execute<{ id: string }>(sql`
        select id from tax_codes
         where org_id = ${orgId} and is_active
           and id in (${sql.join([...candidateTaxCodes].map((id) => sql`${id}`), sql`, `)})`)).rows.map((row) => row.id))
    : new Set<string>()

  const pick = <S extends string>(choices: [string | null | undefined, S][], usable: Set<string>) => {
    for (const [id, source] of choices) if (id && usable.has(id)) return { id, source }
    return { id: null, source: null }
  }
  const byId = new Map(items.map((item) => [item.id, item]))
  return itemIds.flatMap((itemId) => {
    const item = byId.get(itemId)
    if (!item) return []
    const account = side === 'sales'
      ? pick<LineAccountSource>([[item.income_account_id, 'item_income']], usableAccounts)
      : inventoryRouted && item.inventory_asset_account_id
        // The posting router debits clearing-else-asset for a stocked line
        // whatever the line names, so propose exactly that account.
        ? pick<LineAccountSource>([
            [item.inventory_clearing_account_id, 'inventory_clearing'],
            [item.inventory_clearing_account_id ? null : item.inventory_asset_account_id, 'inventory_asset'],
          ], usableAccounts)
        : pick<LineAccountSource>([
            [item.expense_account_id, 'item_expense'],
            [party?.default_expense_account_id, 'vendor_expense'],
          ], usableAccounts)
    const tax = cfg.hasTax
      ? pick<LineTaxSource>([[party?.tax_code_id, 'party'], [item.tax_code_id, 'item']], usableTaxCodes)
      : { id: null, source: null }
    return [{ itemId, accountId: account.id, accountSource: account.source, taxCodeId: tax.id, taxSource: tax.source }]
  })
}
