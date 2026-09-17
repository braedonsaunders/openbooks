import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { currentUser } from "./auth";
import type { StatementSubsidiaryContext } from "./statement-matrix";
import { allowedSubsidiaryIds, subsidiaryOptions, subtreeIds, type SubsidiaryOption } from "./subsidiaries";
import { subsidiaryFeatureEnabled } from "./features";

/**
 * Resolves a report's subsidiary picker value into the statement engine's
 * subsidiary context (source platform semantics):
 *   - no subsidiaries beyond the root  → no context (unchanged single-entity org)
 *   - a leaf                            → standalone view of that entity
 *   - a parent (or nothing = the root)  → CONSOLIDATED subtree: children plus
 *     elimination subsidiaries, each foreign-currency entity translated via
 *     the WINDOWED consolidated rates of every accounting period up to the
 *     report date, so each column and historical bucket uses its own period's
 *     rates (missing rates fail loudly — derive first).
 */

export class MissingRatesError extends Error {}

/**
 * Typed surface contract for a statement blocked on underived consolidated
 * rates (F-t06-025). The description carries the kernel's user-language
 * message verbatim (it names the pair and period); the code lets surfaces
 * render a localized banner with a derive link instead of throwing.
 */
export interface RatesBlockedNotice {
  code: 'rates-not-derived'
  title: string
  description: string
  deriveLabel: string
  deriveHref: string
}

/**
 * Pure root-owned rule shared by every subsidiary-context consumer: the
 * viewed set reads null-subsidiary (root-owned) rows alongside attributed
 * rows exactly when the caller is unrestricted AND the viewed set contains
 * the org root — the same population the line-side readers see (posting
 * stamps every leg with the root id, so the matrix never drops them).
 * Restricted callers stay fail-closed (even with full-entity visibility),
 * and an explicitly branch-scoped view hides root-owned rows exactly like
 * its statement cell does. A missing root is degenerate; unrestricted
 * callers keep the established unaffected behavior.
 */
export function resolveNullSubsidiaryInclusion(
  allowed: Set<string> | null,
  rootId: string | undefined,
  inViewIds: readonly string[],
): boolean {
  if (allowed !== null) return false;
  if (rootId === undefined) return true;
  return inViewIds.includes(rootId);
}

export interface ResolvedSubsidiaryView {
  /** Undefined = single-subsidiary org; statements run untouched. */
  subsidiary?: StatementSubsidiaryContext;
  /** Presentation currency of the view (the context node's functional ccy). */
  currency?: string;
  /** The node's name + whether this is a consolidated (subtree) view. */
  label?: string;
  consolidated: boolean;
  /** Options for the filter-bar picker (elimination subs excluded). */
  options: SubsidiaryOption[];
}

/**
 * Scope resolution that never refuses on underived consolidated rates
 * (F-t06-001): operational cockpits (banking overview) translate at dated
 * spot rates, not period consolidated rates, so they must keep reading
 * their scope — and keep offering the subsidiary picker as an escape to a
 * single-entity view — while a formal statement would refuse. The would-be
 * refusal rides along as `ratesError` (null when rates cover the view) so
 * the caller can still pin the derive-rates banner beside live figures.
 */
export interface ResolvedSubsidiaryScope extends ResolvedSubsidiaryView {
  /** The refusal `resolveSubsidiaryView` would throw; null when covered. */
  ratesError: MissingRatesError | null;
}

