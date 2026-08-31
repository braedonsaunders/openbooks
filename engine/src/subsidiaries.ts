import { sql } from "drizzle-orm";
import type { db } from "./db.ts";
import { add, fromUnits, isZero, mulRate, neg, normalizeDecimal, roundDiv, toUnits } from "./money.ts";

/**
 * Subsidiary context for the posting engine (a multi-entity model inside
 * one tenant). Loads the org's subsidiary tree once per posting, resolves
 * every kernel line to a legal entity, validates restrictions, and — when an
 * entry spans subsidiaries — injects the due-to/due-from legs that make each
 * subsidiary's books balance on their own (the kernel trigger
 * jl_balanced_by_subsidiary is the final authority).
 */

type Runner = Pick<typeof db, "execute">;

export type SubsidiaryRow = {
  id: string;
  parentId: string | null;
  name: string;
  baseCurrency: string;
  isElimination: boolean;
  isActive: boolean;
};

export interface SubsidiaryContext {
  byId: Map<string, SubsidiaryRow>;
  rootId: string;
  /** True when the org has more than one active subsidiary. */
  multi: boolean;
}

export class SubsidiaryError extends Error {}

/** Bind a uuid list as ONE pg-array param — drizzle expands raw JS arrays. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidArray(ids: readonly unknown[]): string {
  for (const [index, id] of ids.entries()) {
    if (typeof id !== "string" || !UUID_RE.test(id)) {
      throw new SubsidiaryError(
        `uuid array element ${index + 1} is not a valid UUID`,
      );
    }
  }
  return `{${ids.join(",")}}`;
}

export async function loadSubsidiaryContext(
  runner: Runner,
  orgId: string,
): Promise<SubsidiaryContext> {
  const r = (await runner.execute<SubsidiaryRow>(sql`
    select id, parent_id as "parentId", name, base_currency as "baseCurrency",
           is_elimination as "isElimination", is_active as "isActive"
      from subsidiaries where org_id = ${orgId}`));
  const byId = new Map(r.rows.map((s) => [s.id, s]));
  const root = r.rows.find((s) => s.parentId === null);
  if (!root) throw new SubsidiaryError(`org ${orgId} has no root subsidiary`);
  return {
    byId,
    rootId: root.id,
    multi: r.rows.filter((s) => s.isActive && !s.isElimination).length > 1,
  };
}

/** All ids in `subId`'s subtree (inclusive). */
export function subtreeIds(ctx: SubsidiaryContext, subId: string): Set<string> {
  const out = new Set<string>([subId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of ctx.byId.values()) {
      if (s.parentId && out.has(s.parentId) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Does a record restricted to `restrictedTo` (+children?) admit `target`?
 * A null restriction admits everything because restrictions are opt-in.
 */
export function restrictionAdmits(
  ctx: SubsidiaryContext,
  restrictedTo: string | null,
  includeChildren: boolean,
  target: string,
): boolean {
  if (!restrictedTo) return true;
  if (restrictedTo === target) return true;
  return includeChildren && subtreeIds(ctx, restrictedTo).has(target);
}

/** Lines the posting engine hands us: account + amount + resolved subsidiary. */
export interface SubLine {
  accountId: string;
  amount: string;
  /** Original transaction-currency amount before functional-currency translation. */
  txnAmount?: string;
  currency?: string;
  fxRate?: string;
  subsidiaryId: string;
  departmentId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  projectId?: string | null;
}

/**
 * Validate that every line's account (and the document's party, when given)
 * admits the subsidiary it posts to. One batched select per concern.
 */
export async function validateSubsidiaryRestrictions(
  runner: Runner,
  opts: {
    orgId: string;
    ctx: SubsidiaryContext;
    lines: SubLine[];
    partyId?: string | null;
    docSubsidiaryId: string;
  },
): Promise<void> {
  const { ctx, lines } = opts;

  for (const l of lines) {
    const s = ctx.byId.get(l.subsidiaryId);
    if (!s) throw new SubsidiaryError(`subsidiary ${l.subsidiaryId} does not exist`);
    if (!s.isActive) throw new SubsidiaryError(`subsidiary "${s.name}" is inactive`);
  }

  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  if (accountIds.length > 0) {
    const r = (await runner.execute<{ id: string; name: string; subsidiaryId: string; includeChildren: boolean }>(sql`
      select id, name, subsidiary_id as "subsidiaryId",
             subsidiary_include_children as "includeChildren"
        from accounts where id = any(${uuidArray(accountIds)}::uuid[])
         and org_id = ${opts.orgId}
         and subsidiary_id is not null`));
    const restricted = new Map(r.rows.map((a) => [a.id, a]));
    for (const l of lines) {
      const a = restricted.get(l.accountId);
      if (a && !restrictionAdmits(ctx, a.subsidiaryId, a.includeChildren, l.subsidiaryId)) {
        throw new SubsidiaryError(
          `account "${a.name}" is restricted to another subsidiary and cannot be posted to by "${ctx.byId.get(l.subsidiaryId)?.name}"`,
        );
      }
    }
  }

  if (opts.partyId) {
    const r = (await runner.execute<{ name: string; subsidiaryId: string | null; extra: string[] }>(sql`
      select p.display_name as name, p.subsidiary_id as "subsidiaryId",
             coalesce(json_agg(ps.subsidiary_id) filter (where ps.subsidiary_id is not null), '[]') as extra
        from parties p left join party_subsidiaries ps on ps.party_id = p.id
       where p.id = ${opts.partyId} and p.org_id = ${opts.orgId}
       group by p.id`));
    const p = r.rows[0];
    if (p) {
      const allowed = new Set([p.subsidiaryId ?? ctx.rootId, ...p.extra]);
      if (!allowed.has(opts.docSubsidiaryId)) {
        throw new SubsidiaryError(
          `"${p.name}" does not transact with subsidiary "${ctx.byId.get(opts.docSubsidiaryId)?.name}" — add it on the entity record first`,
        );
      }
    }
  }

  const dimensions = [
    { table: "departments" as const, key: "departmentId" as const },
    { table: "locations" as const, key: "locationId" as const },
    { table: "classes" as const, key: "classId" as const },
    { table: "projects" as const, key: "projectId" as const },
  ];
  for (const d of dimensions) {
    const ids = [...new Set(lines.map((line) => line[d.key]).filter((id): id is string => !!id))];
    if (ids.length === 0) continue;
    const r = (await runner.execute<{ id: string; name: string; subsidiaryId: string; includeChildren: boolean }>(sql`
      select id, name, subsidiary_id as "subsidiaryId",
             subsidiary_include_children as "includeChildren"
        from ${sql.raw(d.table)}
       where id = any(${uuidArray(ids)}::uuid[])
         and org_id = ${opts.orgId}
         and subsidiary_id is not null`));
    const restricted = new Map(r.rows.map((row) => [row.id, row]));
    for (const line of lines) {
      const id = line[d.key];
      const row = id ? restricted.get(id) : undefined;
      if (row && !restrictionAdmits(ctx, row.subsidiaryId, row.includeChildren, line.subsidiaryId)) {
        throw new SubsidiaryError(
          `${d.table.slice(0, -1)} "${row.name}" is restricted to another subsidiary and cannot be used by "${ctx.byId.get(line.subsidiaryId)?.name}"`,
        );
      }
    }
  }
}

export interface IntercompanyLeg {
  accountId: string;
  amount: string;
  currency: string;
  txnAmount: string;
  fxRate: string;
  subsidiaryId: string;
  memo: string;
}

const FX_RATE_SCALE = 10_000_000_000n;

/**
 * Derive the one FX rate that represents a subsidiary's complete balancing
 * leg. The source lines may have different rates, so taking any one line's
 * rate would make the leg's functional amount disagree with its transaction
 * amount. Ratio the already-posted totals instead: this preserves both the
 * subsidiary balance and the transaction-currency evidence at the ledger's
 * ten-decimal FX precision.
 */
function aggregateFxRate(functionalTotal: string, transactionTotal: string): string {
  const functionalUnits = toUnits(functionalTotal);
  const transactionUnits = toUnits(transactionTotal);
  const transactionMagnitude = transactionUnits < 0n ? -transactionUnits : transactionUnits;
  if (transactionMagnitude === 0n) {
    throw new SubsidiaryError(
      "cannot derive an intercompany FX rate from a zero transaction-currency total",
    );
  }
  const functionalMagnitude = functionalUnits < 0n ? -functionalUnits : functionalUnits;
  if ((functionalUnits < 0n) !== (transactionUnits < 0n)) {
    throw new SubsidiaryError(
      "intercompany functional and transaction totals have opposite signs and cannot share a positive FX rate",
    );
  }
  const rateUnits = roundDiv(functionalMagnitude * FX_RATE_SCALE, transactionMagnitude);
  if (rateUnits <= 0n) {
    throw new SubsidiaryError(
      "intercompany functional total is too small to represent with a positive FX rate",
    );
  }
  const whole = rateUnits / FX_RATE_SCALE;
  if (whole.toString().length > 9) {
    throw new SubsidiaryError(
      "intercompany aggregate FX rate exceeds the ledger's numeric(19,10) range",
    );
  }
  const fraction = (rateUnits % FX_RATE_SCALE).toString().padStart(10, "0");
  return `${whole}.${fraction}`;
}

/**
 * Per-line FX translation rounds each line independently (mulRate), so a
 * document whose transaction-currency amounts balance exactly can post
 * functional amounts that miss zero by a few ten-thousandths. Ordinary
 * single-entity documents get no intercompany legs to absorb that, and the
 * kernel requires exact balance — so each subsidiary's own rounding residual
 * is folded onto ONE line of its group. The bucket is chosen by ROLE, never
 * by position: a tax control leg (stamped with a tax code) must carry exactly
 * its translated statutory charge — the statutory return sums these lines
 * straight into filed figures — and an open-item control leg must equal the
 * amount its subledger item settles at. Among the remaining lines the
 * largest-magnitude one takes the residual, so the adjustment is a pure
 * function of the ordered lines and regeneration reproduces it exactly.
 *
 * Only a group whose transaction amounts already sum to zero can be carrying
 * rounding; anything else is real economics left for the intercompany
 * balancer to pair (or the kernel to refuse). A transaction-balanced group
 * whose functional residual exceeds half a ledger unit per line cannot be
 * rounding and is refused loudly instead of flattened into the ledger — and a
 * group made up entirely of control legs has no lawful bucket and is refused
 * the same way. The adjustment touches functional amounts only.
 */
export function absorbFxRoundingResidual<
  T extends {
    accountId: string;
    amount: string;
    subsidiaryId: string;
    txnAmount?: string | null;
    /** Present on tax control legs: the statutory charge is untouchable. */
    taxCodeId?: string | null;
    /** Present on AR/AP settlement legs: the open item settles at this amount. */
    isOpenItem?: boolean;
  },
>(lines: T[]): void {
  const groups = new Map<string, T[]>();
  for (const line of lines) {
    const group = groups.get(line.subsidiaryId);
    if (group) group.push(line);
    else groups.set(line.subsidiaryId, [line]);
  }
  for (const [subId, group] of groups) {
    let transactional = 0n;
    for (const l of group) transactional += toUnits(l.txnAmount ?? l.amount);
    if (transactional !== 0n) continue;
    const total = group.reduce((acc, l) => acc + toUnits(l.amount), 0n);
    if (total === 0n) continue;
    // Each line's translation error is bounded by half a ledger unit, so a
    // transaction-balanced group is only rounding while |total| ≤ n/2 units.
    const magnitude = total < 0n ? -total : total;
    if (2n * magnitude > BigInt(group.length)) {
      throw new SubsidiaryError(
        `functional-currency residual ${fromUnits(total)} on subsidiary ${subId} exceeds per-line FX rounding and cannot be absorbed`,
      );
    }
    let bucket: T | undefined;
    let bucketMagnitude = 0n;
    for (const line of group) {
      if (line.taxCodeId || line.isOpenItem) continue;
      const units = toUnits(line.amount);
      const m = units < 0n ? -units : units;
      if (!bucket || m > bucketMagnitude) {
        bucket = line;
        bucketMagnitude = m;
      }
    }
    if (!bucket) {
      throw new SubsidiaryError(
        `functional-currency residual ${fromUnits(total)} on subsidiary ${subId} has no line that may absorb it — every line is a tax control or open-item leg`,
      );
    }
    bucket.amount = fromUnits(toUnits(bucket.amount) - total);
  }
}

/**
 * Balance a multi-subsidiary line set with due-to/due-from legs.
 *
 * For every subsidiary other than the originating one whose lines don't sum
 * to zero, the configured intercompany pair supplies the balancing accounts:
 * the counter-subsidiary books the offset on its side of the pair, and the
 * originating subsidiary books the economically equivalent mirror in its own
 * functional currency. Source lines already carry functional amounts plus
 * transaction-currency amounts; the common transaction currency is what lets
 * cross-currency subsidiaries agree on value while each legal entity balances
 * in its own books. Returns [] when the lines already balance per subsidiary.
 */
export async function intercompanyBalancingLegs(
  runner: Runner,
  opts: {
    orgId: string;
    ctx: SubsidiaryContext;
    originSubId: string;
    originFxRate: string;
    lines: SubLine[];
  },
): Promise<IntercompanyLeg[]> {
  const { ctx, originSubId, lines } = opts;
  const bySub = new Map<string, string>();
  const txnBySub = new Map<string, string>();
  for (const l of lines) {
    bySub.set(l.subsidiaryId, add(bySub.get(l.subsidiaryId) ?? "0", l.amount));
    txnBySub.set(l.subsidiaryId, add(txnBySub.get(l.subsidiaryId) ?? "0", l.txnAmount ?? l.amount));
  }
  if (bySub.size <= 1) return [];

  const others = [...bySub.entries()].filter(([subId]) => subId !== originSubId);
  const unbalanced = others.filter(([, total]) => !isZero(total));
  if (unbalanced.length === 0 && isZero(bySub.get(originSubId) ?? "0")) return [];

  const pairIds = unbalanced.map(([subId]) => subId);
  const r = (await runner.execute<{ fromId: string; toId: string; dueFrom: string; dueTo: string }>(sql`
    select from_subsidiary_id as "fromId", to_subsidiary_id as "toId",
           due_from_account_id as "dueFrom", due_to_account_id as "dueTo"
      from intercompany_pairs
     where org_id = ${opts.orgId} and is_active
       and ((from_subsidiary_id = ${originSubId} and to_subsidiary_id = any(${uuidArray(pairIds)}::uuid[]))
         or (to_subsidiary_id = ${originSubId} and from_subsidiary_id = any(${uuidArray(pairIds)}::uuid[])))`));

  const legs: IntercompanyLeg[] = [];
  for (const [subId, total] of unbalanced) {
    const pair = r.rows.find(
      (p) =>
        (p.fromId === originSubId && p.toId === subId) ||
        (p.fromId === subId && p.toId === originSubId),
    );
    const subName = ctx.byId.get(subId)?.name;
    const originName = ctx.byId.get(originSubId)?.name;
    if (!pair) {
      throw new SubsidiaryError(
        `no intercompany pair between "${originName}" and "${subName}" — configure one under Setup → Subsidiaries`,
      );
    }
    // The counter-subsidiary books the offset on ITS side of the pair; the
    // originating subsidiary books the mirror on its own side. due_from is
    // the asset on the pair's from-side, due_to the liability on its to-side.
    const subAccount = pair.fromId === subId ? pair.dueFrom : pair.dueTo;
    const originAccount = pair.fromId === originSubId ? pair.dueFrom : pair.dueTo;
    const transactionTotal = txnBySub.get(subId) ?? total;
    const subLines = lines.filter((line) => line.subsidiaryId === subId);
    const transactionCurrency = subLines[0]?.currency;
    if (!transactionCurrency) {
      throw new SubsidiaryError(`transaction currency is missing for "${subName}"`);
    }
    // Keep the source representation when every line agrees on its rate (the
    // common path), but blend differing rates from the posted totals. The
    // relation check also routes same-rate groups through the aggregate when
    // line rounding made the source rate unable to represent the net leg.
    const firstFxRate = subLines[0]?.fxRate ?? "1";
    const normalizedFirstFxRate = normalizeDecimal(firstFxRate, 10);
    const oneFxRate = subLines.every(
      (line) => normalizeDecimal(line.fxRate ?? "1", 10) === normalizedFirstFxRate,
    );
    const subFxRate =
      oneFxRate && mulRate(transactionTotal, firstFxRate) === total
        ? firstFxRate
        : aggregateFxRate(total, transactionTotal);
    const originAmount = mulRate(transactionTotal, opts.originFxRate);
    legs.push({
      accountId: subAccount,
      amount: neg(total),
      currency: transactionCurrency,
      txnAmount: neg(transactionTotal),
      fxRate: subFxRate,
      subsidiaryId: subId,
      memo: `Intercompany with ${originName}`,
    });
    legs.push({
      accountId: originAccount,
      amount: originAmount,
      currency: transactionCurrency,
      txnAmount: transactionTotal,
      fxRate: opts.originFxRate,
      subsidiaryId: originSubId,
      memo: `Intercompany with ${subName}`,
    });
  }

  // Line-by-line FX rounding can leave a few functional-currency ten-thousandths
  // at the origin. Keep the original rate economics and transaction-currency
  // evidence, but absorb that rounding on the final origin due-to/from leg so
  // the database invariant is exact.
  const originLegs = legs.filter((leg) => leg.subsidiaryId === originSubId);
  if (originLegs.length > 0) {
    let residual = bySub.get(originSubId) ?? "0";
    for (const leg of originLegs) residual = add(residual, leg.amount);
    if (!isZero(residual)) {
      const last = originLegs[originLegs.length - 1]!;
      last.amount = add(last.amount, neg(residual));
    }
  }

  for (const subId of bySub.keys()) {
    let residual = bySub.get(subId) ?? "0";
    for (const leg of legs) if (leg.subsidiaryId === subId) residual = add(residual, leg.amount);
    if (!isZero(residual)) {
      throw new SubsidiaryError(
        `intercompany balancing failed for "${ctx.byId.get(subId)?.name}" (residual ${residual})`,
      );
    }
  }
  return legs;
}
