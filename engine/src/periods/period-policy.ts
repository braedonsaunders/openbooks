import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { civilDateLabel, civilDateLabelSql } from "../platform/civil-date-labels.ts";

export class CloseError extends Error {}

/**
 * Display label for an accounting period.
 *
 * Every period reads as its canonical fiscal label followed by the calendar
 * month (or months) its dates cover, formatted for the viewer's locale:
 * `P12 FY2026 · Dec 2026`. Both parts derive from the period's own fiscal
 * year, number and dates, so one calendar reads in one format across every
 * fiscal year regardless of the free-text name a period was stored with
 * (an earlier seed, a custom calendar or a rename). Stored names are never
 * rewritten and remain searchable.
 */
export interface PeriodLabelInput {
  fiscalYear: number;
  periodNumber: number;
  adjustment: boolean;
}

export interface PeriodDisplayInput extends PeriodLabelInput {
  /** First civil day of the period, `YYYY-MM-DD`. */
  startsOn: string;
  /** Last civil day of the period, `YYYY-MM-DD`. */
  endsOn: string;
}

/** `P05 FY2026` for a regular period, `FY2026 adjustment` for the adjustment period. */
export function canonicalPeriodLabel(input: PeriodLabelInput): string {
  return input.adjustment
    ? `FY${input.fiscalYear} adjustment`
    : `P${String(input.periodNumber).padStart(2, "0")} FY${input.fiscalYear}`;
}

/** Separates the fiscal label from the month span. */
const LABEL_SEPARATOR = " · ";
/** Joins the first and last month of a period that spans calendar months. */
const SPAN_SEPARATOR = " – ";

/** `Dec 2026`, or `Dec 2025 – Jan 2026` for a period spanning calendar months. */
export function periodMonthSpan(
  input: Pick<PeriodDisplayInput, "startsOn" | "endsOn">,
  locale: string,
): string {
  const first = civilDateLabel(input.startsOn, locale, "monthYear");
  const last = civilDateLabel(input.endsOn, locale, "monthYear");
  return first === last ? first : `${first}${SPAN_SEPARATOR}${last}`;
}

/** The list text for a period: `P12 FY2026 · Dec 2026`. */
export function periodDisplayLabel(input: PeriodDisplayInput, locale: string): string {
  return `${canonicalPeriodLabel(input)}${LABEL_SEPARATOR}${periodMonthSpan(input, locale)}`;
}

/**
 * SQL form of canonicalPeriodLabel over an `accounting_periods` row (aliased
 * `p` unless another alias is named), for locale-free text composed in a
 * query: refusals, remedies and notifications that name a period. Null when
 * an outer join found no period.
 */
export function canonicalPeriodLabelSql(alias = "p"): SQL {
  const p = sql.identifier(alias);
  return sql`(case when ${p}.fiscal_year is null then null
    when ${p}.is_adjustment
    then concat('FY', ${p}.fiscal_year, ' adjustment')
    else concat('P', lpad(${p}.period_number::text, 2, '0'), ' FY', ${p}.fiscal_year::text) end)`;
}

/**
 * SQL form of periodDisplayLabel over an `accounting_periods` row (aliased
 * `p` unless another alias is named), rendered from the same locale
 * templates, so a label search matches the text the list shows in the
 * viewer's locale.
 */
export function periodDisplayLabelSql(locale: string, alias = "p"): SQL {
  const p = sql.identifier(alias);
  const first = civilDateLabelSql(sql`${p}.starts_on`, locale, "monthYear");
  const last = civilDateLabelSql(sql`${p}.ends_on`, locale, "monthYear");
  return sql`concat(${canonicalPeriodLabelSql(alias)}, ${LABEL_SEPARATOR}::text, case
    when date_trunc('month', ${p}.starts_on) = date_trunc('month', ${p}.ends_on) then ${first}
    else concat(${first}, ${SPAN_SEPARATOR}::text, ${last}) end)`;
}

/**
 * Typed details carried by every refusal to post into a closed
 * module/period. The API boundary renders plain-object details untouched,
 * so a shared refusal renderer can offer the controlled route out — a
 * reopen request prefilled with exactly this scope — instead of a bare
 * "closed". Never internals: four scope ids plus the module.
 */
export interface PeriodClosedDetails {
  kind: "period-closed";
  periodId: string;
  bookId: string;
  subsidiaryId: string | null;
  module: CloseModule;
}