export async function resolveSubsidiaryScope(
  subsidiaryId: string | undefined,
  periodTo: string,
  allowed: Set<string> | null = null,
): Promise<ResolvedSubsidiaryScope> {
  const all = await subsidiaryOptions(false, true);
  const visible = allowed ? all.filter((s) => allowed.has(s.id)) : all;
  const pickerOptions = visible.filter((s) => !s.isElimination);
  if (allowed === null && all.filter((s) => !s.isElimination).length <= 1)
    return { consolidated: false, options: [], ratesError: null };

  const root = all.find((s) => s.parentId === null);
  const node =
    (subsidiaryId && pickerOptions.find((s) => s.id === subsidiaryId)) ||
    (allowed ? pickerOptions[0] : root && pickerOptions.find((s) => s.id === root.id)) ||
    pickerOptions[0];
  if (!node)
    return { consolidated: false, options: pickerOptions, subsidiary: { ids: [], includeNullSubsidiary: false }, ratesError: null };

  const subtree = subtreeIds(all, node.id);
  const members = all.filter(
    (s) => subtree.has(s.id) && (!allowed || allowed.has(s.id)),
  );
  const nonElim = members.filter((s) => !s.isElimination);
  const consolidated = nonElim.length > 1;
  // Standalone leaf: just that entity. Consolidated: subtree + eliminations.
  let inView = consolidated ? members : [node];
  let weights: StatementSubsidiaryContext["weights"];
  if (consolidated) {
    const ownership = (await db.execute<{ id: string; factor: string }>(sql`
      with recursive ownership_scope as (
        select s.id, s.org_id, 1::numeric as factor
          from subsidiaries s where s.id=${node.id}
        union all
        select child.id, parent.org_id,
               parent.factor * case
                 when interest.method='equity' then 0::numeric
                 when interest.method='proportionate' then interest.ownership_percent / 100::numeric
                 else 1::numeric
               end
          from ownership_scope parent
          join subsidiaries child on child.parent_id=parent.id and child.org_id=parent.org_id and child.is_active
          left join lateral (
            select method,ownership_percent
              from subsidiary_ownership_interests policy
             where policy.subsidiary_id=child.id and policy.parent_subsidiary_id=parent.id
               and policy.org_id=child.org_id
               and policy.is_active and policy.effective_from<=${periodTo}
               and (policy.effective_to is null or policy.effective_to>=${periodTo})
             order by policy.effective_from desc limit 1
          ) interest on true
      )
      select id,factor::text from ownership_scope
    `));
    const factorById = new Map(ownership.rows.map((row) => [row.id, row.factor]));
    inView = inView.filter((member) => factorById.get(member.id) !== "0");
    weights = inView
      .map((member) => ({ subsidiaryId: member.id, factor: factorById.get(member.id) ?? "1" }))
      .filter((weight) => weight.factor !== "1");
  }

  const foreign = [...new Set(inView.filter((s) => s.baseCurrency !== node.baseCurrency).map((s) => s.baseCurrency))];
  let rates: StatementSubsidiaryContext["rates"];
  let ratesError: MissingRatesError | null = null;
  if (consolidated && foreign.length > 0) {
    // Rate sets load for EVERY accounting period ending on or before the
    // report date (scoped to the node's org), so comparative columns and
    // lifetime buckets translate through the rates of the period their
    // activity actually falls in — never a single set borrowed from the
    // report's own period. The report period's set stays mandatory here:
    // resolveSubsidiaryView refuses a context whose own period has no rates.
    //
    // Rate windows are posting-date windows, so they must partition the
    // calendar: an adjustment period shares its final regular period's
    // dates and is excluded — activity dated on that day translates through
    // the regular period's rates, whichever period_id the journal carries.
    const scope = (await db.execute<{ org_id: string }>(sql`
      select org_id from subsidiaries where id = ${node.id}`));
    if (!scope.rows[0]) throw new Error(`subsidiary ${node.id} not found while resolving consolidated rates`);
    const r = (await db.execute<{ from: string; pFrom: string; pTo: string; avg: string; cur: string; hist: string }>(sql`
      select cf.from_currency as "from", p.starts_on as "pFrom", p.ends_on as "pTo",
             cf.average_rate as "avg", cf.current_rate as "cur", cf.historical_rate as "hist"
        from consolidated_fx_rates cf
        join accounting_periods p on p.id = cf.period_id and p.org_id = cf.org_id
       where cf.org_id = ${scope.rows[0].org_id} and p.org_id = ${scope.rows[0].org_id}
         and cf.to_currency = ${node.baseCurrency}
         and cf.from_currency = any(${`{${foreign.join(",")}}`}::text[])
         and p.ends_on <= ${periodTo}
         and not p.is_adjustment
       order by p.ends_on`));
    const byCcy = new Map<string, typeof r.rows>();
    for (const row of r.rows) {
      const list = byCcy.get(row.from);
      if (list) list.push(row);
      else byCcy.set(row.from, [row]);
    }
    const missing = foreign.filter(
      (c) => !(byCcy.get(c) ?? []).some((x) => x.pFrom <= periodTo && periodTo <= x.pTo),
    );
    // Never throw here: the refusal rides along for the caller to convert
    // into a banner (F-t06-001) or throw (formal statements).
    if (missing.length > 0) {
      ratesError = new MissingRatesError(
        `No consolidated exchange rates for ${missing.join(", ")} → ${node.baseCurrency} in the period ending ${periodTo}. Derive rates from period close first.`,
      );
    }
    if (!ratesError) {
      rates = inView
        .filter((s) => s.baseCurrency !== node.baseCurrency)
        .flatMap((s) =>
          byCcy.get(s.baseCurrency)!.map((row) => ({
            subsidiaryId: s.id,
            currency: s.baseCurrency,
            periodFrom: row.pFrom,
            periodTo: row.pTo,
            averageRate: row.avg,
            currentRate: row.cur,
            historicalRate: row.hist,
          })),
        );
    }
  }

  const includeNullSubsidiary = resolveNullSubsidiaryInclusion(
    allowed,
    root?.id,
    inView.map((s) => s.id),
  );
  return {
    subsidiary: { ids: inView.map((s) => s.id), rates, weights, includeNullSubsidiary },
    currency: node.baseCurrency,
    label: consolidated ? `${node.name} (consolidated)` : node.name,
    consolidated,
    options: pickerOptions,
    ratesError,
  };
}

