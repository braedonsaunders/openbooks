import { sql } from "drizzle-orm";
import type { db } from "./db.ts";
import { add, isZero, mulRate, neg } from "./money.ts";

/**
 * Subsidiary context for the posting engine (NetSuite OneWorld model inside
 * one tenant). Loads the org's subsidiary tree once per posting, resolves
 * every kernel line to a legal entity, validates restrictions, and — when an
 * entry spans subsidiaries — injects the due-to/due-from legs that make each
 * subsidiary's books balance on their own (the kernel trigger
 * jl_balanced_by_subsidiary is the final authority).
 */

type Runner = Pick<typeof db, "execute">;

export interface SubsidiaryRow {
  id: string;
  parentId: string | null;
  name: string;
  baseCurrency: string;
  isElimination: boolean;
  isActive: boolean;
}

export interface SubsidiaryContext {
  byId: Map<string, SubsidiaryRow>;
  rootId: string;
  /** True when the org has more than one active subsidiary. */
  multi: boolean;
}

export class SubsidiaryError extends Error {}

/** Bind a uuid list as ONE pg-array param — drizzle expands raw JS arrays. */
const uuidArray = (ids: string[]) => `{${ids.join(",")}}`;

export async function loadSubsidiaryContext(
  runner: Runner,
  orgId: string,
): Promise<SubsidiaryContext> {
  const r = (await runner.execute(sql`
    select id, parent_id as "parentId", name, base_currency as "baseCurrency",
           is_elimination as "isElimination", is_active as "isActive"
      from subsidiaries where org_id = ${orgId}`)) as unknown as { rows: SubsidiaryRow[] };
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
 * A null restriction admits everything — restriction is opt-in, per NetSuite.
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
    const r = (await runner.execute(sql`
      select id, name, subsidiary_id as "subsidiaryId",
             subsidiary_include_children as "includeChildren"
        from accounts where id = any(${uuidArray(accountIds)}::uuid[])
         and subsidiary_id is not null`)) as unknown as {
      rows: { id: string; name: string; subsidiaryId: string; includeChildren: boolean }[];
    };
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
    const r = (await runner.execute(sql`
      select p.display_name as name, p.subsidiary_id as "subsidiaryId",
             coalesce(json_agg(ps.subsidiary_id) filter (where ps.subsidiary_id is not null), '[]') as extra
        from parties p left join party_subsidiaries ps on ps.party_id = p.id
       where p.id = ${opts.partyId}
       group by p.id`)) as unknown as {
      rows: { name: string; subsidiaryId: string | null; extra: string[] }[];
    };
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
    const r = (await runner.execute(sql`
      select id, name, subsidiary_id as "subsidiaryId",
             subsidiary_include_children as "includeChildren"
        from ${sql.raw(d.table)}
       where id = any(${uuidArray(ids)}::uuid[])
         and subsidiary_id is not null`)) as unknown as {
      rows: { id: string; name: string; subsidiaryId: string; includeChildren: boolean }[];
    };
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
  const r = (await runner.execute(sql`
    select from_subsidiary_id as "fromId", to_subsidiary_id as "toId",
           due_from_account_id as "dueFrom", due_to_account_id as "dueTo"
      from intercompany_pairs
     where org_id = ${opts.orgId} and is_active
       and ((from_subsidiary_id = ${originSubId} and to_subsidiary_id = any(${uuidArray(pairIds)}::uuid[]))
         or (to_subsidiary_id = ${originSubId} and from_subsidiary_id = any(${uuidArray(pairIds)}::uuid[])))`)) as unknown as {
    rows: { fromId: string; toId: string; dueFrom: string; dueTo: string }[];
  };

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
    const transactionCurrency = lines.find((line) => line.subsidiaryId === subId)?.currency;
    const subFxRate = lines.find((line) => line.subsidiaryId === subId)?.fxRate ?? "1";
    if (!transactionCurrency) {
      throw new SubsidiaryError(`transaction currency is missing for "${subName}"`);
    }
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
  // at the origin. Keep the original rate economics, but absorb that rounding
  // on the final origin due-to/from leg so the database invariant is exact.
  const originLegs = legs.filter((leg) => leg.subsidiaryId === originSubId);
  if (originLegs.length > 0) {
    let residual = bySub.get(originSubId) ?? "0";
    for (const leg of originLegs) residual = add(residual, leg.amount);
    if (!isZero(residual)) {
      const last = originLegs[originLegs.length - 1]!;
      last.amount = add(last.amount, neg(residual));
      last.txnAmount = last.amount;
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
