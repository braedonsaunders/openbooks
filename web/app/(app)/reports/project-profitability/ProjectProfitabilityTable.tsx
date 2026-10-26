"use client";

import { Fragment, useEffect, useState } from "react";
import { useFormatter } from "next-intl";
import { useMoney } from "@/components/money-provider";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@openbooks/ui";
import {
  decimalToNumber,
  isNegative,
  marginRatioToPercent,
} from "../../../../lib/statement-format";
import type { ExactDecimal } from "../../../../lib/statement-format";
import type { ReportDrillTarget } from "../../../../lib/report-drill";
import { ReportDrillLink } from "../ReportDrillLink";
import { profitDrillTargets, type ProfitDrillBase, type ProfitDrillScope } from "./drills";
import { ReportPaper } from "../ReportPaper";
import {
  REPORT_SECTION_VISIBILITY_EVENT,
  type ReportSectionVisibility,
} from "../report-section-events";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  reportSubtotalRowClass,
  reportTotalRowClass,
} from "../ReportTable";

type Values = {
  revenue: ExactDecimal;
  cogs: ExactDecimal;
  grossProfit: ExactDecimal;
  expenses: ExactDecimal;
  net: ExactDecimal;
  margin: ExactDecimal | null;
  hours: number;
};

/** The row's drill scope; null for rows that cannot drill. */
type DrillScope = ProfitDrillScope | null;

export type ProjectProfitabilityGroup = {
  key: string;
  name: string;
  expandLabel: string;
  collapseLabel: string;
  values: Values;
  drillScope: DrillScope;
  projects: {
    id: string;
    name: string;
    /** Null for the Unassigned tie-out row: a project-is-null scope has no P&L link. */
    pnlHref: string | null;
    values: Values;
    drillScope: DrillScope;
  }[];
};

const metricKeys: (keyof Values)[] = [
  "revenue",
  "cogs",
  "grossProfit",
  "expenses",
  "net",
  "margin",
  "hours",
];

function ValueCells({
  values,
  label,
  base,
  scope,
  currency,
  weight,
}: {
  values: Values;
  label: string;
  base: ProfitDrillBase | null;
  scope: DrillScope;
  currency: string;
  weight?: string;
}) {
  const format = useFormatter();
  const { money } = useMoney();
  const drills = base && scope ? profitDrillTargets(base, label, scope) : null;
  return metricKeys.map((key) => {
    const value = values[key];
    const target: ReportDrillTarget | null = drills?.[key] ?? null;
    const negative =
      value !== null && isNegative(value, key === "margin" ? "variance_pct" : "amount");
    const text =
      key === "margin"
        ? value === null
          ? "—"
          : format.number(decimalToNumber(marginRatioToPercent(String(value))) / 100, {
              style: "percent",
              minimumFractionDigits: 1,
              maximumFractionDigits: 1,
            })
        : key === "hours"
          ? format.number(Number(value ?? 0), { maximumFractionDigits: 2 })
          : money(value ?? "0", { currency: currency || undefined, accounting: true });
    return (
      <TableCell
        key={key}
        className={cn(
          "text-right whitespace-nowrap tabular-nums",
          weight,
          negative && "text-red-600 dark:text-red-400",
        )}
      >
        {target ? (
          <ReportDrillLink
            target={target}
            className="hover:text-teal-700 hover:underline dark:hover:text-teal-300"
          >
            {text}
          </ReportDrillLink>
        ) : (
          text
        )}
      </TableCell>
    );
  });
}

export function ProjectProfitabilityTable({
  company,
  title,
  periodPhrase,
  columns,
  emptyLabel,
  emptyHint,
  currency,
  groups,
  totalLabel,
  totals,
  totalScope,
  drillBase,
}: {
  company: string;
  title: string;
  periodPhrase: string;
  columns: string[];
  emptyLabel: string;
  /** Explains the zero: what would have to be posted, or widen the period. */
  emptyHint: string;
  currency: string;
  groups: ProjectProfitabilityGroup[];
  totalLabel: string;
  totals: Values;
  totalScope: DrillScope;
  /** Shared by every drill on the report; null when the report cannot drill. */
  drillBase: ProfitDrillBase | null;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    const handleVisibility = (event: Event) => {
      const visibility = (event as CustomEvent<ReportSectionVisibility>).detail;
      setCollapsed(
        visibility === "collapse" ? new Set(groups.map((group) => group.key)) : new Set(),
      );
    };
    window.addEventListener(REPORT_SECTION_VISIBILITY_EVENT, handleVisibility);
    return () => window.removeEventListener(REPORT_SECTION_VISIBILITY_EVENT, handleVisibility);
  }, [groups]);

  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <ReportPaper company={company} title={title} periodPhrase={periodPhrase} wide>
      {groups.length === 0 ? (
        <div className="py-6 text-center">
          <p className="text-sm text-slate-400 italic dark:text-slate-500">{emptyLabel}</p>
          <p className="mx-auto mt-1 max-w-xl text-xs leading-relaxed text-slate-400 dark:text-slate-500">
            {emptyHint}
          </p>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column, index) => (
                <TableHead key={column} className={index === 0 ? "min-w-64" : "text-right"}>
                  {column}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => {
              const isCollapsed = collapsed.has(group.key);
              return (
                <Fragment key={group.key}>
                  <TableRow
                    className={cn(
                      reportSubtotalRowClass,
                      "font-semibold text-slate-900 dark:text-slate-100",
                    )}
                  >
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => toggle(group.key)}
                        aria-label={isCollapsed ? group.expandLabel : group.collapseLabel}
                        className="inline-flex items-center gap-1 rounded-sm hover:text-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:hover:text-teal-300"
                      >
                        {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        {group.name}
                      </button>
                    </TableCell>
                    <ValueCells
                      values={group.values}
                      label={group.name}
                      base={drillBase}
                      scope={group.drillScope}
                      currency={currency}
                      weight="font-semibold"
                    />
                  </TableRow>
                  {!isCollapsed &&
                    group.projects.map((project) => (
                      <TableRow key={project.id}>
                        <TableCell className="pl-7">
                          {project.pnlHref ? (
                            <Link
                              href={project.pnlHref}
                              className="hover:text-teal-700 hover:underline dark:hover:text-teal-300"
                            >
                              {project.name}
                            </Link>
                          ) : (
                            project.name
                          )}
                        </TableCell>
                        <ValueCells
                          values={project.values}
                          label={project.name}
                          base={drillBase}
                          scope={project.drillScope}
                          currency={currency}
                        />
                      </TableRow>
                    ))}
                </Fragment>
              );
            })}
            <TableRow className={cn(reportTotalRowClass, "font-bold")}>
              <TableCell>{totalLabel}</TableCell>
              <ValueCells
                values={totals}
                label={totalLabel}
                base={drillBase}
                scope={totalScope}
                currency={currency}
                weight="font-bold"
              />
            </TableRow>
          </TableBody>
        </Table>
      )}
    </ReportPaper>
  );
}
