"use client";

import { useMemo } from "react";
import { useFormatter } from "next-intl";
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from "lucide-react";
import { cn } from "@openbooks/ui";
import { useMoney } from "@/components/money-provider";
import type {
  SpotlightFormat,
  SpotlightPanel,
  SpotlightSeries,
  SpotlightTone,
} from "../../../../lib/analytics/dashboard-catalog";
import { CHART_THEME, Chart, PALETTE, Waterfall, tickInterval, type ChartHeight } from "./charts";
import { Gauge } from "./Gauge";
import { escapeTooltipHtml, scoreTone } from "./format";

/**
 * Renders one spotlight panel — the projection an Analytics dashboard hands
 * the home-dashboard widget — through the analytics chart vocabulary. The
 * accent is the source dashboard's identity color; tones carry status.
 */

type EChartsOption = Record<string, unknown>;
type AxisParam = {
  axisValue?: string;
  marker?: string;
  seriesName?: string;
  value: unknown;
  dataIndex: number;
};

export const TONE_HEX: Record<SpotlightTone, string> = {
  positive: "#10b981",
  caution: "#f59e0b",
  negative: "#ef4444",
  neutral: "#64748b",
};
export const TONE_TEXT: Record<SpotlightTone, string> = {
  positive: "text-emerald-600 dark:text-emerald-400",
  caution: "text-amber-600 dark:text-amber-400",
  negative: "text-rose-600 dark:text-rose-400",
  neutral: "text-slate-500 dark:text-slate-400",
};

/** `#rrggbb` at an alpha, for gradients that fade into either theme. */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const vertical = (top: string, bottom: string) => ({
  type: "linear",
  x: 0,
  y: 0,
  x2: 0,
  y2: 1,
  colorStops: [
    { offset: 0, color: top },
    { offset: 1, color: bottom },
  ],
});

function roleColor(series: SpotlightSeries, index: number, accent: string): string {
  switch (series.role) {
    case "primary":
      return accent;
    case "secondary":
      return PALETTE[1]!;
    case "positive":
      return CHART_THEME.positive;
    case "negative":
      return CHART_THEME.negative;
    case "caution":
      return TONE_HEX.caution;
    case "muted":
      return "#94a3b8";
    default:
      return index === 0 ? accent : PALETTE[(index + 1) % PALETTE.length]!;
  }
}

/** Value text for a panel's format, in the viewer's locale and the payload currency. */
export function useSpotlightFormat() {
  const { money, moneyCompact } = useMoney();
  const format = useFormatter();
  return useMemo(() => {
    const percent = (value: number) =>
      format.number(value / 100, { style: "percent", maximumFractionDigits: 1 });
    const count = (value: number) => format.number(value, { maximumFractionDigits: 1 });
    return {
      full: (value: number, kind: SpotlightFormat) =>
        kind === "money"
          ? money(value, { maximumFractionDigits: 0 })
          : kind === "percent"
            ? percent(value)
            : count(value),
      axis: (value: number, kind: SpotlightFormat) =>
        kind === "money"
          ? moneyCompact(value, { maximumFractionDigits: 1 })
          : kind === "percent"
            ? percent(value)
            : format.number(value, { notation: "compact", maximumFractionDigits: 1 }),
    };
  }, [money, moneyCompact, format]);
}

