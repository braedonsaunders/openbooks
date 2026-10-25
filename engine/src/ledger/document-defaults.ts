import { sql, type SQL } from 'drizzle-orm'
import type { SqlExecutor } from '../platform/db.ts'
import { addCalendarDays, isIsoCalendarDate } from '../platform/civil-date.ts'
import { paymentTermsDueDate, PaymentTermsDueDateError, type PaymentTermsDueRule } from './payment-terms-due-date.ts'
import { isUuid } from '../platform/uuid.ts'
import { businessTodayInTx } from '../platform/business-date.ts'
import { subsidiaryVisibleFilter } from '../organization/subsidiary-scope.ts'
import { isFeatureEnabled } from '../organization/feature-state.ts'
import { docKindConfig, type DocKindConfig } from '../records/document-kinds.ts'
import { loadCompanyReceivedNotBilledAccount } from '../records/control-accounts.ts'
import { taxProfileMap } from './document-totals.ts'

/**
 * Document header and line defaults: the one resolver behind the document
 * drawer's pre-save defaults and the server's create/edit writes.
 *
 * Due date. A kind that declares `dueDateFromTerms` (invoices and bills)
 * derives its due date from the party's active payment terms through the one
 * terms rule in payment-terms-due-date.ts: net days after the document date,
 * or the first due day of a month more than net days after it. A party
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
  /** Day of the month the terms fall due on; null when they count net days only. */
  dueDayOfMonth: number | null
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

type TermsRow = { id: string; name: string; net_days: number; due_day_of_month: number | null }

