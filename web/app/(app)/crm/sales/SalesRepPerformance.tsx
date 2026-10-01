"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Select } from "@openbooks/ui";
import { TrendingUp, Receipt, Target } from "lucide-react";
import { add } from "@openbooks/engine/money";
import type {
  SalesRepTrend,
  SalesMetric,
} from "@openbooks/engine/crm/sales/contracts";
import { MoneyProvider, useMoney } from "@/components/money-provider";
import { useViewerFormat } from "@/lib/viewer-format";
import { toChartNumber } from "@/lib/chart-number";
import { Panel } from "../../analytics/_ui/Panel";
import { KpiCard } from "../../analytics/_ui/KpiCard";

const TrendChart = dynamic(
  () => import("../../analytics/_ui/charts").then((m) => m.TrendChart),
  { ssr: false },
);

export function SalesRepPerformance({
  trend,
  reportHref,
}: {
  trend: SalesRepTrend;
  reportHref: string;
}) {
  const t = useTranslations("crm.sales");
  const currencies = [
    ...new Set(trend.points.map((point) => point.currency)),
  ].sort();
  const [currency, setCurrency] = useState(currencies[0] ?? "");
  return (
    <Panel
      title={t("salesOverTime")}
      icon={TrendingUp}
      actions={
        currencies.length ? (
          <Select
            aria-label={t("currency")}
            value={currency}
            onChange={(event) => setCurrency(event.target.value)}
          >
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </Select>
        ) : undefined
      }
    >
      {currency ? (
        <MoneyProvider currency={currency}>
          <PerformanceChart trend={trend} currency={currency} />
        </MoneyProvider>
      ) : (
        <p className="py-8 text-center text-sm text-slate-500">
          {t("noSalesHistory")}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span>{t("salesTrendBasis")}</span>
        <Link
          href={reportHref}
          className="font-medium text-teal-700 dark:text-teal-300"
        >
          {t("reviewEvidence")} →
        </Link>
      </div>
    </Panel>
  );
}

function PerformanceChart({
  trend,
  currency,
}: {
  trend: SalesRepTrend;
  currency: string;
}) {
  const t = useTranslations("crm.sales");
  const { money } = useMoney();
  const { date } = useViewerFormat();
  const points = trend.points.filter((point) => point.currency === currency);
  const metrics: SalesMetric[] = ["closed_won", "net_invoiced"];
  const total = (metric: SalesMetric) =>
    points
      .filter((point) => point.metric === metric)
      .reduce((sum, point) => add(sum, point.amount), "0");
  const series = metrics.map((metric) => ({
    name: t(metric),
    data: trend.months.map((month) =>
      toChartNumber(
        points.find((point) => point.month === month && point.metric === metric)
          ?.amount ?? "0",
      ),
    ),
  }));
  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <KpiCard
          label={t("closed_won")}
          value={money(total("closed_won"))}
          icon={Target}
          accent="teal"
        />
        <KpiCard
          label={t("net_invoiced")}
          value={money(total("net_invoiced"))}
          icon={Receipt}
          accent="violet"
        />
      </div>
      <TrendChart
        labels={trend.months.map((month) =>
          date(month, { month: "short", year: "2-digit" }),
        )}
        series={series}
        height={240}
        area
        maxTicks={6}
      />
    </>
  );
}
