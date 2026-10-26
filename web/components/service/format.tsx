"use client";

import { useMemo, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@openbooks/ui";
import { createMoneyFormatter } from "@/lib/money-format";

type Variant = "default" | "secondary" | "outline" | "destructive" | "warning" | "success";

const VISIT_VARIANT: Record<string, Variant> = {
  unscheduled: "outline",
  scheduled: "secondary",
  dispatched: "default",
  en_route: "warning",
  on_site: "warning",
  completed: "success",
  unable_to_complete: "destructive",
  cancelled: "outline",
};
const RECORD_VARIANT: Record<string, Variant> = {
  new: "default",
  assessment_scheduled: "secondary",
  assessed: "secondary",
  quoted: "warning",
  converted: "success",
  declined: "outline",
  cancelled: "outline",
  open: "default",
  completed: "success",
  active: "success",
  ended: "outline",
  draft: "secondary",
  sent: "warning",
  accepted: "success",
};
const PRIORITY_VARIANT: Record<string, Variant> = {
  urgent: "destructive",
  high: "warning",
  normal: "secondary",
  low: "outline",
};

/** An exact decimal string without trailing zeros ("2.5000" → "2.5"); never parsed as a float. */
export function plainDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

export function VisitStatusBadge({ status }: { status: string }) {
  const t = useTranslations("service");
  return <Badge variant={VISIT_VARIANT[status] ?? "secondary"}>{t(`visitStatus.${status}`)}</Badge>;
}

export function RecordStatusBadge({
  status,
  family,
}: {
  status: string;
  family: "request" | "job" | "agreement" | "quote";
}) {
  const t = useTranslations("service");
  return (
    <Badge variant={RECORD_VARIANT[status] ?? "secondary"}>{t(`${family}Status.${status}`)}</Badge>
  );
}

export function PriorityBadge({ priority }: { priority: string }) {
  const t = useTranslations("service");
  return (
    <Badge variant={PRIORITY_VARIANT[priority] ?? "secondary"}>{t(`priority.${priority}`)}</Badge>
  );
}

/** Locale formatting for service records: instants, civil dates, durations and exact money. */
export function useServiceFormat() {
  const locale = useLocale();
  const t = useTranslations("service");
  return useMemo(() => {
    const instant = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
    const timeOnly = new Intl.DateTimeFormat(locale, { timeStyle: "short" });
    const civil = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
    return {
      instant: (value: string | null | undefined) =>
        value ? instant.format(new Date(value)) : "—",
      time: (value: string | null | undefined) => (value ? timeOnly.format(new Date(value)) : "—"),
      date: (value: string | null | undefined) =>
        value ? civil.format(new Date(`${value.slice(0, 10)}T00:00:00Z`)) : "—",
      window: (from: string | null, to: string | null) =>
        from && to ? `${instant.format(new Date(from))} – ${timeOnly.format(new Date(to))}` : "—",
      minutes: (value: number) =>
        t("format.minutes", { hours: Math.floor(value / 60), minutes: value % 60 }),
      money: (value: string | null | undefined, currency: string) =>
        value === null || value === undefined
          ? "—"
          : createMoneyFormatter(locale, currency).money(value, { currency }),
    };
  }, [locale, t]);
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-slate-900 dark:text-slate-100">{children}</dd>
    </div>
  );
}

export function Section({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Refusal({
  refusal,
}: {
  refusal: { message: string; remedy: string | null } | null;
}) {
  if (!refusal) return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200"
    >
      <p>{refusal.message}</p>
      {refusal.remedy ? <p className="mt-1 text-xs opacity-80">{refusal.remedy}</p> : null}
    </div>
  );
}
