import { sql } from "drizzle-orm";
import { orgFeatureEnabled } from "../../organization/org-feature-lock.ts";
import { db, withOrgTransaction } from "../../platform/db.ts";
import {
  BUILT_IN_REPORT_DEFINITION_MAP,
  evaluateFormulaMeasures,
  type ReportMeasure,
} from "@openbooks/reports";
import { FEATURES_REMEDY } from "./metrics-ledger-definitions.ts";
import { refusal } from "./metrics-ledger-calculation.ts";

export interface RetentionStripRow {
  currency: string;
  values: Record<string, string | null>;
  undefinedReasons: Array<string | null>;
}

export interface RetentionStrip {
  month: string | null;
  baseCurrency: string | null;
  rows: RetentionStripRow[];
}

const RETENTION_STRIP_SLUGS = [
  "mrr-movements",
  "arr-summary",
  "nrr-grr",
  "revenue-churn",
  "arpa-ltv",
] as const;

/** Formula keys the retention strip renders, in fixed positional order. */
export const RETENTION_STRIP_KEYS = [
  "arr",
  "nrr",
  "grr",
  "revenue_churn",
  "logo_churn",
  "arpa",
  "quick_ratio",
] as const;

function retentionStripMeasures(): { base: ReportMeasure[]; formulas: ReportMeasure[] } {
  // The report engine owns these definitions; the strip evaluates the same
  // abstract syntax trees over the same stored facts, so the dashboard can
  // never disagree with the Reports hub. Ratios are never stored.
  const definitions = BUILT_IN_REPORT_DEFINITION_MAP;
  const base = new Map<string, ReportMeasure>();
  const formulas: ReportMeasure[] = [];
  for (const slug of RETENTION_STRIP_SLUGS) {
    const definition = definitions[slug];
    if (!definition) throw new Error(`built-in report ${slug} is not registered`);
    for (const measure of definition.query.measures ?? []) {
      if (measure.fn === "formula") {
        if (
          (RETENTION_STRIP_KEYS as readonly string[]).includes(measure.key ?? "") &&
          !formulas.some((m) => m.key === measure.key)
        ) {
          formulas.push(measure);
        }
      } else if (measure.key && !base.has(measure.key)) {
        base.set(measure.key, measure);
      }
    }
  }
  const ordered = new Map(formulas.map((measure) => [measure.key, measure]));
  return {
    base: [...base.values()],
    formulas: RETENTION_STRIP_KEYS.map((key) => ordered.get(key)).filter(
      (m): m is ReportMeasure => m !== undefined,
    ),
  };
}

/** Reads the latest stored recurring-revenue ratios by reporting currency; empty history returns no rows. */
export async function readRetentionStrip(orgId: string): Promise<RetentionStrip> {
  if (!(await orgFeatureEnabled(orgId, "saasMetrics"))) {
    throw refusal(
      "feature_off",
      "SaaS metrics are disabled for this organization.",
      FEATURES_REMEDY,
    );
  }
  return withOrgTransaction(orgId, async () => {
    const month =
      (
        await db.execute<{ month: string }>(
          sql`
      select month::text as month from saas_metrics_facts_monthly
       where org_id = ${orgId} group by month order by month desc limit 1`,
          "objects",
        )
      )[0]?.month ?? null;
    if (!month) return { month: null, baseCurrency: null, rows: [] };
    const baseCurrency =
      (
        await db.execute<{ baseCurrency: string }>(
          sql`
      select base_currency as "baseCurrency" from orgs where id = ${orgId}`,
          "objects",
        )
      )[0]?.baseCurrency ?? null;
    const { base, formulas } = retentionStripMeasures();
    const sums = (await db.execute<Record<string, string | null>>(
      sql`
      select reporting_currency as currency,
             sum(mrr_start)::text as mrr_start, sum(mrr_end)::text as mrr_end,
             sum(new_mrr)::text as new_mrr, sum(expansion_mrr)::text as expansion_mrr,
             sum(contraction_mrr)::text as contraction_mrr, sum(churned_mrr)::text as churned_mrr,
             sum(reactivation_mrr)::text as reactivation_mrr,
             sum(customers_start)::int::text as customers_start,
             sum(customers_end)::int::text as customers_end,
             sum(customers_churned)::int::text as customers_churned
        from saas_metrics_facts_monthly
       where org_id = ${orgId} and month = ${month}::date
       group by reporting_currency order by reporting_currency`,
      "objects",
    )) as Array<Record<string, string | null> & { currency: string }>;
    const ordered = [...sums].sort((a, b) =>
      a.currency === baseCurrency
        ? -1
        : b.currency === baseCurrency
          ? 1
          : a.currency.localeCompare(b.currency),
    );
    return {
      month,
      baseCurrency,
      rows: ordered.map((row) => {
        const measures = [...base, ...formulas];
        const aggregates = measures.map((measure) => {
          if (measure.fn === "formula") return null;
          return row[measure.column ?? measure.key ?? ""] ?? null;
        });
        const evaluated = evaluateFormulaMeasures(measures, aggregates);
        const values: Record<string, string | null> = {};
        const undefinedReasons: Array<string | null> = [];
        formulas.forEach((formula, index) => {
          const result = evaluated[base.length + index]!;
          if (formula.key === undefined)
            throw new Error("a retention strip formula is missing its key");
          values[formula.key] = result.value;
          undefinedReasons.push(result.undefinedLabel);
        });
        return { currency: row.currency, values, undefinedReasons };
      }),
    };
  });
}