/** A posting refused because its module/period is closed. The message stays
 * the operator copy callers already match on; the details name the scope a
 * reopen request must cover. Still a CloseError, so existing guards pass. */
export class PeriodClosedError extends CloseError {
  readonly code = "period-closed";
  constructor(
    message: string,
    readonly details: PeriodClosedDetails,
  ) {
    super(message);
  }
}

/** Period-closed details from any refusal that preserved them through a
 * domain wrap — undefined for every other failure. */
export function periodClosedDetailsOf(error: unknown): PeriodClosedDetails | undefined {
  return error instanceof PeriodClosedError ? error.details : undefined;
}

export const CLOSE_MODULES = ["ar", "ap", "banking", "assets", "tax", "gl"] as const;
export type CloseModule = (typeof CLOSE_MODULES)[number];

export type PeriodLockView = {
  state: string;
  reopenExpiresAt: Date | string | null;
  reason: string | null;
};

/**
 * Statutory reopen — hard close or an expired controlled window. Soft-close
 * fences posting (see periodLockBlocksPosting) but is released from Setup
 * without a reopen case, so an approved window cannot escalate it to closed.
 */
export function periodLockRequiresApprovedReopen(
  lock: PeriodLockView | undefined,
  now = new Date(),
): boolean {
  if (!lock) return false;
  return (
    lock.state === "closed" ||
    (lock.state === "open" && lock.reopenExpiresAt != null && new Date(lock.reopenExpiresAt) <= now)
  );
}

export function periodLockBlocksPosting(
  lock: PeriodLockView | undefined,
  allowImportedLock: boolean,
  now = new Date(),
): boolean {
  if (!lock) return false;
  if (allowImportedLock && lock.reason === "close.importedPeriodLockReason") return false;
  return lock.state === "soft_closed" || periodLockRequiresApprovedReopen(lock, now);
}

/** The stored period_locks row that effectively governs one exact scope. */
export type EffectivePeriodLock = {
  id: string;
  /** Null names the organization-wide row; a value names the entity row. */
  subsidiaryId: string | null;
  state: string;
  reason: string | null;
  reopenExpiresAt: Date | string | null;
  version: number;
};

/**
 * The one effective-lock resolution every posting decision and exact read
 * shares: the exact entity row wins, otherwise the organization-wide
 * (null-subsidiary) row for the same organization, period, book and module
 * governs. No row means no stored lock governs that scope — callers may
 * derive openness only after they have verified the period, book and
 * entity themselves, never from an organization-wide summary.
 */
export async function readEffectivePeriodLock(
  executor: SqlExecutor,
  args: {
    orgId: string;
    periodId: string;
    bookId: string;
    subsidiaryId: string | null;
    module: CloseModule;
  },
): Promise<EffectivePeriodLock | undefined> {
  const result = await executor.execute<EffectivePeriodLock>(
    sql`
    select id, subsidiary_id as "subsidiaryId", state, reason,
           reopen_expires_at as "reopenExpiresAt", version
      from period_locks
     where org_id = ${args.orgId} and period_id = ${args.periodId}
       and book_id = ${args.bookId} and module = ${args.module}
       and (subsidiary_id is not distinct from ${args.subsidiaryId} or subsidiary_id is null)
     order by (subsidiary_id is not null) desc
     limit 1`,
    "objects",
  );
  return result[0];
}

/**
 * Period-close module per document kind. The drawer kinds mirror
 * web/lib/document-kinds.ts `closeModule` (a required registry field, so a
 * new kind cannot be declared without a module decision); the parity test in
 * close.test.ts fails if this map and that field ever drift. Kinds outside
 * the drawer registry — payments, orders, expenses, manual journals,
 * inventory receipts and fulfillments, field tickets — are decided here. An
 * unknown kind is a hard failure: silently posting under the GL lock alone
 * once let cheques, deposits, and transfers bypass their closed AP and
 * banking locks.
 */
