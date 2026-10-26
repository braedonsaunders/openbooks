import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { HistoricalTranslationEvidenceError } from "@openbooks/engine/journal/historical-translation-evidence";
import { currentUser } from "./auth";
import type { StatementSubsidiaryContext } from "./statement-matrix";
import {
  allowedSubsidiaryIds,
  subsidiaryOptions,
  subtreeIds,
  type SubsidiaryOption,
} from "./subsidiaries";
import { subsidiaryFeatureEnabled } from "./features";
import {
  ReportSubsidiarySelectionError,
  selectReportSubsidiary,
} from "./report-subsidiary-selection";

/**
 * Resolves a report's subsidiary picker value into the statement engine's
 * subsidiary context:
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
 * rates. The description carries the kernel's user-language
 * message verbatim (it names the pair and period); the code lets surfaces
 * render a localized banner with a derive link instead of throwing.
 */
export interface RatesBlockedNotice {
  code: "rates-not-derived";
  title: string;
  description: string;
  deriveLabel: string;
  deriveHref: string;
}

export interface HistoricalTranslationBlockedNotice {
  code: "historical-evidence-required";
  title: string;
  description: string;
  actionLabel: string;
  actionHref: string;
}

export type StatementTranslationBlockedNotice =
  RatesBlockedNotice | HistoricalTranslationBlockedNotice;

export function historicalTranslationBlockedNotice(
  error: unknown,
  copy: { title: string; actionLabel: string },
): HistoricalTranslationBlockedNotice | null {
  if (!(error instanceof HistoricalTranslationEvidenceError)) return null;
  const entryId = error.sourceEntryId;
  return {
    code: "historical-evidence-required",
    title: copy.title,
    description: error.message,
    actionLabel: copy.actionLabel,
    actionHref: entryId ? `/journal?journalEntry=${encodeURIComponent(entryId)}` : "/journal",
  };
}

export function statementTranslationBlockedAction(
  notice: StatementTranslationBlockedNotice | null,
): { href: string; label: string } {
  if (!notice) return { href: "/close", label: "" };
  return notice.code === "historical-evidence-required"
    ? { href: notice.actionHref, label: notice.actionLabel }
    : { href: notice.deriveHref, label: notice.deriveLabel };
}

/**
 * Multi-currency refusal (ReportCurrencyBasisError): the viewed set spans
 * more than one functional currency, so no single-currency figure can be
 * stated. The description carries the kernel message verbatim (it names the
 * remedy: choose a single-currency subsidiary view). Unlike the rates
 * refusal there is no derive link — the subsidiary picker beside the banner
 * IS the remedy, so views rendering this must offer that choice.
 */
export interface CurrencyBasisNotice {
  code: "multi-currency-basis";
  title: string;
  description: string;
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
  /**
   * The node's bare name, without the consolidated qualifier — presenters
   * render the qualifier through the catalog off `consolidated` instead of
   * shipping English inside `label`.
   */
  nodeName?: string;
  consolidated: boolean;
  /** Options for the filter-bar picker (elimination subs excluded). */
  options: SubsidiaryOption[];
}

/**
 * Scope resolution that never refuses on underived consolidated rates
 * Operational cockpits (banking overview) translate at dated
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

/**
 * The currency an accounting book carries each subsidiary in. A secondary
 * book may carry a subsidiary in its own base currency; statements for that
 * book present and translate from that currency, never the functional one.
 * Null for the primary book (every subsidiary in its functional currency).
 */
async function bookMeasurementCurrencies(
  bookId: string | null | undefined,
  subsidiaryIds: readonly string[],
): Promise<Map<string, string> | null> {
  if (!bookId || subsidiaryIds.length === 0) return null;
  const rows = await db.execute<{ id: string; currency: string | null; is_primary: boolean }>(
    sql`
    select s.id, public.accounting_book_currency(s.org_id, b.id, s.id) as currency, b.is_primary
      from subsidiaries s
      join accounting_books b on b.org_id = s.org_id and b.id = ${bookId}
     where s.id = any(${`{${subsidiaryIds.join(",")}}`}::uuid[])`,
    "objects",
  );
  if (rows.length === 0 || rows[0]!.is_primary) return null;
  return new Map(rows.flatMap((row) => (row.currency ? [[row.id, row.currency] as const] : [])));
}

