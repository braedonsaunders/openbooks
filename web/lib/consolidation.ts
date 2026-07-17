import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { currentUser } from "./auth";
import type { StatementSubsidiaryContext } from "./statement-matrix";
import { allowedSubsidiaryIds, subsidiaryOptions, subtreeIds, type SubsidiaryOption } from "./subsidiaries";

/**
 * Resolves a report's subsidiary picker value into the statement engine's
 * subsidiary context (NetSuite semantics):
 *   - no subsidiaries beyond the root  → no context (unchanged single-entity org)
 *   - a leaf                            → standalone view of that entity
 *   - a parent (or nothing = the root)  → CONSOLIDATED subtree: children plus
 *     elimination subsidiaries, each foreign-currency entity translated via the
 *     period's consolidated rates (missing rates fail loudly — derive first).
 */

export class MissingRatesError extends Error {}

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

export async function resolveSubsidiaryView(
  subsidiaryId: string | undefined,
  periodTo: string,
  allowed: Set<string> | null = null,
): Promise<ResolvedSubsidiaryView> {
  const all = await subsidiaryOptions(false, true);
  const visible = allowed ? all.filter((s) => allowed.has(s.id)) : all;
  const pickerOptions = visible.filter((s) => !s.isElimination);
  if (all.filter((s) => !s.isElimination).length <= 1) return { consolidated: false, options: [] };

  const root = all.find((s) => s.parentId === null);
  const node =
    (subsidiaryId && pickerOptions.find((s) => s.id === subsidiaryId)) ||
    (allowed ? pickerOptions[0] : root && pickerOptions.find((s) => s.id === root.id)) ||
    pickerOptions[0];
  if (!node) return { consolidated: false, options: pickerOptions };

  const subtree = subtreeIds(all, node.id);
  const members = all.filter(
    (s) => subtree.has(s.id) && (!allowed || allowed.has(s.id) || s.isElimination),
  );
  const nonElim = members.filter((s) => !s.isElimination);
  const consolidated = nonElim.length > 1;
  // Standalone leaf: just that entity. Consolidated: subtree + eliminations.
  const inView = consolidated ? members : [node];

  const foreign = [...new Set(inView.filter((s) => s.baseCurrency !== node.baseCurrency).map((s) => s.baseCurrency))];
  let rates: StatementSubsidiaryContext["rates"];
  if (consolidated && foreign.length > 0) {
    const r = (await db.execute(sql`
      select cf.from_currency as "from", cf.average_rate as avg, cf.current_rate as cur, cf.historical_rate as hist
        from consolidated_fx_rates cf
        join accounting_periods p on p.id = cf.period_id
       where cf.to_currency = ${node.baseCurrency}
         and cf.from_currency = any(${`{${foreign.join(",")}}`}::text[])
         and p.starts_on <= ${periodTo} and p.ends_on >= ${periodTo}`)) as unknown as {
      rows: { from: string; avg: string; cur: string; hist: string }[];
    };
    const byCcy = new Map(r.rows.map((x) => [x.from, x]));
    const missing = foreign.filter((c) => !byCcy.has(c));
    if (missing.length > 0) {
      throw new MissingRatesError(
        `No consolidated exchange rates for ${missing.join(", ")} → ${node.baseCurrency} in the period ending ${periodTo}. Derive rates from period close first.`,
      );
    }
    rates = inView
      .filter((s) => s.baseCurrency !== node.baseCurrency)
      .map((s) => {
        const x = byCcy.get(s.baseCurrency)!;
        return {
          subsidiaryId: s.id,
          averageRate: Number(x.avg),
          currentRate: Number(x.cur),
          historicalRate: Number(x.hist),
        };
      });
  }

  return {
    subsidiary: { ids: inView.map((s) => s.id), rates },
    currency: node.baseCurrency,
    label: consolidated ? `${node.name} (consolidated)` : node.name,
    consolidated,
    options: pickerOptions,
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
  const user = await currentUser();
  const allowed = user && !user.isSuperAdmin ? await allowedSubsidiaryIds(user.id) : null;
  const view = await resolveSubsidiaryView(subsidiaryId, periodTo, allowed);
  const hasChildren = new Set(view.options.map((s) => s.parentId).filter(Boolean));
  const picker = view.options.map((s) => ({
    id: s.id,
    label: `${" ".repeat(s.depth)}${s.name}${hasChildren.has(s.id) ? " (consolidated)" : ""}`,
  }));
  return { ...view, picker };
}