const DOCUMENT_CLOSE_MODULES = {
  // Drawer registry kinds (web/lib/document-kinds.ts DOC_KINDS).
  vendor_bill: "ap",
  vendor_credit: "ap",
  customer_invoice: "ar",
  customer_credit: "ar",
  cash_sale: "ar",
  cash_refund: "ar",
  card_charge: "ap",
  card_refund: "ap",
  check: "ap",
  deposit: "banking",
  transfer: "banking",
  project_charge: "gl",
  internal_billing: "gl",
  pay_run: "gl",
  // Non-drawer kinds.
  customer_payment: "ar",
  vendor_payment: "ap",
  expense_report: "ap",
  sales_order: "ar",
  purchase_order: "ap",
  quote: "ar",
  pick_list: "ar",
  shipment: "ar",
  rma: "ar",
  journal: "gl",
  // Inventory execution documents: the buy-side goods receipt pairs with the
  // vendor bill, the sell-side fulfillment with the customer invoice.
  purchase_receipt: "ap",
  sales_fulfillment: "ar",
  // Field tickets are project time/equipment evidence released through Flows,
  // never posted directly; the GL lock governs their close-period handling
  // like the other project billing sources.
  field_ticket: "gl",
} as const satisfies Record<string, CloseModule>;

/**
 * Every document kind the engine knows — derived from the close-module
 * decisions above, which is the one table that must name a kind for it to
 * post at all. This is the single source of truth for the kind universe:
 * engine consumers (flows profiles, kind allow-lists) derive from it instead
 * of keeping their own mirrors, so a new kind cannot exist in one place and
 * be rejected as unknown in another.
 */
export const DOCUMENT_KINDS: readonly string[] = Object.keys(DOCUMENT_CLOSE_MODULES);

/**
 * Kinds that never carry a posted journal entry (quotes, orders, field
 * tickets). Their close module still governs whether they may be created or
 * voided in a locked period, but they have no posting period to assign and
 * cannot be "unposted" — so close readiness must not count them as drafts or
 * as documents missing a posting period. A mirror tenant with hundreds of
 * open orders otherwise sees a permanent critical blocker it can never
 * clear.
 */
export const NON_POSTING_DOCUMENT_KINDS: readonly string[] = [
  "quote",
  "sales_order",
  "purchase_order",
  "pick_list",
  "shipment",
  "rma",
  "field_ticket",
];

export function closeModuleForDocument(kind: string): CloseModule {
  const decided = (DOCUMENT_CLOSE_MODULES as Record<string, CloseModule>)[kind];
  if (!decided) {
    // Operator copy at the source: this refusal escapes through posting,
    // void, replay and sync-deletion toasts, so the registry name must never
    // reach the screen on any of those paths.
    throw new CloseError(
      `document kind "${kind}" is not configured for period close; your system administrator must add a period-close decision for this kind`,
    );
  }
  return decided;
}

/** Application-level companion to the Postgres guard. It supplies a precise,
 * user-facing error before a write reaches the kernel. */
export async function assertPeriodModulesOpen(
  executor: SqlExecutor,
  args: {
    orgId: string;
    periodId: string;
    bookId: string;
    subsidiaryIds: string[];
    modules: CloseModule[];
    /** Historical source replay may cross source-owned locks, never user locks. */
    allowImportedLocks?: boolean;
    /** The entry a posting reverses: a period-end generation does not seal the reversal of its own journals. */
    reversesEntryId?: string | null;
  },
): Promise<void> {
  await assertPeriodNotSealed(executor, args);
  const modules = [...new Set<CloseModule>([...args.modules, "gl"])];
  const subsidiaryIds: (string | null)[] = args.subsidiaryIds.length
    ? [...new Set(args.subsidiaryIds)]
    : [null];
  for (const subsidiaryId of subsidiaryIds) {
    for (const module of modules) {
      const lock = await readEffectivePeriodLock(executor, {
        orgId: args.orgId,
        periodId: args.periodId,
        bookId: args.bookId,
        subsidiaryId,
        module,
      });
      if (periodLockBlocksPosting(lock, args.allowImportedLocks === true))
        throw new PeriodClosedError(
          `${module.toUpperCase()} is closed for this period and accounting book${await closedPeriodRoute(executor, args, module, subsidiaryId)}`,
          {
            kind: "period-closed",
            periodId: args.periodId,
            bookId: args.bookId,
            subsidiaryId,
            module,
          },
        );
    }
  }
}

/**
 * The year-end seal. While a fiscal year's period-end journals stand, the
 * book and legal entity are closed through that year end: posting into any
 * period ending on or before it would leave the income accounts open again
 * behind the closing entries. The rule is the database's
 * period_end_journal_seal(), the same function the journal_entries storage
 * guard applies, so the kernel refuses by name exactly what storage refuses.
 * The remedy is a controlled reopen of the closing period, whose approval
 * reverses the period-end journals; the refusal carries that period as its
 * reopen scope.
 */
