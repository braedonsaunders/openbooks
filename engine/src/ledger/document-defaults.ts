import { sql, type SQL } from 'drizzle-orm'
import type { SqlExecutor } from '../platform/db.ts'
import { addCalendarDays, isIsoCalendarDate } from '../platform/civil-date.ts'
import { isUuid } from '../platform/uuid.ts'
import { businessTodayInTx } from '../platform/business-date.ts'
import { subsidiaryVisibleFilter } from '../organization/subsidiary-scope.ts'
import { isFeatureEnabled } from '../organization/feature-state.ts'
import { docKindConfig, type DocKindConfig } from '../records/document-kinds.ts'
import { loadCompanyReceivedNotBilledAccount } from '../records/control-accounts.ts'

/**
 * Document header and line defaults: the one resolver behind the document
 * drawer's pre-save defaults and the server's create/edit writes.
 *
 * Due date. A kind that declares `dueDateFromTerms` (invoices and bills)
 * derives its due date from the party's active payment terms: document date
 * plus the terms' net days ("Due on receipt" is 0, "Net 15" is 15). A party
 * without terms falls back to the company default terms; with neither, the
 * due date simply stays unset and the drawer names the missing terms.
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
  /** `party` when the party's own terms apply, `company` when the organization's default does. */
  source: 'party' | 'company'
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
 * not derive one or no party is named. A party without active terms falls
 * back to the organization's default payment terms (Company Settings →
 * Billing defaults); only when neither names usable terms is null returned.
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
     where r.org_id = ${orgId} and r.party_id = ${input.partyId}`, 'objects'))[0]
  if (terms) {
    const netDays = Number(terms.net_days)
    return { termsId: terms.id, termsName: terms.name, netDays, dueDate: dueDateFromNetDays(input.documentDate, netDays), source: 'party' }
  }
  return resolveCompanyTermsDueDate(exec, orgId, input.documentDate)
}

/**
 * The due date the organization's default payment terms imply, or null when
 * no default is configured or the default names no active terms. A stored
 * default pointing at retired terms is ignored rather than refused: terms
 * can be deactivated after the default is saved, and the drawer simply shows
 * the field blank with the no-terms hint.
 */
export async function resolveCompanyTermsDueDate(
  exec: SqlExecutor,
  orgId: string,
  documentDate: string,
): Promise<TermsDueDate | null> {
  const billing = (await exec.execute<{ billing: { defaultPaymentTermsId?: unknown } | null }>(sql`
    select coalesce(settings->'billing', '{}'::jsonb) as billing from orgs where id = ${orgId}`, 'objects'))[0]?.billing
  const defaultId = typeof billing?.defaultPaymentTermsId === 'string' && isUuid(billing.defaultPaymentTermsId)
    ? billing.defaultPaymentTermsId
    : null
  if (!defaultId) return null
  const terms = (await exec.execute<{ id: string; name: string; net_days: number }>(sql`
    select id, name, net_days from payment_terms
     where org_id = ${orgId} and id = ${defaultId} and is_active`, 'objects'))[0]
  if (!terms) return null
  const netDays = Number(terms.net_days)
  return { termsId: terms.id, termsName: terms.name, netDays, dueDate: dueDateFromNetDays(documentDate, netDays), source: 'company' }
}

type ItemDefaultsRow = {
  id: string
  income_account_id: string | null
  expense_account_id: string | null
  tax_code_id: string | null
  inventory_asset_account_id: string | null
  inventory_clearing_account_id: string | null
};

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

  const items = await exec.execute<ItemDefaultsRow>(sql`
    select i.id, i.income_account_id, i.expense_account_id, i.tax_code_id,
           p.asset_account_id as inventory_asset_account_id,
           p.received_not_billed_account_id as inventory_clearing_account_id
      from items i
      left join item_inventory_profiles p on p.org_id = i.org_id and p.item_id = i.id
     where i.org_id = ${orgId} and i.is_active
       and i.id in (${sql.join(itemIds.map((id) => sql`${id}`), sql`, `)})`, 'objects')
  if (items.length === 0) return []

  const role = partyRoleOf(cfg)
  const partyId = input.partyId && isUuid(input.partyId) && role ? input.partyId : null
  const party = partyId
    ? (role === 'customer'
      ? (await exec.execute<{ tax_code_id: string | null; default_expense_account_id: string | null }>(sql`
          select tax_code_id, null::uuid as default_expense_account_id from customer_roles
           where org_id = ${orgId} and party_id = ${partyId} and is_active`, 'objects'))[0]
      : (await exec.execute<{ tax_code_id: string | null; default_expense_account_id: string | null }>(sql`
          select tax_code_id, default_expense_account_id from vendor_roles
           where org_id = ${orgId} and party_id = ${partyId} and is_active`, 'objects'))[0])
    : undefined
  const inventoryRouted = side === 'purchase' && items.some((item) => item.inventory_asset_account_id)
    ? await isFeatureEnabled(orgId, 'inventory', exec)
    : false
  // The posting router clears profile-then-company RNB for matched stock
  // lines, so the proposal mirrors that order — never the asset account
  // while a clearing account stands behind the item.
  const companyClearingAccountId = inventoryRouted
    ? (await loadCompanyReceivedNotBilledAccount(exec, orgId))
    : null

  const candidateAccounts = new Set<string>()
  const candidateTaxCodes = new Set<string>()
  if (companyClearingAccountId) candidateAccounts.add(companyClearingAccountId)
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
           and id in (${sql.join([...candidateAccounts].map((id) => sql`${id}`), sql`, `)})`, 'objects')).map((row) => row.id))
    : new Set<string>()
  const usableTaxCodes = candidateTaxCodes.size
    ? new Set((await exec.execute<{ id: string }>(sql`
        select id from tax_codes
         where org_id = ${orgId} and is_active
           and id in (${sql.join([...candidateTaxCodes].map((id) => sql`${id}`), sql`, `)})`, 'objects')).map((row) => row.id))
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
            [item.inventory_clearing_account_id ? null : companyClearingAccountId, 'inventory_clearing'],
            [
              item.inventory_clearing_account_id ?? companyClearingAccountId
                ? null
                : item.inventory_asset_account_id,
              'inventory_asset',
            ],
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