function trendOption(
  panel: Extract<SpotlightPanel, { kind: "trend" }>,
  accent: string,
  fmt: ReturnType<typeof useSpotlightFormat>,
  compact: boolean,
): EChartsOption {
  const multi = panel.series.length > 1;
  const hasBars = panel.series.some((series) => series.style === "bar");
  // Categorical axes (detectors) show every label; time axes thin to a
  // data-fixed stride so the ticks never reshuffle as the card resizes.
  const categorical = panel.labels.length <= 8;
  return {
    animationDuration: 600,
    grid: {
      left: 2,
      right: 6,
      top: multi || panel.reference ? 28 : 10,
      bottom: 2,
      containLabel: true,
    },
    tooltip: {
      ...CHART_THEME.tooltip,
      axisPointer: {
        type: hasBars ? "shadow" : "line",
        lineStyle: { color: withAlpha(accent, 0.4) },
        shadowStyle: { color: withAlpha(accent, 0.06) },
      },
      formatter: (params: AxisParam[]) => {
        const rows = params.flatMap((param) => {
          const raw =
            typeof param.value === "object" && param.value !== null
              ? (param.value as { value?: unknown }).value
              : param.value;
          return typeof raw === "number"
            ? [
                `${param.marker} ${escapeTooltipHtml(param.seriesName)}: ${fmt.full(raw, panel.format)}`,
              ]
            : [];
        });
        return [escapeTooltipHtml(params[0]?.axisValue), ...rows].join("<br/>");
      },
    },
    legend: multi
      ? {
          top: 0,
          right: 0,
          icon: "roundRect",
          itemWidth: 10,
          itemHeight: 4,
          itemGap: 12,
          textStyle: { color: CHART_THEME.axis, fontSize: 10 },
        }
      : undefined,
    xAxis: {
      type: "category",
      data: panel.labels,
      boundaryGap: hasBars,
      axisLine: { lineStyle: { color: CHART_THEME.split } },
      axisTick: { show: false },
      axisLabel: {
        color: CHART_THEME.axis,
        fontSize: 10,
        hideOverlap: true,
        interval: categorical ? 0 : tickInterval(panel.labels.length, compact ? 4 : 8),
        ...(categorical ? { width: compact ? 56 : 84, overflow: "truncate" } : {}),
      },
    },
    yAxis: {
      type: "value",
      splitNumber: compact ? 3 : 4,
      axisLine: { show: false },
      splitLine: { lineStyle: { color: CHART_THEME.split, type: "dashed" } },
      axisLabel: {
        color: CHART_THEME.axis,
        fontSize: 10,
        formatter: (value: number) => fmt.axis(value, panel.format),
      },
    },
    series: panel.series.map((series, index) => {
      const color = roleColor(series, index, accent);
      const markLine =
        index === 0 && panel.reference
          ? {
              silent: true,
              symbol: "none",
              lineStyle: { type: "dashed", color: "#94a3b8", width: 1 },
              label: {
                formatter: `${panel.reference.label} ${fmt.full(panel.reference.value, panel.format)}`,
                color: CHART_THEME.axis,
                fontSize: 10,
                position: "insideEndTop",
              },
              data: [{ yAxis: panel.reference.value }],
            }
          : undefined;
      if (series.style === "bar") {
        return {
          type: "bar",
          name: series.name,
          barMaxWidth: compact ? 14 : 20,
          barCategoryGap: "38%",
          markLine,
          itemStyle: { color: vertical(color, withAlpha(color, 0.55)), borderRadius: [4, 4, 0, 0] },
          data:
            series.role === "signed"
              ? series.values.map((value) =>
                  value === null
                    ? null
                    : {
                        value,
                        itemStyle: {
                          color:
                            value < 0
                              ? vertical(
                                  withAlpha(CHART_THEME.negative, 0.55),
                                  CHART_THEME.negative,
                                )
                              : vertical(
                                  CHART_THEME.positive,
                                  withAlpha(CHART_THEME.positive, 0.55),
                                ),
                          borderRadius: value < 0 ? [0, 0, 4, 4] : [4, 4, 0, 0],
                        },
                      },
                )
              : series.values,
        };
      }
      return {
        type: "line",
        name: series.name,
        smooth: 0.35,
        showSymbol: false,
        symbol: "circle",
        symbolSize: 6,
        connectNulls: false,
        z: 3,
        markLine,
        lineStyle: {
          width: series.style === "dashed" ? 1.75 : 2.25,
          color,
          type: series.style === "dashed" ? "dashed" : "solid",
        },
        itemStyle: { color, borderColor: "#fff", borderWidth: 1.5 },
        areaStyle:
          series.style === "area"
            ? { color: vertical(withAlpha(color, 0.32), withAlpha(color, 0)) }
            : undefined,
        data: series.values,
      };
    }),
  };
}

function TrendPanel({
  panel,
  accent,
  height,
  compact,
}: {
  panel: Extract<SpotlightPanel, { kind: "trend" }>;
  accent: string;
  height: ChartHeight;
  compact: boolean;
}) {
  const fmt = useSpotlightFormat();
  const option = useMemo(
    () => trendOption(panel, accent, fmt, compact),
    [panel, accent, fmt, compact],
  );
  return <Chart option={option} height={height} />;
}

