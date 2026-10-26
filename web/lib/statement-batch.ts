import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { isValidEmailAddress } from "@openbooks/emails";
import { functionalReportReader } from "./reports/currency-basis";
import { dimWhere } from "./reports/filters";
import { statementBookExpr } from "./gl-summary";
import { decimalCmp } from "./statement-format";
import { reportBookSelection } from "./report-books";
import { subsidiaryVisibleFilter } from "@openbooks/engine/organization/scope";
import { resolveSubsidiaryScope } from "./consolidation";
import { partnerBalances } from "./reports/statements";

/**
 * Batched customer statements ("send statements to customers with a
 * balance"): recipient resolution shared by the preview and the run
 * creation. Balances come from the same open-item source as the Customer
 * statements picker, so a preview row and the sent statement always agree
 * on who owes what.
 */

/**
 * A batch period refusal: the requested dates are malformed or inverted.
 * It answers 400 with its message, which carries only the expected shape —
 * user input is echoed back as a shape, never raw.
 */
export class StatementBatchInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "StatementBatchInputError";
  }
}

/** Distinct customer currencies available to the caller for statement filters. */
export async function listStatementCustomerCurrencies(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<string[]> {
  const rows = await db.execute<{ currency: string }>(
    sql`
    select distinct cr.currency
      from customer_roles cr
      join parties p on p.org_id = cr.org_id and p.id = cr.party_id
     where cr.org_id = ${orgId} and cr.currency is not null
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     order by cr.currency
  `,
    "objects",
  );
  return rows.map((row) => row.currency);
}

export interface StatementBatchFilters {
  /** Statement end date (as-of when `from` is absent). */
  to: string;
  from?: string | null;
  overdueOnly?: boolean;
  subsidiaryId?: string | null;
  currency?: string | null;
}

export interface StatementPartyContact {
  role: string | null;
  email: string | null;
  isPrimary: boolean;
  isActive: boolean;
}

export interface StatementPartyInfo {
  displayName: string;
  email: string | null;
  subsidiaryId: string | null;
  currency: string | null;
  contacts: StatementPartyContact[];
}

export interface StatementBalanceRow {
  id: string | null;
  display_name: string | null;
  balance: string;
}

export interface BatchRecipient {
  partyId: string;
  displayName: string;
  balance: string;
  overdue: string;
  currency: string | null;
  toEmail: string;
}

export interface BatchExclusion {
  partyId: string;
  displayName: string;
  balance: string;
  overdue: string;
  reason: "no-email";
  /** Party record URL where the operator adds the missing address. */
  fixHref: string;
}

/**
 * Statement mailbox for one customer: an active billing/statement contact
 * first (the native party contacts), then the active primary contact, then
 * the party email on file. Anything else is a missing address, never a
 * guess — the preview lists the customer as excluded instead.
 */
export function pickStatementEmail(
  contacts: readonly StatementPartyContact[],
  partyEmail: string | null,
): string | null {
  const valid = (value: string | null): string | null => {
    const trimmed = value?.trim() ?? "";
    return trimmed && isValidEmailAddress(trimmed) ? trimmed : null;
  };
  const active = contacts.filter((c) => c.isActive);
  const billing = active.filter((c) =>
    ["billing", "statement"].includes((c.role ?? "").trim().toLowerCase()),
  );
  for (const candidate of [
    ...billing.filter((c) => c.isPrimary),
    ...billing.filter((c) => !c.isPrimary),
  ]) {
    const email = valid(candidate.email);
    if (email) return email;
  }
  const primary = active.find((c) => c.isPrimary);
  const primaryEmail = valid(primary?.email ?? null);
  if (primaryEmail) return primaryEmail;
  return valid(partyEmail);
}

/** Party record, customer currency, and contacts for the balanced parties. */
export async function loadStatementBatchParties(
  orgId: string,
  partyIds: readonly string[],
): Promise<Map<string, StatementPartyInfo>> {
  const out = new Map<string, StatementPartyInfo>();
  if (partyIds.length === 0) return out;
  const parties = await db.execute<{
    id: string;
    display_name: string;
    email: string | null;
    subsidiary_id: string | null;
    currency: string | null;
  }>(
    sql`
    select p.id, p.display_name, p.email, p.subsidiary_id, cr.currency
      from parties p
      left join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id
     where p.org_id = ${orgId} and p.id in ${sql`(${sql.join(
       partyIds.map((id) => sql`${id}`),
       sql`, `,
     )})`}
  `,
    "objects",
  );
  const contacts = await db.execute<{
    party_id: string;
    role: string | null;
    email: string | null;
    is_primary: boolean;
    is_active: boolean;
  }>(
    sql`
    select party_id, role, email, is_primary, is_active from contacts
     where org_id = ${orgId} and party_id in ${sql`(${sql.join(
       partyIds.map((id) => sql`${id}`),
       sql`, `,
     )})`}
  `,
    "objects",
  );
  const byParty = new Map<string, StatementPartyContact[]>();
  for (const row of contacts) {
    const list = byParty.get(row.party_id) ?? [];
    list.push({
      role: row.role,
      email: row.email,
      isPrimary: row.is_primary,
      isActive: row.is_active,
    });
    byParty.set(row.party_id, list);
  }
  for (const row of parties) {
    out.set(row.id, {
      displayName: row.display_name,
      email: row.email,
      subsidiaryId: row.subsidiary_id,
      currency: row.currency,
      contacts: byParty.get(row.id) ?? [],
    });
  }
  return out;
}

/**
 * Overdue portion per party through the as-of date: open receivable lines
 * past due. Same entry set, book, account type, and currency reader as
 * partnerBalances, so the overdue figure is always in the same money as
 * the balance beside it.
 */
export async function partyOverdueMap(
  orgId: string,
  asOf: string,
  opts: { bookId?: string | null; subsidiaryIds?: string[] } = {},
): Promise<Map<string, string>> {
  const reportDb = functionalReportReader(
    orgId,
    sql`e.posting_date <= ${asOf} and a.type = 'asset_receivable' and e.book_id = ${statementBookExpr(orgId, opts.bookId ?? null)} and ${dimWhere({ subsidiaryIds: opts.subsidiaryIds })}`,
  );
  const rows = (
    await reportDb.execute<{ id: string; overdue: string }>(sql`
    with e as materialized (
      select id from journal_entries
       where org_id = ${orgId} and status in ('posted', 'reversed')
         and posting_date <= ${asOf}
         and book_id = ${statementBookExpr(orgId, opts.bookId ?? null)}
    )
    select ${reportDb.censusColumn}, l.party_id as id, sum(l.amount) as overdue
      from journal_lines l
      join e on e.id = l.entry_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${orgId} and a.org_id = ${orgId}
       and a.type = 'asset_receivable' and ${dimWhere({ subsidiaryIds: opts.subsidiaryIds })}
       and l.party_id is not null and l.due_date is not null and l.due_date < ${asOf}
     group by l.party_id
  `)
  ).rows;
  return new Map(rows.map((row) => [row.id, row.overdue]));
}

/**
 * Split balanced customers into recipients and no-email exclusions. Zero
 * balances never reach either list; parties outside the caller's
 * subsidiary scope are dropped silently (the same boundary as the single
 * send, which answers out-of-scope parties as missing).
 */
export function assembleBatchList(args: {
  balances: readonly StatementBalanceRow[];
  parties: ReadonlyMap<string, StatementPartyInfo>;
  overdueByParty: ReadonlyMap<string, string>;
  filters: StatementBatchFilters;
  allowedSubsidiaryIds: Set<string> | null;
}): { recipients: BatchRecipient[]; excluded: BatchExclusion[] } {
  const recipients: BatchRecipient[] = [];
  const excluded: BatchExclusion[] = [];
  const currencyFilter = args.filters.currency?.trim().toUpperCase() || null;
  for (const row of args.balances) {
    if (!row.id || decimalCmp(row.balance, "0") === 0) continue;
    const party = args.parties.get(row.id);
    if (!party) continue;
    if (
      args.allowedSubsidiaryIds !== null &&
      party.subsidiaryId !== null &&
      !args.allowedSubsidiaryIds.has(party.subsidiaryId)
    ) {
      continue;
    }
    if (
      args.filters.subsidiaryId &&
      party.subsidiaryId !== null &&
      party.subsidiaryId !== args.filters.subsidiaryId
    ) {
      continue;
    }
    if (currencyFilter && (party.currency ?? "").toUpperCase() !== currencyFilter) continue;
    const overdue = args.overdueByParty.get(row.id) ?? "0";
    if (args.filters.overdueOnly && decimalCmp(overdue, "0") <= 0) continue;
    const displayName = party.displayName || row.display_name || "";
    const toEmail = pickStatementEmail(party.contacts, party.email);
    if (!toEmail) {
      excluded.push({
        partyId: row.id,
        displayName,
        balance: row.balance,
        overdue,
        reason: "no-email",
        fixHref: `/parties?party=${row.id}`,
      });
      continue;
    }
    recipients.push({
      partyId: row.id,
      displayName,
      balance: row.balance,
      overdue,
      currency: party.currency,
      toEmail,
    });
  }
  return { recipients, excluded };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface StatementBatchPreviewQuery {
  from?: string | null;
  to?: string | null;
  overdueOnly?: boolean;
  subsidiaryId?: string | null;
  currency?: string | null;
}

export interface StatementBatchPreview {
  from: string | null;
  to: string;
  recipients: BatchRecipient[];
  excluded: BatchExclusion[];
  subsidiaries: { id: string; label: string }[];
  /** Presentation currency of the viewed set (the context node's functional currency). */
  currency?: string;
}

/**
 * Preview (and run-creation) recipient list: the picker's balance source
 * for the requested period end, narrowed to the caller's subsidiary scope
 * and the requested filters. A multi-currency viewed set throws the same
 * named refusal as the picker — choose a single-currency subsidiary view.
 */
export async function buildStatementBatchPreview(
  orgId: string,
  allowedSubsidiaryIds: Set<string> | null,
  canSeePayroll: boolean,
  query: StatementBatchPreviewQuery,
): Promise<StatementBatchPreview> {
  const today = await businessToday(orgId);
  const to = query.to?.trim() || today;
  const from = query.from?.trim() || null;
  if (!DATE_RE.test(to) || (from !== null && !DATE_RE.test(from))) {
    throw new StatementBatchInputError("statement batch period dates must be YYYY-MM-DD");
  }
  if (from !== null && from > to) {
    throw new StatementBatchInputError(
      "statement batch period starts after it ends — swap the From and To dates",
    );
  }
  const { selectedBook } = await reportBookSelection(orgId);
  // Explicit scope from the caller's gate — never the ambient session — so
  // this runs identically in pages, API routes, and the worker's wake.
  const subView = await resolveSubsidiaryScope(
    query.subsidiaryId ?? undefined,
    to,
    allowedSubsidiaryIds,
  );
  // ratesError (missing consolidated translation rates) does not apply:
  // open-item lines read through the functional reader, whose census
  // refuses a multi-currency viewed set with the named remedy instead.
  const viewedIds = subView.subsidiary?.ids;
  const subsidiaryIds =
    allowedSubsidiaryIds === null
      ? viewedIds
      : viewedIds === undefined
        ? [...allowedSubsidiaryIds]
        : viewedIds.filter((id) => allowedSubsidiaryIds.has(id));
  // Balances and overdue portions are independent reads of the same ledger.
  const [balances, overdueByParty] = await Promise.all([
    partnerBalances(
      "receivable",
      orgId,
      to,
      selectedBook.id,
      {
        subsidiaryIds,
      },
      canSeePayroll,
    ),
    partyOverdueMap(orgId, to, { bookId: selectedBook.id, subsidiaryIds }),
  ]);
  const ids = balances.map((row) => row.id).filter((id): id is string => id !== null);
  const parties = await loadStatementBatchParties(orgId, ids);
  const { recipients, excluded } = assembleBatchList({
    balances,
    parties,
    overdueByParty,
    filters: {
      to,
      from,
      overdueOnly: query.overdueOnly,
      subsidiaryId: query.subsidiaryId,
      currency: query.currency,
    },
    allowedSubsidiaryIds,
  });
  return {
    from,
    to,
    recipients,
    excluded,
    subsidiaries: subView.options.map(({ id, name }) => ({ id, label: name })),
    currency: subView.currency,
  };
}

/** A statement batch run's period and the sender's authorization snapshot, for rendering one statement. */
export async function readStatementBatchRunForRender(orgId: string, runId: string) {
  return (
    (
      await db.execute<{
        period_from: string | null;
        period_to: string;
        authorization_snapshot: {
          version?: number;
          userId?: string;
          allowedSubsidiaryIds?: string[] | null;
        };
      }>(
        sql`
    select period_from::text as period_from, period_to::text as period_to, authorization_snapshot
      from statement_batch_runs where id = ${runId} and org_id = ${orgId} limit 1`,
        "objects",
      )
    )[0] ?? null
  );
}

/** The recipient email a batch run recorded for one customer. */
export async function readStatementBatchItemEmail(orgId: string, runId: string, partyId: string) {
  return (
    (
      await db.execute<{ to_email: string | null }>(
        sql`
    select to_email from statement_batch_items
     where run_id = ${runId} and party_id = ${partyId} and org_id = ${orgId} limit 1`,
        "objects",
      )
    )[0] ?? null
  );
}

/** A statement customer's display name and entity. */
export async function readStatementParty(orgId: string, partyId: string) {
  return (
    (
      await db.execute<{ display_name: string; subsidiary_id: string | null }>(
        sql`
    select display_name, subsidiary_id::text as subsidiary_id from parties
     where id = ${partyId} and org_id = ${orgId} limit 1`,
        "objects",
      )
    )[0] ?? null
  );
}
