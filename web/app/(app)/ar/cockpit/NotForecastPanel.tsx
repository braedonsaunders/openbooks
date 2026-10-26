"use client";

import { useTranslations } from "next-intl";
import { ShieldAlert } from "lucide-react";

import { useMoney } from "@/components/money-provider";
import { CockpitPanel } from "../../../../components/cockpit/ui";
import type { NotForecastSummary } from "./not-forecast";

/**
 * Receivables past the collectability horizon. They are not projected as
 * receipts in any week, so they are named here with their total and their age
 * instead of inflating the cash-in forecast. Renders nothing when none are
 * excluded.
 */
export function NotForecastPanel({ notForecast }: { notForecast: NotForecastSummary }) {
  const t = useTranslations("ar.cockpit.notForecast");
  const { money } = useMoney();
  if (notForecast.count === 0) return null;
  const shown = notForecast.entries;
  return (
    <CockpitPanel
      title={t("title", { days: notForecast.horizonDays })}
      icon={ShieldAlert}
      hint={t("hint", { count: notForecast.count, total: money(notForecast.total) })}
      className="shrink-0"
    >
      <p className="mb-2 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{t("body")}</p>
      <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
        {shown.map((entry) => (
          <li key={entry.id} className="flex items-center justify-between gap-3 py-1.5">
            <span className="min-w-0 truncate text-slate-700 dark:text-slate-300">
              {entry.partyName}
              {entry.docNumber ? (
                <span className="ml-1.5 font-mono text-slate-400">{entry.docNumber}</span>
              ) : null}
            </span>
            <span className="shrink-0 text-right tabular-nums">
              <span className="mr-2 text-slate-500 dark:text-slate-400">
                {t("daysOverdue", { days: entry.daysOverdue })}
              </span>
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {money(entry.amount)}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {notForecast.count > shown.length ? (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          {t("more", { count: notForecast.count - shown.length })}
        </p>
      ) : null}
    </CockpitPanel>
  );
}
