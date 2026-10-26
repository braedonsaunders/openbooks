"use client";

import dynamic from "next/dynamic";
import { cn } from "@openbooks/ui";
import { useMoney } from "@/components/money-provider";
import { useViewerFormat } from "@/lib/viewer-format";

/**
 * Data-only presentation widgets for authored pages and native app screens.
 *
 * Every prop is plain JSON a loader or an app data endpoint can produce:
 * labels, numbers, names, palette keys. No widget here reads tenant data on
 * its own, so placing one discloses nothing beyond the values it is handed.
 * They reuse the analytics chart kit, so an authored screen reads as the same
 * product as the native dashboards.
 */

const GroupedBar = dynamic(() =>
  import("../../app/(app)/analytics/_ui/charts").then((module) => module.GroupedBar),
);
const Donut = dynamic(() =>
  import("../../app/(app)/analytics/_ui/charts").then((module) => module.Donut),
);
const Gauge = dynamic(() =>
  import("../../app/(app)/analytics/_ui/Gauge").then((module) => module.Gauge),
);

export type ValueFormat = "money" | "count" | "percent";

function useValueFormatter(format: ValueFormat): (value: number) => string {
  const { money } = useMoney();
  const { number } = useViewerFormat();
  if (format === "money") return (value) => money(String(value));
  if (format === "percent") return (value) => `${number(value)}%`;
  return (value) => number(value);
}

export function BarChartWidget({
  labels,
  series,
  height,
}: {
  labels: string[];
  series: { name: string; data: number[]; color?: string }[];
  height?: number;
}) {
  return <GroupedBar labels={labels} series={series} height={height ?? 240} />;
}

export function DonutChartWidget({
  data,
  height,
  format,
}: {
  data: { name: string; value: number }[];
  height?: number;
  format: ValueFormat;
}) {
  const formatValue = useValueFormatter(format);
  return <Donut data={data} height={height ?? 220} valueFormat={formatValue} />;
}

export function ScoreGaugeWidget({
  value,
  label,
  bands,
  goodWhenHigh,
  size,
}: {
  value: number;
  label?: string;
  bands: { excellent: number; good: number; average: number } | null;
  goodWhenHigh?: boolean;
  size?: number;
}) {
  return (
    <div className="flex justify-center">
      <Gauge
        value={value}
        label={label}
        bands={bands}
        goodWhenHigh={goodWhenHigh ?? true}
        size={size ?? 200}
      />
    </div>
  );
}

const BAR_TONE = {
  default: "bg-teal-500",
  positive: "bg-emerald-500",
  warning: "bg-amber-500",
  negative: "bg-red-500",
  muted: "bg-slate-400",
} as const;

export type ProgressItem = {
  label: string;
  value: number;
  max?: number;
  tone?: keyof typeof BAR_TONE;
  detail?: string;
};

/** Labelled horizontal bars: share of a total, or progress toward each item's own max. */
export function ProgressBarsWidget({
  items,
  format,
}: {
  items: ProgressItem[];
  format: ValueFormat;
}) {
  const formatValue = useValueFormatter(format);
  const largest = Math.max(1, ...items.map((item) => item.max ?? item.value));
  return (
    <div className="space-y-3">
      {items.map((item) => {
        const denominator = item.max ?? largest;
        const width =
          denominator > 0 ? Math.min(100, Math.max(0, (item.value / denominator) * 100)) : 0;
        return (
          <div key={item.label}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate text-slate-600 dark:text-slate-300">{item.label}</span>
              <span className="shrink-0 tabular-nums text-slate-900 dark:text-slate-100">
                {formatValue(item.value)}
                {item.detail ? (
                  <span className="ml-1 text-slate-400 dark:text-slate-500">{item.detail}</span>
                ) : null}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className={cn("h-full rounded-full", BAR_TONE[item.tone ?? "default"])}
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
