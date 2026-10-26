import { sql } from "drizzle-orm";
import {
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
  acquireOrgFeatureGateLock,
} from "../../organization/org-feature-lock.ts";
import { db, withBypassContext, withOrgContext, withOrgTransaction } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import { CLOSED_PERIOD_REMEDY, FEATURES_REMEDY } from "./metrics-ledger-definitions.ts";
import type {
  SaasMetricsRecomputeResult,
  SaasMetricsScanTargets,
} from "./metrics-ledger-definitions.ts";
import {
  monthCloseState,
  monthFromOrdinal,
  monthOrdinal,
  monthStartForDate,
  refusal,
} from "./metrics-ledger-calculation.ts";
import type { SubsidiaryRow } from "./metrics-ledger-calculation.ts";
import {
  computeNormalizedMetricsMonth,
  writeNormalizedMetricsMonth,
} from "./metrics-ledger-month-writing.ts";

export async function recomputeSaasMetrics(
  orgId: string,
  month: string,
): Promise<SaasMetricsRecomputeResult> {
  if (!/^\d{4}-\d{2}-01$/.test(month)) {
    throw refusal(
      "saas_metrics_month_invalid",
      `Metrics month "${month}" must be the first day of a calendar month.`,
      "Supply the month as YYYY-MM-01.",
      { field: "month" },
    );
  }
  return withOrgTransaction(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "saasMetrics"))) {
      throw refusal(
        "feature_off",
        "SaaS metrics are disabled for this organization.",
        FEATURES_REMEDY,
      );
    }
    const normalized = await computeNormalizedMetricsMonth(db, orgId, month);
    const closeState = await monthCloseState(db, orgId, month, normalized.subsidiaryIds);
    const storedState = (
      await db.execute<{ row_count: number; changed: boolean }>(
        sql`
      select count(*)::int as row_count, coalesce(bool_or(inputs_hash <> ${normalized.monthHash}), false) as changed
        from (
          select inputs_hash from saas_metrics_facts_monthly where org_id = ${orgId} and month = ${month}::date
          union all
          select inputs_hash from saas_metrics_monthly where org_id = ${orgId} and month = ${month}::date
          union all
          select inputs_hash from saas_metrics_cohort_monthly where org_id = ${orgId} and month = ${month}::date
        ) stored
    `,
        "objects",
      )
    )[0]!;
    if (!closeState.open && storedState.row_count > 0 && storedState.changed) {
      throw refusal(
        "saas_metrics_closed_month_changed",
        `SaaS metrics for closed AR month ${month} have changed inputs and remain frozen.`,
        CLOSED_PERIOD_REMEDY,
        { status: 409 },
      );
    }
    if (!closeState.open && storedState.row_count > 0) {
      return {
        orgId,
        month,
        subscriptionRows: normalized.computed.rows.length,
        subsidiaryRows: normalized.facts.length,
        frozen: true,
      };
    }
    const written = await writeNormalizedMetricsMonth(db, orgId, normalized);
    return {
      orgId,
      month,
      subscriptionRows: written.subscriptionRows,
      subsidiaryRows: written.subsidiaryRows,
      frozen: !closeState.open,
    };
  });
}

export interface SaasMetricsMonth {
  month: string;
  computedAt: string;
  frozen: boolean;
}

/** Read the recorded facts and their period-close state for the metrics API. */
export async function listSaasMetricsMonths(orgId: string): Promise<SaasMetricsMonth[]> {
  if (!(await orgFeatureEnabled(orgId, "saasMetrics"))) {
    throw refusal(
      "feature_off",
      "SaaS metrics are disabled for this organization.",
      FEATURES_REMEDY,
    );
  }
  return withOrgTransaction(orgId, async () => {
    const rows = await db.execute<{ month: string; computedAt: string }>(
      sql`
      select month, max(computed_at)::text as "computedAt"
        from (
          select month::text as month, computed_at from saas_metrics_monthly where org_id = ${orgId}
          union all
          select month::text as month, computed_at from saas_metrics_facts_monthly where org_id = ${orgId}
          union all
          select month::text as month, computed_at from saas_metrics_cohort_monthly where org_id = ${orgId}
        ) facts
       group by month order by month desc`,
      "objects",
    );
    const subsidiaries = await db.execute<SubsidiaryRow>(
      sql`
      select id, base_currency from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by id`,
      "objects",
    );
    const result: SaasMetricsMonth[] = [];
    for (const row of rows) {
      const close = await monthCloseState(
        db,
        orgId,
        row.month,
        subsidiaries.map((subsidiary) => subsidiary.id),
      );
      result.push({ month: row.month, computedAt: row.computedAt, frozen: !close.open });
    }
    return result;
  });
}