async function assertPeriodNotSealed(
  executor: SqlExecutor,
  args: {
    orgId: string;
    periodId: string;
    bookId: string;
    subsidiaryIds: string[];
    reversesEntryId?: string | null;
  },
): Promise<void> {
  const subsidiaryIds = [...new Set(args.subsidiaryIds)];
  const seal = (
    await executor.execute<{
      fiscal_year: number;
      closing_period_id: string;
      closing_period_label: string;
      subsidiary_id: string;
    }>(
      sql`
    select s.fiscal_year, s.closing_period_id, ${canonicalPeriodLabelSql()} as closing_period_label, s.subsidiary_id
      from period_end_journal_seal(
             ${args.orgId}, ${args.bookId}, ${args.periodId},
             ${subsidiaryIds.length ? `{${subsidiaryIds.join(",")}}` : null}::uuid[],
             ${args.reversesEntryId ?? null}::uuid) s
      join accounting_periods p on p.org_id = ${args.orgId} and p.id = s.closing_period_id`,
      "objects",
    )
  )[0];
  if (!seal) return;
  throw new PeriodClosedError(
    `GL is closed for this period and accounting book by the period-end journals of fiscal year ${seal.fiscal_year} — request a controlled reopen of ${seal.closing_period_label}, whose approval reverses them, to post here`,
    {
      kind: "period-closed",
      periodId: seal.closing_period_id,
      bookId: args.bookId,
      subsidiaryId: seal.subsidiary_id,
      module: "gl",
    },
  );
}

/**
 * The controlled route out of a closed period, appended to the refusal so
 * the operator is never left with a bare "closed". Year-end adjustments
 * belong in the fiscal year's adjustment period while it stands open — the
 * posting kernel honours an explicitly assigned adjustment period without a
 * date-window check, so naming it here is a real path, not a hint. When no
 * adjustment period stands open, the controlled reopen request is the route.
 * Read-only and refusal-path only: the hot path never pays for it.
 */
async function closedPeriodRoute(
  executor: SqlExecutor,
  args: { orgId: string; bookId: string; periodId: string; allowImportedLocks?: boolean },
  module: CloseModule,
  subsidiaryId: string | null,
): Promise<string> {
  const adjustment = (
    await executor.execute<{ id: string; label: string; fiscal_year: number }>(
      sql`
    select p2.id, ${canonicalPeriodLabelSql("p2")} as label, p2.fiscal_year
      from accounting_periods p2
      join accounting_periods p1
        on p1.id = ${args.periodId} and p1.org_id = ${args.orgId}
     where p2.org_id = ${args.orgId}
       and p2.fiscal_calendar_id = p1.fiscal_calendar_id
       and p2.fiscal_year = p1.fiscal_year
       and p2.is_adjustment
     order by p2.period_number limit 1`,
      "objects",
    )
  )[0];
  if (adjustment) {
    // The adjustment period must be open for the same effective gate the
    // posting just failed: the refused module plus GL, under the same
    // exemption the caller opted into.
    let blocked = false;
    for (const name of [...new Set<CloseModule>([module, "gl"])]) {
      const lock = await readEffectivePeriodLock(executor, {
        orgId: args.orgId,
        periodId: adjustment.id,
        bookId: args.bookId,
        subsidiaryId,
        module: name,
      });
      if (periodLockBlocksPosting(lock, args.allowImportedLocks === true)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) {
      return ` — request a controlled reopen, or post this entry into the open adjustment period "${adjustment.label}"`;
    }
  }
  return " — request a controlled reopen to post here";
}

/**
 * Non-throwing companion to assertPeriodModulesOpen for engines whose
 * discovery is advisory: the depreciation and recognition runners skip a
 * closed period instead of failing it. Same gate, same exemption policy — a
 * `false` here means the throwing gate would refuse, including for
 * source-owned imported locks unless the caller explicitly opts into
 * `allowImportedLocks` (only historical replay does).
 */
export async function arePeriodModulesOpen(
  executor: SqlExecutor,
  args: {
    orgId: string;
    periodId: string;
    bookId: string;
    subsidiaryIds: string[];
    modules: CloseModule[];
    /** Historical source replay may cross source-owned locks, never user locks. */
    allowImportedLocks?: boolean;
  },
): Promise<boolean> {
  try {
    await assertPeriodModulesOpen(executor, args);
    return true;
  } catch (error) {
    if (error instanceof CloseError) return false;
    throw error;
  }
}