export async function resolveSubsidiaryView(
  subsidiaryId: string | undefined,
  periodTo: string,
  allowed: Set<string> | null = null,
): Promise<ResolvedSubsidiaryView> {
  const scoped = await resolveSubsidiaryScope(subsidiaryId, periodTo, allowed);
  if (scoped.ratesError) throw scoped.ratesError;
  return {
    subsidiary: scoped.subsidiary,
    currency: scoped.currency,
    label: scoped.label,
    consolidated: scoped.consolidated,
    options: scoped.options,
  };
}

/**
 * One-call bundle for report pages: resolves the current user's subsidiary
 * visibility, the requested context, and the filter-bar picker rows (tree-
 * indented; parents labelled "(consolidated)"; first row = the default view).
 */
export async function reportSubsidiaryView(
  subsidiaryId: string | undefined,
  periodTo: string,
): Promise<ResolvedSubsidiaryView & { picker: { id: string; label: string }[] }> {
  const scoped = await reportSubsidiaryScope(subsidiaryId, periodTo);
  if (scoped.ratesError) throw scoped.ratesError;
  return {
    subsidiary: scoped.subsidiary,
    currency: scoped.currency,
    label: scoped.label,
    consolidated: scoped.consolidated,
    options: scoped.options,
    picker: scoped.picker,
  };
}

/**
 * Scope bundle that never refuses on underived consolidated rates
 * (F-t06-001): same visibility, context, and picker rows as
 * `reportSubsidiaryView`, with the would-be refusal as `ratesError`.
 * Operational cockpits read their scope and figures through this and pin
 * the banner beside live numbers; formal statements keep throwing via
 * `reportSubsidiaryView`.
 */
export async function reportSubsidiaryScope(
  subsidiaryId: string | undefined,
  periodTo: string,
): Promise<ResolvedSubsidiaryScope & { picker: { id: string; label: string }[] }> {
  const user = await currentUser();
  const subsidiaryUiEnabled = Boolean(user && await subsidiaryFeatureEnabled(user.orgId));
  const allowed = user ? (user.isSuperAdmin ? null : await allowedSubsidiaryIds(user.id, user.orgId)) : new Set<string>();
  if (!subsidiaryUiEnabled && allowed === null) {
    return { consolidated: false, options: [], picker: [], ratesError: null };
  }
  const view = await resolveSubsidiaryScope(subsidiaryId, periodTo, allowed);
  if (!subsidiaryUiEnabled) return { ...view, picker: [] };
  const hasChildren = new Set(view.options.map((s) => s.parentId).filter(Boolean));
  const picker = view.options.map((s) => ({
    id: s.id,
    label: `${" ".repeat(s.depth)}${s.name}${hasChildren.has(s.id) ? " (consolidated)" : ""}`,
  }));
  return { ...view, picker };
}