export async function saasMetricsScanTargets(): Promise<SaasMetricsScanTargets> {
  // bypass: scheduler-tick — the metrics pass lists every organization before checking each one's feature gate.
  const orgIds = await withBypassContext(async () =>
    (await db.execute<{ id: string }>(sql`select id from orgs order by id`, "objects")).map(
      (row) => row.id,
    ),
  );
  const enabledOrgIds: string[] = [];
  const skippedFeatureOffOrgIds: string[] = [];
  for (const orgId of orgIds) {
    if (await withOrgContext(orgId, () => orgFeatureEnabled(orgId, "saasMetrics", db)))
      enabledOrgIds.push(orgId);
    else skippedFeatureOffOrgIds.push(orgId);
  }
  return { enabledOrgIds, skippedFeatureOffOrgIds };
}

async function monthIsOpenForAr(orgId: string, month: string): Promise<boolean> {
  return withOrgTransaction(orgId, async () => {
    const subsidiaries = await db.execute<SubsidiaryRow>(
      sql`
      select id, base_currency from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by id
    `,
      "objects",
    );
    return (
      await monthCloseState(
        db,
        orgId,
        month,
        subsidiaries.map((row) => row.id),
      )
    ).open;
  });
}

async function monthHasStoredMetrics(orgId: string, month: string): Promise<boolean> {
  return withOrgTransaction(orgId, async () => {
    const result = await db.execute<{ has_rows: boolean }>(
      sql`
      select exists (
        select 1 from saas_metrics_monthly where org_id = ${orgId} and month = ${month}::date
        union all
        select 1 from saas_metrics_facts_monthly where org_id = ${orgId} and month = ${month}::date
        union all
        select 1 from saas_metrics_cohort_monthly where org_id = ${orgId} and month = ${month}::date
      ) as has_rows
    `,
      "objects",
    );
    return result[0]!.has_rows;
  });
}

export async function recomputeOpenSaasMetrics(orgId: string): Promise<{
  recomputed: SaasMetricsRecomputeResult[];
  skippedClosedMonths: string[];
}> {
  if (!(await orgFeatureEnabled(orgId, "saasMetrics"))) {
    throw refusal(
      "feature_off",
      "SaaS metrics are disabled for this organization.",
      FEATURES_REMEDY,
    );
  }
  const today = await businessToday(orgId);
  const currentMonth = monthStartForDate(today);
  const { existingMonths, firstSubscriptionMonth } = await withOrgTransaction(orgId, async () => {
    const existingMonths = (
      await db.execute<{ month: string }>(
        sql`
      select distinct month::text from saas_metrics_facts_monthly
       where org_id = ${orgId} and month <= ${currentMonth}::date order by month
    `,
        "objects",
      )
    ).map((row) => row.month.slice(0, 10));
    const firstSubscriptionMonth =
      (
        await db.execute<{ month: string | null }>(
          sql`
      select date_trunc('month', min(start_on))::date::text as month
        from subscriptions where org_id = ${orgId}
    `,
          "objects",
        )
      )[0]?.month?.slice(0, 10) ?? null;
    return { existingMonths, firstSubscriptionMonth };
  });
  const generatedMonths =
    firstSubscriptionMonth === null
      ? []
      : Array.from(
          {
            length: Math.max(
              0,
              monthOrdinal(currentMonth) - monthOrdinal(firstSubscriptionMonth) + 1,
            ),
          },
          (_, index) => monthFromOrdinal(monthOrdinal(firstSubscriptionMonth) + index),
        );
  const months = [...new Set([...generatedMonths, ...existingMonths, currentMonth])].sort();
  const recomputed: SaasMetricsRecomputeResult[] = [];
  const skippedClosedMonths: string[] = [];
  for (const month of months) {
    if (!(await monthIsOpenForAr(orgId, month))) {
      if (await monthHasStoredMetrics(orgId, month)) {
        skippedClosedMonths.push(month);
      } else {
        // Closed periods receive one initial derived snapshot; later scans
        // leave that frozen result alone.
        recomputed.push(await recomputeSaasMetrics(orgId, month));
      }
      continue;
    }
    recomputed.push(await recomputeSaasMetrics(orgId, month));
  }
  return { recomputed, skippedClosedMonths };
}
