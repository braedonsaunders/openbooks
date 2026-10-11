import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

export class CloseError extends Error {}

export const CLOSE_MODULES = [
  "ar",
  "ap",
  "banking",
  "assets",
  "tax",
  "gl",
] as const;
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
  return lock.state === "closed" || (
    lock.state === "open" && lock.reopenExpiresAt != null && new Date(lock.reopenExpiresAt) <= now
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
export const NON_POSTING_DOCUMENT_KINDS: readonly string[] = ["quote", "sales_order", "purchase_order", "pick_list", "shipment", "rma", "field_ticket"];

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
  },
): Promise<void> {
  const modules = [...new Set<CloseModule>([...args.modules, "gl"])];
  const subsidiaryIds: (string | null)[] = args.subsidiaryIds.length
    ? [...new Set(args.subsidiaryIds)]
    : [null];
  for (const subsidiaryId of subsidiaryIds) {
    for (const module of modules) {
      const result = (await executor.execute<{ state: string; reopenExpiresAt: Date | string | null; reason: string | null }>(sql`
        select state, reopen_expires_at as "reopenExpiresAt", reason
          from period_locks
         where org_id = ${args.orgId} and period_id = ${args.periodId}
           and book_id = ${args.bookId} and module = ${module}
           and (subsidiary_id is not distinct from ${subsidiaryId} or subsidiary_id is null)
         order by (subsidiary_id is not null) desc
         limit 1`));
      if (periodLockBlocksPosting(result.rows[0], args.allowImportedLocks === true))
        throw new CloseError(
          `${module.toUpperCase()} is closed for this period and accounting book${await closedPeriodRoute(executor, args, module, subsidiaryId)}`,
        );
    }
  }
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
  const adjustment = (await executor.execute<{ id: string; name: string; fiscal_year: number }>(sql`
    select p2.id, p2.name, p2.fiscal_year
      from accounting_periods p2
      join accounting_periods p1
        on p1.id = ${args.periodId} and p1.org_id = ${args.orgId}
     where p2.org_id = ${args.orgId}
       and p2.fiscal_calendar_id = p1.fiscal_calendar_id
       and p2.fiscal_year = p1.fiscal_year
       and p2.is_adjustment
     order by p2.period_number limit 1`)).rows[0];
  if (adjustment) {
    // The adjustment period must be open for the same effective gate the
    // posting just failed: the refused module plus GL, under the same
    // exemption the caller opted into.
    let blocked = false;
    for (const name of [...new Set<CloseModule>([module, "gl"])]) {
      const lock = (await executor.execute<{ state: string; reopenExpiresAt: Date | string | null; reason: string | null }>(sql`
        select state, reopen_expires_at as "reopenExpiresAt", reason
          from period_locks
         where org_id = ${args.orgId} and period_id = ${adjustment.id}
           and book_id = ${args.bookId} and module = ${name}
           and (subsidiary_id is not distinct from ${subsidiaryId} or subsidiary_id is null)
         order by (subsidiary_id is not null) desc
         limit 1`));
      if (periodLockBlocksPosting(lock.rows[0], args.allowImportedLocks === true)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) {
      return ` — request a controlled reopen, or post this entry into the open adjustment period "${adjustment.name}" for fiscal year ${adjustment.fiscal_year}`;
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