/** The due date a stored terms row implies, refusing terms that cannot produce one. */
function termsDueDate(terms: TermsRow, documentDate: string, source: TermsDueDate['source']): TermsDueDate {
  const rule: PaymentTermsDueRule = {
    netDays: Number(terms.net_days),
    dueDayOfMonth: terms.due_day_of_month === null ? null : Number(terms.due_day_of_month),
  }
  try {
    return { termsId: terms.id, termsName: terms.name, ...rule, dueDate: paymentTermsDueDate(documentDate, rule), source }
  } catch (error) {
    if (error instanceof PaymentTermsDueDateError) throw new DocumentDefaultsError(error.message)
    throw error
  }
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
  const terms = (await exec.execute<TermsRow>(sql`
    select pt.id, pt.name, pt.net_days, pt.due_day_of_month
      from ${roleTable} r
      join payment_terms pt on pt.id = r.payment_terms_id and pt.org_id = r.org_id and pt.is_active
     where r.org_id = ${orgId} and r.party_id = ${input.partyId}`, 'objects'))[0]
  if (terms) return termsDueDate(terms, input.documentDate, 'party')
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
  const terms = (await exec.execute<TermsRow>(sql`
    select id, name, net_days, due_day_of_month from payment_terms
     where org_id = ${orgId} and id = ${defaultId} and is_active`, 'objects'))[0]
  if (!terms) return null
  return termsDueDate(terms, documentDate, 'company')
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
export type PartyLineTaxSource = 'party' | 'party_history'

/**
 * The coding a new item-less line takes once the party is named. A line's tax
 * is a tax code or a tax group, never both. `historyCount` accompanies an
 * account from `party_history` and `taxHistoryCount` a tax from
 * `party_history`: how many of the party's recent documents used it, so the
 * drawer can say why it was proposed.
 */
export interface PartyLineDefault {
  accountId: string | null
  accountSource: PartyLineAccountSource | null
  taxCodeId: string | null
  taxGroupId: string | null
  taxSource: PartyLineTaxSource | null
  historyCount?: number
  taxHistoryCount?: number
}

/** When and how often a party's recent documents used one coding. */
type PartyUsage = {
  /** Distinct documents that used the coding on at least one line. */
  documentCount: number
  /** Latest document date (YYYY-MM-DD) among those documents. */
  lastDocumentDate: string
  /** Entry instant of the latest such document (fixed-width UTC text), ordering same-date uses. */
  lastCreatedAt: string
};

/** One account's use on a party's recent documents. */
export type PartyAccountUsage = PartyUsage & { accountId: string };

/**
 * One tax treatment's use on a party's recent documents: a tax code, a tax
 * group, or neither (lines entered without tax).
 */
export type PartyTaxUsage = PartyUsage & { taxCodeId: string | null; taxGroupId: string | null };

/** How far back party history is read when proposing a line account or tax. */
export const PARTY_HISTORY_WINDOW_DAYS = 365

/**
 * The coding used on the most documents; ties go to the most recently used
 * (document date, then entry time), and a remaining tie to the lowest key so
 * the proposal is deterministic.
 */
function rankPartyUsage<T extends PartyUsage>(usage: readonly T[], key: (entry: T) => string): T | null {
  let best: T | null = null
  for (const candidate of usage) {
    if (!best) { best = candidate; continue }
    const order = candidate.documentCount - best.documentCount
      || compareText(candidate.lastDocumentDate, best.lastDocumentDate)
      || compareText(candidate.lastCreatedAt, best.lastCreatedAt)
      || compareText(key(best), key(candidate))
    if (order > 0) best = candidate
  }
  return best
}

/** The account a party's history proposes, ranked by `rankPartyUsage`. */
export function rankPartyAccountUsage(usage: readonly PartyAccountUsage[]): PartyAccountUsage | null {
  return rankPartyUsage(usage, (entry) => entry.accountId)
}

/**
 * The tax treatment a party's history proposes, ranked by `rankPartyUsage`.
 * Lines without tax compete like any code: a party mostly billed without tax
 * yields the no-tax entry (both ids null), and a full tie resolves to no tax
 * rather than a guess.
 */
export function rankPartyTaxUsage(usage: readonly PartyTaxUsage[]): PartyTaxUsage | null {
  return rankPartyUsage(usage, (entry) =>
    entry.taxCodeId ? `code:${entry.taxCodeId}` : entry.taxGroupId ? `group:${entry.taxGroupId}` : '')
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function accountTypeFilter(cfg: DocKindConfig, column: SQL): SQL {
  return cfg.accountTypes
    ? sql` and ${column} in (${sql.join(cfg.accountTypes.map((type) => sql`${type}`), sql`, `)})`
    : sql``
}

const NO_TAX = { taxCodeId: null, taxGroupId: null, taxSource: null } as const
const NO_PARTY_LINE_DEFAULT: PartyLineDefault = { accountId: null, accountSource: null, ...NO_TAX }

/** The party's history window and scope, shared by the account and tax proposals. */
function partyHistoryFilter(orgId: string, input: { kind: string; partyId: string; allowedSubsidiaryIds: ReadonlySet<string> | null }, asOf: string): SQL {
  return sql`d.org_id = ${orgId} and d.kind = ${input.kind} and d.party_id = ${input.partyId}
       and d.status <> 'voided'
       and d.document_date between ${addCalendarDays(asOf, -PARTY_HISTORY_WINDOW_DAYS)}::date and ${asOf}::date
       and l.item_id is null and l.promotion_id is null
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, input.allowedSubsidiaryIds)}`
}

const PARTY_USAGE_COLUMNS = sql`count(distinct d.id)::int as "documentCount",
           max(d.document_date)::text as "lastDocumentDate",
           to_char((array_agg(d.created_at order by d.document_date desc, d.created_at desc))[1] at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US') as "lastCreatedAt"`

/**
 * The tax treatment the party's history proposes for an item-less line coded
 * to `accountId`: ranked over the lines that used that account, or over all
 * of the party's item-less lines when no account is proposed or the account
 * has no history with the party. Only a treatment the document can be taxed
 * with on `asOf` competes: a code or group in the native effective tax
 * profiles (active, with a rate in force), and a code that applies to this
 * side of the ledger.
 */
async function resolvePartyHistoryTax(
  exec: SqlExecutor,
  orgId: string,
  cfg: DocKindConfig,
  input: { kind: string; partyId: string; allowedSubsidiaryIds: ReadonlySet<string> | null },
  asOf: string,
  accountId: string | null,
): Promise<Pick<PartyLineDefault, 'taxCodeId' | 'taxGroupId' | 'taxSource' | 'taxHistoryCount'>> {
  const appliesTo = cfg.lineDefaults === 'sales' ? 'sales' : 'purchases'
  const usage = async (account: string | null) => (await exec.execute<PartyTaxUsage>(sql`
    select l.tax_code_id as "taxCodeId", l.tax_group_id as "taxGroupId", ${PARTY_USAGE_COLUMNS}
      from documents d
      join document_lines l on l.org_id = d.org_id and l.document_id = d.id
      left join tax_codes tc on tc.org_id = l.org_id and tc.id = l.tax_code_id
     where ${partyHistoryFilter(orgId, input, asOf)}
       ${account ? sql`and l.account_id = ${account}` : sql``}
       and (l.tax_code_id is null or tc.applies_to in ('both', ${appliesTo}))
     group by l.tax_code_id, l.tax_group_id`, 'objects')).map((row) => ({ ...row, documentCount: Number(row.documentCount) }))
  let rows = accountId ? await usage(accountId) : []
  if (rows.length === 0) rows = await usage(null)
  if (rows.length === 0) return NO_TAX
  const profiles = await taxProfileMap(orgId, asOf, exec)
  const top = rankPartyTaxUsage(rows.filter((row) =>
    row.taxCodeId ? profiles.codes.has(row.taxCodeId) : row.taxGroupId ? profiles.groups.has(row.taxGroupId) : true))
  if (!top || (!top.taxCodeId && !top.taxGroupId)) return NO_TAX
  return { taxCodeId: top.taxCodeId, taxGroupId: top.taxGroupId, taxSource: 'party_history', taxHistoryCount: top.documentCount }
}

/**
 * Account and tax for an item-less line on a document of `kind` for this
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
 * Tax, on kinds that carry tax. The party's own tax code wins. Otherwise the
 * same history decides, as `resolvePartyHistoryTax` describes; a party whose
 * history mostly carries no tax gets none.
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
             where org_id = ${orgId} and party_id = ${input.partyId} and is_active`, 'objects',
  ))[0]
  if (!party) return NO_PARTY_LINE_DEFAULT

  const partyTaxCodeId = cfg.hasTax && party.tax_code_id
    ? (await exec.execute<{ id: string }>(sql`
        select id from tax_codes where org_id = ${orgId} and id = ${party.tax_code_id} and is_active`, 'objects'))[0]?.id ?? null
    : null

  const vendorDefault = cfg.lineDefaults === 'purchase' && party.default_expense_account_id
    ? (await exec.execute<{ id: string }>(sql`
        select id from accounts
         where org_id = ${orgId} and id = ${party.default_expense_account_id}
           and is_active and not is_summary ${accountTypeFilter(cfg, sql`type`)}`, 'objects'))[0]?.id ?? null
    : null

  // History is read only when a default is missing.
  const needsHistory = !vendorDefault || (cfg.hasTax && !partyTaxCodeId)
  const asOf = needsHistory ? input.asOfDate ?? await businessTodayInTx(exec, orgId) : null
  let account: Pick<PartyLineDefault, 'accountId' | 'accountSource' | 'historyCount'> = vendorDefault
    ? { accountId: vendorDefault, accountSource: 'party_default' }
    : { accountId: null, accountSource: null }
  if (!vendorDefault && asOf) {
    const usage = await exec.execute<PartyAccountUsage>(sql`
      select l.account_id as "accountId", ${PARTY_USAGE_COLUMNS}
        from documents d
        join document_lines l on l.org_id = d.org_id and l.document_id = d.id
        join accounts a on a.org_id = l.org_id and a.id = l.account_id
                       and a.is_active and not a.is_summary ${accountTypeFilter(cfg, sql`a.type`)}
       where ${partyHistoryFilter(orgId, input, asOf)}
       group by l.account_id`, 'objects')
    const top = rankPartyAccountUsage(usage.map((row) => ({ ...row, documentCount: Number(row.documentCount) })))
    if (top) account = { accountId: top.accountId, accountSource: 'party_history', historyCount: top.documentCount }
  }

  const tax = !cfg.hasTax
    ? NO_TAX
    : partyTaxCodeId
      ? { taxCodeId: partyTaxCodeId, taxGroupId: null, taxSource: 'party' as const }
      : asOf ? await resolvePartyHistoryTax(exec, orgId, cfg, input, asOf, account.accountId) : NO_TAX
  return { ...account, ...tax }
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
     limit 1`, 'objects'))[0]
  if (!header) return null
  const dimension = (table: string, alias: string, column: string) => {
    const t = sql.raw(table)
    const a = sql.raw(alias)
    const c = sql.raw(column)
    return sql`left join ${t} ${a} on ${a}.org_id = l.org_id and ${a}.id = l.${c} and ${a}.is_active
      ${subsidiaryVisibleFilter(sql`${a}.subsidiary_id`, scope, { orgWideNull: true })}`
  }
  const lines = await exec.execute<RecalledDocumentLine>(sql`
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
     order by l.line_number, l.id`, 'objects')
  return { ...header, lines }
}
