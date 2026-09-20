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

export function periodLockBlocksPosting(
  lock: { state: string; reopenExpiresAt: Date | string | null; reason: string | null } | undefined,
  allowImportedLock: boolean,
  now = new Date(),
): boolean {
  if (!lock) return false;
  if (allowImportedLock && lock.reason === "close.importedPeriodLockReason") return false;
  return lock.state === "closed" || (
    lock.state === "open" && lock.reopenExpiresAt != null && new Date(lock.reopenExpiresAt) <= now
  );
}

/**
 * Period-close module per document kind. The drawer kinds mirror
 * web/lib/document-kinds.ts `closeModule` (a required registry field, so a
 * new kind cannot be declared without a module decision); the parity test in
 * close.test.ts fails if this map and that field ever drift. Kinds outside
 * the drawer registry — payments, orders, expenses, manual journals — are
 * decided here. An unknown kind is a hard failure: silently posting under
 * the GL lock alone once let cheques, deposits, and transfers bypass their
 * closed AP and banking locks.
 */
const DOCUMENT_CLOSE_MODULES = {
  // Drawer registry kinds (web/lib/document-kinds.ts DOC_KINDS).
  vendor_bill: "ap",
  vendor_credit: "ap",
  customer_invoice: "ar",
  customer_credit: "ar",
  card_charge: "ap",
  card_refund: "ap",
  check: "ap",
  deposit: "banking",
  transfer: "banking",
  project_charge: "gl",
  pay_run: "gl",
  // Non-drawer kinds.
  customer_payment: "ar",
  vendor_payment: "ap",
  expense_report: "ap",
  sales_order: "ar",
  purchase_order: "ap",
  quote: "ar",
  journal: "gl",
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
 * Kinds that never carry a posted journal entry (quotes, orders). Their
 * close module still governs whether they may be created or voided in a
 * locked period, but they have no posting period to assign and cannot be
 * "unposted" — so close readiness must not count them as drafts or as
 * documents missing a posting period. A mirror tenant with hundreds of open
 * orders otherwise sees a permanent critical blocker it can never clear.
 */
export const NON_POSTING_DOCUMENT_KINDS: readonly string[] = ["quote", "sales_order", "purchase_order"];

export function closeModuleForDocument(kind: string): CloseModule {
  const decided = (DOCUMENT_CLOSE_MODULES as Record<string, CloseModule>)[kind];
  if (!decided) {
    throw new CloseError(
      `document kind "${kind}" has no period-close module decision; add it to DOCUMENT_CLOSE_MODULES and web/lib/document-kinds.ts`,
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
          `${module.toUpperCase()} is closed for this period and accounting book`,
        );
    }
  }
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