export async function resolveSubsidiaryScope(
  subsidiaryId: string | undefined,
  periodTo: string,
  allowed: Set<string> | null = null,
  bookId?: string | null,
): Promise<ResolvedSubsidiaryScope> {
  const listed = await subsidiaryOptions(false, true);
  const bookCurrencies = await bookMeasurementCurrencies(
    bookId,
    listed.map((s) => s.id),
  );
  const all = bookCurrencies
    ? listed.map((s) => ({ ...s, baseCurrency: bookCurrencies.get(s.id) ?? s.baseCurrency }))
    : listed;
  const { options: pickerOptions, node } = selectReportSubsidiary(subsidiaryId, all, allowed);
  if (
    subsidiaryId === undefined &&
    allowed === null &&
    all.filter((s) => !s.isElimination).length <= 1
  ) {
    // A single-entity organization presents in the book's currency for it.
    const only = all.find((s) => !s.isElimination);
    const listedOnly = listed.find((s) => s.id === only?.id);
    return {
      consolidated: false,
      options: [],
      ratesError: null,
      ...(only && listedOnly && only.baseCurrency !== listedOnly.baseCurrency
        ? { currency: only.baseCurrency }
        : {}),
    };
  }

  const root = all.find((s) => s.parentId === null);
  if (!node)
    return {
      consolidated: false,
      options: pickerOptions,
      subsidiary: { ids: [], includeNullSubsidiary: false },
      ratesError: null,
    };

  const subtree = subtreeIds(all, node.id);
  const members = all.filter((s) => subtree.has(s.id) && (!allowed || allowed.has(s.id)));
  const nonElim = members.filter((s) => !s.isElimination);
  const consolidated = nonElim.length > 1;
  // Standalone leaf: just that entity. Consolidated: subtree + eliminations.
  let inView = consolidated ? members : [node];
  let weights: StatementSubsidiaryContext["weights"];
  let controlLosses: StatementSubsidiaryContext["controlLosses"];
  if (consolidated) {
    const losses = await db.execute<{
      subsidiary_id: string;
      effective_on: string;
      excluded_subsidiary_ids: string[];
      measurement: {
        closingRates: { subsidiaryId: string; rate: string }[];
        factors: Record<string, string>;
      };
    }>(
      sql`select subsidiary_id,effective_on::text,excluded_subsidiary_ids,measurement from consolidation_control_losses where reversed_by_change_id is null and parent_subsidiary_id in(select jsonb_array_elements_text(${JSON.stringify(members.map((m) => m.id))}::jsonb)::uuid) order by effective_on`,
      "objects",
    );
    controlLosses = losses.flatMap((l) =>
      l.excluded_subsidiary_ids
        .filter((id) => members.some((m) => m.id === id))
        .map((subsidiaryId) => ({
          subsidiaryId,
          through: l.effective_on,
          closingRate: l.measurement.closingRates.find((r) => r.subsidiaryId === subsidiaryId)!
            .rate,
          factor: l.measurement.factors[subsidiaryId] ?? "0",
        })),
    );
  }
  if (consolidated) {
    const ownership = await db.execute<{ id: string; factor: string }>(
      sql`
      with recursive ownership_scope as (
        select s.id, s.org_id, 1::numeric as factor
          from subsidiaries s where s.id=${node.id}
        union all
        select child.id, parent.org_id,
               parent.factor * case
                 when exists(select 1 from consolidation_control_losses loss where loss.org_id=child.org_id and loss.reversed_by_change_id is null and loss.subsidiary_id=child.id and loss.effective_on<${periodTo}) then 1::numeric
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
    `,
      "objects",
    );
    const factorById = new Map(ownership.map((row) => [row.id, row.factor]));
    for (const loss of controlLosses ?? [])
      if (loss.through <= periodTo) factorById.set(loss.subsidiaryId, loss.factor);
    inView = inView.filter((member) => factorById.get(member.id) !== "0");
    weights = inView
      .map((member) => ({
        subsidiaryId: member.id,
        factor: factorById.get(member.id) ?? "1",
      }))
      .filter((weight) => weight.factor !== "1");
  }

  const foreign = [
    ...new Set(
      inView.filter((s) => s.baseCurrency !== node.baseCurrency).map((s) => s.baseCurrency),
    ),
  ];
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
    const scope = await db.execute<{ org_id: string }>(
      sql`
      select org_id from subsidiaries where id = ${node.id}`,
      "objects",
    );
    if (!scope[0])
      throw new Error(`subsidiary ${node.id} not found while resolving consolidated rates`);
    const r = await db.execute<{
      from: string;
      pFrom: string;
      pTo: string;
      avg: string;
      cur: string;
      hist: string;
    }>(sql`
      select cf.from_currency as "from", p.starts_on as "pFrom", p.ends_on as "pTo",
             cf.average_rate as "avg", cf.current_rate as "cur", cf.historical_rate as "hist"
        from consolidated_fx_rates cf
        join accounting_periods p on p.id = cf.period_id and p.org_id = cf.org_id
       where cf.org_id = ${scope[0].org_id} and p.org_id = ${scope[0].org_id}
         and cf.to_currency = ${node.baseCurrency}
         and cf.from_currency = any(${`{${foreign.join(",")}}`}::text[])
         and p.starts_on <= ${periodTo}
         and not p.is_adjustment
       order by p.ends_on`);
    const byCcy = new Map<string, typeof r.rows>();
    for (const row of r.rows) {
      const list = byCcy.get(row.from);
      if (list) list.push(row);
      else byCcy.set(row.from, [row]);
    }
    const missing = foreign.filter((currency) =>
      inView.some((entity) => {
        if (entity.baseCurrency !== currency) return false;
        const loss = controlLosses?.find((value) => value.subsidiaryId === entity.id);
        const through = loss && loss.through < periodTo ? loss.through : periodTo;
        return !(byCcy.get(currency) ?? []).some(
          (row) => row.pFrom <= through && through <= row.pTo,
        );
      }),
    );
    // Never throw here: the refusal rides along for the caller to convert
    // into a banner or throw (formal statements).
    if (missing.length > 0) {
      ratesError = new MissingRatesError(
        `No consolidated exchange rates for ${missing.join(", ")} → ${node.baseCurrency} in the period ending ${periodTo}. Derive rates from period close first.`,
      );
    }
    if (!ratesError) {
      rates = inView
        .filter((s) => s.baseCurrency !== node.baseCurrency)
        .flatMap((s) =>
          (byCcy.get(s.baseCurrency) ?? []).map((row) => ({
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
    subsidiary: {
      ids: inView.map((s) => s.id),
      ...(consolidated ? { presentationCurrency: node.baseCurrency } : {}),
      rates,
      weights,
      controlLosses,
      includeNullSubsidiary,
    },
    currency: node.baseCurrency,
    label: consolidated ? `${node.name} (consolidated)` : node.name,
    nodeName: node.name,
    consolidated,
    options: pickerOptions,
    ratesError,
  };
}

export async function resolveSubsidiaryView(
  subsidiaryId: string | undefined,
  periodTo: string,
  allowed: Set<string> | null = null,
  bookId?: string | null,
): Promise<ResolvedSubsidiaryView> {
  const scoped = await resolveSubsidiaryScope(subsidiaryId, periodTo, allowed, bookId);
  if (scoped.ratesError) throw scoped.ratesError;
  return {
    subsidiary: scoped.subsidiary,
    currency: scoped.currency,
    label: scoped.label,
    nodeName: scoped.nodeName,
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
  /** The statement's accounting book: a secondary book presents in its own currency per subsidiary. */
  bookId?: string | null,
): Promise<ResolvedSubsidiaryView & { picker: { id: string; label: string }[] }> {
  const scoped = await reportSubsidiaryScope(subsidiaryId, periodTo, bookId);
  if (scoped.ratesError) throw scoped.ratesError;
  return {
    subsidiary: scoped.subsidiary,
    currency: scoped.currency,
    label: scoped.label,
    nodeName: scoped.nodeName,
    consolidated: scoped.consolidated,
    options: scoped.options,
    picker: scoped.picker,
  };
}

/**
 * Scope bundle that never refuses on underived consolidated rates
 * Same visibility, context, and picker rows as
 * `reportSubsidiaryView`, with the would-be refusal as `ratesError`.
 * Operational cockpits read their scope and figures through this and pin
 * the banner beside live numbers; formal statements keep throwing via
 * `reportSubsidiaryView`.
 */
export async function reportSubsidiaryScope(
  subsidiaryId: string | undefined,
  periodTo: string,
  bookId?: string | null,
): Promise<ResolvedSubsidiaryScope & { picker: { id: string; label: string }[] }> {
  const user = await currentUser();
  const subsidiaryUiEnabled = Boolean(user && (await subsidiaryFeatureEnabled(user.orgId)));
  const allowed = user
    ? user.isSuperAdmin
      ? null
      : await allowedSubsidiaryIds(user.id, user.orgId)
    : new Set<string>();
  if (!subsidiaryUiEnabled && allowed === null && subsidiaryId === undefined) {
    // One entity: a secondary book may still present it in its own currency.
    const single = bookId ? await resolveSubsidiaryScope(undefined, periodTo, null, bookId) : null;
    return {
      consolidated: false,
      options: [],
      picker: [],
      ratesError: null,
      ...(single && !single.consolidated && single.currency ? { currency: single.currency } : {}),
    };
  }
  let view: ResolvedSubsidiaryScope;
  try {
    view = await resolveSubsidiaryScope(subsidiaryId, periodTo, allowed, bookId);
  } catch (error) {
    // Loaded on the refusal path only: this module also serves non-route
    // readers that run outside Next's request runtime.
    if (error instanceof ReportSubsidiarySelectionError)
      (await import("next/navigation")).notFound();
    throw error;
  }
  if (!subsidiaryUiEnabled) return { ...view, picker: [] };
  const hasChildren = new Set(view.options.map((s) => s.parentId).filter(Boolean));
  const picker = view.options.map((s) => ({
    id: s.id,
    label: `${" ".repeat(s.depth)}${s.name}${hasChildren.has(s.id) ? " (consolidated)" : ""}`,
  }));
  return { ...view, picker };
}
