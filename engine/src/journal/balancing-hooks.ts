/**
 * Balancing-leg providers — the seam for balancing custom segments.
 *
 * The kernel already balances every entry per subsidiary and injects the
 * intercompany due-to/due-from legs itself. A custom segment marked
 * balancing (segment_definitions.is_balancing) needs the same guarantee per
 * segment value, which the database enforces for every posted entry. The
 * legs that restore that balance (for example interfund due-to/due-from for
 * a fund segment) are domain knowledge the kernel must not import, so the
 * owning module registers a provider here and the two journal writers call
 * collectBalancingLegs on their final line set:
 *
 *   - applySubsidiaries (document posting, regeneration, secondary books,
 *     script-contribution translation), after intercompany legs and before
 *     the restriction checks, so every leg is validated like a kernel line;
 *   - postEntry (every direct posting), before the balance assertion.
 *
 * A provider can only ADD legs. It receives a read-only view of the lines
 * and returns the legs to append; it cannot drop, reorder, or mutate a line
 * the caller produced. A provider that cannot balance (a missing pair, an
 * inactive value) throws a typed refusal naming the remedy; the error
 * propagates unchanged. With no providers registered this is one no-op call.
 * Providers that enforce posting policy skip regeneration; providers that
 * preserve accounting integrity still add their balancing legs.
 *
 * Registration is keyed and idempotent: the composition root runs once per
 * process and again in every test that installs the engine seams, so
 * registering the same key replaces the previous provider instead of
 * running it twice.
 */
import type { Money } from "../money/brands.ts";
import type { SqlExecutor } from "../platform/db.ts";

/** One final-shape line as a provider sees it. Amounts are canonical decimals. */
export interface BalancingLineView {
  readonly accountId: string;
  /** Signed functional-currency amount. */
  readonly amount: string;
  readonly subsidiaryId: string;
  readonly departmentId?: string | null;
  readonly projectId?: string | null;
  readonly locationId?: string | null;
  readonly classId?: string | null;
  readonly currency: string;
  /** Signed transaction-currency amount. */
  readonly txnAmount: string;
  readonly fxRate: string;
  /** Custom segment assignments keyed by segment_definitions.key. */
  readonly extraDims?: Readonly<Record<string, unknown>> | null;
}

/** One leg a provider appends. */
export interface BalancingLeg {
  accountId: string;
  amount: Money;
  subsidiaryId: string;
  currency: string;
  txnAmount: Money;
  fxRate: string;
  /** The leg's own segment assignments (the provider's segment at least). */
  extraDims: Record<string, string>;
  memo: string;
}

export interface BalancingContext {
  orgId: string;
  postingDate: string;
  /** Null resolves to the organization's primary posting book; this call site has not resolved it yet. */
  bookId: string | null;
  sourceDocumentId: string | null;
  /** Policy providers skip regeneration; balancing providers still add legs. */
  regeneration: boolean;
}

export type BalancingLegProvider = (
  runner: SqlExecutor,
  ctx: BalancingContext,
  lines: readonly BalancingLineView[],
) => Promise<readonly BalancingLeg[]>;

const providers = new Map<string, BalancingLegProvider>();

/** Register (or replace) the provider for one balancing segment key. */
export function registerBalancingLegProvider(key: string, provider: BalancingLegProvider): void {
  providers.set(key, provider);
}

/** Remove every provider. Tests only. */
export function clearBalancingLegProviders(): void {
  providers.clear();
}

/**
 * Legs every registered provider appends, in registration order. A later
 * provider sees the lines plus the legs earlier providers returned.
 */
export async function collectBalancingLegs(
  runner: SqlExecutor,
  ctx: BalancingContext,
  lines: readonly BalancingLineView[],
): Promise<BalancingLeg[]> {
  const legs: BalancingLeg[] = [];
  for (const provider of providers.values()) {
    const view: readonly BalancingLineView[] = legs.length === 0 ? lines : [...lines, ...legs];
    legs.push(...(await provider(runner, ctx, view)));
  }
  return legs;
}