export type PartyLineAccountSource = 'party_default' | 'party_history'

/**
 * The coding a new item-less line takes once the party is named. `historyCount`
 * accompanies `party_history`: how many of the party's recent documents used
 * the account, so the drawer can say why it was proposed.
 */
export interface PartyLineDefault {
  accountId: string | null
  accountSource: PartyLineAccountSource | null
  taxCodeId: string | null
  taxSource: 'party' | null
  historyCount?: number
}

/** One account's use on a party's recent documents. */
export type PartyAccountUsage = {
  accountId: string
  /** Distinct documents that used the account on at least one line. */
  documentCount: number
  /** Latest document date (YYYY-MM-DD) among those documents. */
  lastDocumentDate: string
  /** Entry instant of the latest such document (fixed-width UTC text), ordering same-date uses. */
  lastCreatedAt: string
};

/** How far back party history is read when proposing a line account. */
export const PARTY_HISTORY_WINDOW_DAYS = 365

/**
 * The account a party's history proposes: the one used on the most documents;
 * ties go to the most recently used (document date, then entry time), and a
 * remaining tie to the lowest account id so the proposal is deterministic.
 */
export function rankPartyAccountUsage(usage: readonly PartyAccountUsage[]): PartyAccountUsage | null {
  let best: PartyAccountUsage | null = null
  for (const candidate of usage) {
    if (!best) { best = candidate; continue }
    const order = candidate.documentCount - best.documentCount
      || compareText(candidate.lastDocumentDate, best.lastDocumentDate)
      || compareText(candidate.lastCreatedAt, best.lastCreatedAt)
      || compareText(best.accountId, candidate.accountId)
    if (order > 0) best = candidate
  }
  return best
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function accountTypeFilter(cfg: DocKindConfig, column: SQL): SQL {
  return cfg.accountTypes
    ? sql` and ${column} in (${sql.join(cfg.accountTypes.map((type) => sql`${type}`), sql`, `)})`
    : sql``
}

const NO_PARTY_LINE_DEFAULT: PartyLineDefault = { accountId: null, accountSource: null, taxCodeId: null, taxSource: null }

/**
 * Account and tax code for an item-less line on a document of `kind` for this
 * party, before any item is chosen.
 *
 * Account. A vendor's default expense account wins on purchase documents.
 * Otherwise (and always on sales documents, where customers carry no default
 * income account) the party's own history decides: the account most often
 * coded on item-less lines of its non-voided documents of the same kind in the
 * 365 days up to `asOfDate` (the organization's business day when omitted),
 * ranked by `rankPartyAccountUsage`. Promotion lines are generated, not coded,
 * and never count. History is read inside the caller's subsidiary scope (null
 * is the explicit unrestricted sentinel).
 *
 * Tax. The party's own tax code, on kinds that carry tax.
 *
 * The usability rule is the line resolver's: active, non-summary accounts of a
 * type the kind allows and active tax codes. A party that is not an active
 * customer or vendor for the kind, or with nothing usable, gets nulls.
 */
export async function resolvePartyLineDefault(
  exec: SqlExecutor,
  orgId: string,
  input: { kind: string; partyId: string; asOfDate?: string | null; allowedSubsidiaryIds: ReadonlySet<string> | null },
): Promise<PartyLineDefault> {
  const cfg = docKindConfig(input.kind)
  const role = cfg ? partyRoleOf(cfg) : null
  if (!cfg?.lineDefaults || !role || !isUuid(input.partyId)) return NO_PARTY_LINE_DEFAULT
  if (input.asOfDate != null && !isIsoCalendarDate(input.asOfDate)) {
    throw new DocumentDefaultsError('as-of date must be a calendar date (YYYY-MM-DD)')
  }
  const party = (await exec.execute<{ tax_code_id: string | null; default_expense_account_id: string | null }>(
    role === 'customer'
      ? sql`select tax_code_id, null::uuid as default_expense_account_id from customer_roles
             where org_id = ${orgId} and party_id = ${input.partyId} and is_active`
      : sql`select tax_code_id, default_expense_account_id from vendor_roles
             where org_id = ${orgId} and party_id = ${input.partyId} and is_active`,
  )).rows[0]
  if (!party) return NO_PARTY_LINE_DEFAULT

  const taxCodeId = cfg.hasTax && party.tax_code_id
    ? (await exec.execute<{ id: string }>(sql`
        select id from tax_codes where org_id = ${orgId} and id = ${party.tax_code_id} and is_active`)).rows[0]?.id ?? null
    : null
  const tax = { taxCodeId, taxSource: taxCodeId ? 'party' as const : null }

  const vendorDefault = cfg.lineDefaults === 'purchase' && party.default_expense_account_id
    ? (await exec.execute<{ id: string }>(sql`
        select id from accounts
         where org_id = ${orgId} and id = ${party.default_expense_account_id}
           and is_active and not is_summary ${accountTypeFilter(cfg, sql`type`)}`)).rows[0]?.id ?? null
    : null
  if (vendorDefault) return { accountId: vendorDefault, accountSource: 'party_default', ...tax }

  const asOf = input.asOfDate ?? await businessTodayInTx(exec, orgId)
  const usage = (await exec.execute<PartyAccountUsage>(sql`
    select l.account_id as "accountId",
           count(distinct d.id)::int as "documentCount",
           max(d.document_date)::text as "lastDocumentDate",
           to_char((array_agg(d.created_at order by d.document_date desc, d.created_at desc))[1] at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US') as "lastCreatedAt"
      from documents d
      join document_lines l on l.org_id = d.org_id and l.document_id = d.id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
                     and a.is_active and not a.is_summary ${accountTypeFilter(cfg, sql`a.type`)}
     where d.org_id = ${orgId} and d.kind = ${input.kind} and d.party_id = ${input.partyId}
       and d.status <> 'voided'
       and d.document_date between ${addCalendarDays(asOf, -PARTY_HISTORY_WINDOW_DAYS)}::date and ${asOf}::date
       and l.item_id is null and l.promotion_id is null
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, input.allowedSubsidiaryIds)}
     group by l.account_id`)).rows
  const top = rankPartyAccountUsage(usage.map((row) => ({ ...row, documentCount: Number(row.documentCount) })))
  return top
    ? { accountId: top.accountId, accountSource: 'party_history', ...tax, historyCount: top.documentCount }
    : { accountId: null, accountSource: null, ...tax }
}

export type RecalledDocumentLine = {
  accountId: string | null
  itemId: string | null
  description: string | null
  quantity: string
  unitPrice: string
  amount: string
  departmentId: string | null
  projectId: string | null
  locationId: string | null
  classId: string | null
  taxCodeId: string | null
};

export interface RecalledPartyDocument {
  id: string
  documentNumber: string
  documentDate: string
  referenceNumber: string | null
  memo: string | null
  total: string
  currency: string
  lines: RecalledDocumentLine[]
}

/**
 * The party's most recent non-voided document of `kind` (latest document date,
 * then latest entered), so a clerk can repeat last month's bill instead of
 * re-keying it. Null when there is none in the caller's subsidiary scope.
 *
 * Lines come back in their stored order with exact decimal text. A recalled
 * line never carries a reference its picker cannot offer: an inactive,
 * summary or disallowed account, an inactive item or tax code, or an inactive
 * or out-of-scope dimension is blanked on that field alone. Tax codes are
 * omitted for kinds without tax; promotion lines are generated and skipped.
 */
export async function resolveRecentPartyDocument(
  exec: SqlExecutor,
  orgId: string,
  input: { kind: string; partyId: string; allowedSubsidiaryIds: ReadonlySet<string> | null },
): Promise<RecalledPartyDocument | null> {
  const cfg = docKindConfig(input.kind)
  if (!cfg || !partyRoleOf(cfg) || !isUuid(input.partyId)) return null
  const scope = input.allowedSubsidiaryIds
  const header = (await exec.execute<Omit<RecalledPartyDocument, 'lines'>>(sql`
    select d.id, d.document_number as "documentNumber", d.document_date::text as "documentDate",
           d.reference_number as "referenceNumber", d.memo, d.total::text as total, d.currency
      from documents d
     where d.org_id = ${orgId} and d.kind = ${input.kind} and d.party_id = ${input.partyId}
       and d.status <> 'voided'
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope)}
     order by d.document_date desc, d.created_at desc, d.id desc
     limit 1`)).rows[0]
  if (!header) return null
  const dimension = (table: string, alias: string, column: string) => {
    const t = sql.raw(table)
    const a = sql.raw(alias)
    const c = sql.raw(column)
    return sql`left join ${t} ${a} on ${a}.org_id = l.org_id and ${a}.id = l.${c} and ${a}.is_active
      ${subsidiaryVisibleFilter(sql`${a}.subsidiary_id`, scope, { orgWideNull: true })}`
  }
  const lines = (await exec.execute<RecalledDocumentLine>(sql`
    select a.id as "accountId", i.id as "itemId", l.description,
           l.quantity::text as quantity, l.unit_price::text as "unitPrice", l.amount::text as amount,
           dep.id as "departmentId", prj.id as "projectId", loc.id as "locationId", cls.id as "classId",
           ${cfg.hasTax ? sql`tc.id` : sql`null::uuid`} as "taxCodeId"
      from document_lines l
      left join accounts a on a.org_id = l.org_id and a.id = l.account_id
                          and a.is_active and not a.is_summary ${accountTypeFilter(cfg, sql`a.type`)}
      left join items i on i.org_id = l.org_id and i.id = l.item_id and i.is_active
      left join tax_codes tc on tc.org_id = l.org_id and tc.id = l.tax_code_id and tc.is_active
      ${dimension('departments', 'dep', 'department_id')}
      ${dimension('projects', 'prj', 'project_id')}
      ${dimension('locations', 'loc', 'location_id')}
      ${dimension('classes', 'cls', 'class_id')}
     where l.org_id = ${orgId} and l.document_id = ${header.id} and l.promotion_id is null
     order by l.line_number, l.id`)).rows
  return { ...header, lines }
}