function DonutPanel({
  panel,
  accent,
  compact,
}: {
  panel: Extract<SpotlightPanel, { kind: "donut" }>;
  accent: string;
  compact: boolean;
}) {
  const format = useFormatter();
  const total = panel.slices.reduce((sum, slice) => sum + slice.value, 0);
  const palette = [accent, ...PALETTE.filter((color) => color !== accent)];
  const slices = panel.slices.map((slice, index) => ({
    ...slice,
    color: slice.color ?? (slice.tone ? TONE_HEX[slice.tone] : palette[index % palette.length]!),
  }));
  const option = useMemo<EChartsOption>(
    () => ({
      animationDuration: 600,
      tooltip: {
        trigger: "item",
        backgroundColor: CHART_THEME.tooltip.backgroundColor,
        borderWidth: 0,
        textStyle: CHART_THEME.tooltip.textStyle,
        formatter: (param: { name: string; dataIndex: number; percent: number }) =>
          `${escapeTooltipHtml(param.name)}: ${escapeTooltipHtml(slices[param.dataIndex]?.display)} (${format.number(param.percent / 100, { style: "percent", maximumFractionDigits: 1 })})`,
      },
      series: [
        {
          type: "pie",
          radius: ["64%", "90%"],
          center: ["50%", "50%"],
          padAngle: slices.length > 1 ? 2 : 0,
          avoidLabelOverlap: true,
          label: { show: false },
          itemStyle: { borderRadius: 5, borderColor: "transparent" },
          emphasis: { scale: true, scaleSize: 4 },
          data: slices.map((slice) => ({
            name: slice.name,
            value: slice.value,
            itemStyle: { color: slice.color },
          })),
        },
      ],
    }),
    [slices, format],
  );
  if (slices.length === 0) return <PanelEmpty>—</PanelEmpty>;
  const legend = [...slices].sort((a, b) => b.value - a.value).slice(0, compact ? 4 : 6);
  return (
    <div className="flex h-full min-h-0 items-center gap-4">
      <div className="relative aspect-square h-full max-h-56 min-h-28 shrink-0">
        <Chart option={option} height="fill" />
        {panel.center ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="max-w-[70%] truncate text-sm font-semibold tracking-tight text-slate-900 tabular-nums dark:text-white">
              {panel.center.value}
            </span>
            <span className="max-w-[70%] truncate text-[10px] text-slate-400">
              {panel.center.label}
            </span>
          </div>
        ) : null}
      </div>
      <ul className="min-w-0 flex-1 space-y-1.5">
        {legend.map((slice) => (
          <li key={slice.name} className="flex items-center gap-2 text-xs">
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: slice.color }}
            />
            <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300">
              {slice.name}
            </span>
            <span className="shrink-0 font-medium text-slate-900 tabular-nums dark:text-slate-100">
              {slice.display}
            </span>
            <span className="w-11 shrink-0 text-right text-[10px] text-slate-400 tabular-nums">
              {total > 0
                ? format.number(slice.value / total, { style: "percent", maximumFractionDigits: 0 })
                : "—"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function GaugePanel({ panel }: { panel: Extract<SpotlightPanel, { kind: "gauge" }> }) {
  const tone =
    panel.bands === null
      ? null
      : scoreTone(panel.goodWhenHigh ? panel.score : 100 - panel.score, panel.bands);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <div className="flex flex-col items-center">
        <Gauge
          value={panel.score}
          size={168}
          thickness={14}
          showTicks={false}
          showValue={false}
          goodWhenHigh={panel.goodWhenHigh}
          bands={panel.bands}
          ariaLabel={`${panel.title}: ${panel.display}`}
        />
        <div className="-mt-12 flex flex-col items-center">
          <span
            className={cn(
              "text-3xl font-bold tracking-tight tabular-nums",
              tone?.text ?? "text-slate-700 dark:text-slate-200",
            )}
          >
            {panel.display}
          </span>
          <span className="text-[10px] font-semibold tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
            {panel.caption}
          </span>
        </div>
      </div>
      {panel.breakdown?.length ? (
        <ul className="w-full space-y-1.5">
          {panel.breakdown.map((row) => {
            const rowTone =
              row.score === null || panel.bands === null ? null : scoreTone(row.score, panel.bands);
            return (
              <li key={row.label} className="flex items-center gap-2 text-xs">
                <span className="w-24 shrink-0 truncate text-slate-500 dark:text-slate-400">
                  {row.label}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.max(0, Math.min(100, row.score ?? 0))}%`,
                      backgroundColor: rowTone?.hex ?? "#94a3b8",
                    }}
                  />
                </span>
                <span className="w-8 shrink-0 text-right font-medium text-slate-700 tabular-nums dark:text-slate-200">
                  {row.score === null ? "—" : Math.round(row.score)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function RankingPanel({
  panel,
  accent,
}: {
  panel: Extract<SpotlightPanel, { kind: "ranking" }>;
  accent: string;
}) {
  if (panel.rows.length === 0) return <PanelEmpty>{panel.empty}</PanelEmpty>;
  return (
    <ol className="space-y-2.5">
      {panel.rows.map((row, index) => {
        const color = row.tone && row.tone !== "neutral" ? TONE_HEX[row.tone] : accent;
        return (
          <li key={`${row.name}-${index}`} className="min-w-0">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="w-4 shrink-0 text-[10px] font-semibold text-slate-400 tabular-nums">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-slate-700 dark:text-slate-200">
                {row.name}
              </span>
              {row.detail ? (
                <span className="hidden max-w-[40%] shrink truncate text-[10px] text-slate-400 sm:inline">
                  {row.detail}
                </span>
              ) : null}
              <span className="shrink-0 font-semibold text-slate-900 tabular-nums dark:text-white">
                {row.value}
              </span>
            </div>
            <div className="mt-1 ml-6 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
              <div
                className="h-full rounded-full transition-[width] duration-700"
                style={{
                  width: `${Math.max(2, row.share * 100)}%`,
                  background: `linear-gradient(90deg, ${withAlpha(color, 0.55)}, ${color})`,
                }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

const INSIGHT_ICON: Record<SpotlightTone, typeof Info> = {
  negative: OctagonAlert,
  caution: AlertTriangle,
  positive: CheckCircle2,
  neutral: Info,
};

function InsightsPanel({ panel }: { panel: Extract<SpotlightPanel, { kind: "insights" }> }) {
  if (panel.items.length === 0) return <PanelEmpty>{panel.empty}</PanelEmpty>;
  return (
    <ul className="space-y-2">
      {panel.items.map((item, index) => {
        const Icon = INSIGHT_ICON[item.tone];
        return (
          <li
            key={`${item.title}-${index}`}
            className="flex gap-2.5 rounded-lg px-2.5 py-2"
            style={{ backgroundColor: withAlpha(TONE_HEX[item.tone], 0.07) }}
          >
            <Icon size={14} className={cn("mt-0.5 shrink-0", TONE_TEXT[item.tone])} />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                {item.title}
              </p>
              {item.detail ? (
                <p className="mt-0.5 text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                  {item.detail}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PanelEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-24 items-center justify-center px-4 text-center text-xs text-slate-400">
      {children}
    </div>
  );
}

/**
 * One panel body. `height` sizes chart canvases ('fill' inside a sized
 * card body); list panels size to their rows.
 */
export function SpotlightPanelBody({
  panel,
  accent,
  height,
  compact = false,
}: {
  panel: SpotlightPanel;
  accent: string;
  height: ChartHeight;
  compact?: boolean;
}) {
  switch (panel.kind) {
    case "trend":
      return <TrendPanel panel={panel} accent={accent} height={height} compact={compact} />;
    case "donut":
      return (
        <div style={height === "fill" ? { height: "100%" } : { height }}>
          <DonutPanel panel={panel} accent={accent} compact={compact} />
        </div>
      );
    case "gauge":
      return <GaugePanel panel={panel} />;
    case "ranking":
      return <RankingPanel panel={panel} accent={accent} />;
    case "bridge":
      return (
        <Waterfall
          steps={panel.steps.map((step) => ({
            ...step,
            ...(step.tone
              ? { color: TONE_HEX[step.tone] }
              : step.kind === "total" || step.kind === "start"
                ? { color: accent }
                : {}),
          }))}
          height={typeof height === "number" ? height : 220}
        />
      );
    case "insights":
      return <InsightsPanel panel={panel} />;
  }
}
