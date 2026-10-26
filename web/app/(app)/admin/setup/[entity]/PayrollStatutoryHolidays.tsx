"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Alert } from "@openbooks/ui";
import type {
  StatutoryHolidayCalendar,
  StatutoryHolidayCalendarRefusal,
} from "@openbooks/engine/payroll/holidays";
import {
  ObservedHolidayTable,
  observedHolidayLabels,
} from "../../../../../components/payroll-observed-holidays";

/**
 * The payroll statutory holidays on the Business calendars screen, read-only.
 *
 * Business calendars answer "which days does the organization close", and
 * payroll answers "which days does the law make holidays for each employee".
 * Those lists differ, so the screen shows the second one beside the first. The
 * rows are the calendar the pay run and remittance due dates apply, and the
 * country pack maintains them: nothing here is editable. Optional days and
 * company closures are elected on the payroll Holidays tab.
 */
export interface PayrollStatutoryHolidaysProps {
  year: number;
  calendars: StatutoryHolidayCalendar[];
  refusals: StatutoryHolidayCalendarRefusal[];
  previousYearHref: string;
  nextYearHref: string;
  payrollHolidaysHref: string;
}

export function PayrollStatutoryHolidaysSection({
  year,
  calendars,
  refusals,
  previousYearHref,
  nextYearHref,
  payrollHolidaysHref,
}: PayrollStatutoryHolidaysProps) {
  const t = useTranslations("admin.setup");
  const payroll = useTranslations("payroll.settingsPage");
  const payrollLabel = (key: string, fallback: string) =>
    payroll.has(key as never) ? payroll(key as never) : fallback;
  const labels = observedHolidayLabels(payrollLabel);
  const nothingToShow = calendars.length === 0 && refusals.length === 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          {t("payrollStatutoryHolidays.title")}
        </h2>
        <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          {t("payrollStatutoryHolidays.description")}
        </p>
      </div>

      <nav
        aria-label={t("payrollStatutoryHolidays.yearNavigation")}
        className="flex flex-wrap items-center gap-3 text-sm"
      >
        <Link
          href={previousYearHref}
          className="font-medium text-teal-700 hover:underline dark:text-teal-300"
        >
          {t("payrollStatutoryHolidays.previousYear")}
        </Link>
        <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
          {year}
        </span>
        <Link
          href={nextYearHref}
          className="font-medium text-teal-700 hover:underline dark:text-teal-300"
        >
          {t("payrollStatutoryHolidays.nextYear")}
        </Link>
      </nav>

      {nothingToShow ? <Alert>{t("payrollStatutoryHolidays.empty")}</Alert> : null}

      {/* A calendar that cannot be read is named as a refusal, never shown as
          an empty list: an empty list reads as "this employer works every day". */}
      {refusals.map((refusal) => (
        <Alert key={refusal.jurisdiction} variant="destructive">
          <span className="font-mono text-xs">{refusal.jurisdiction}</span> — {refusal.message}
        </Alert>
      ))}

      {calendars.map((calendar) => (
        <section key={calendar.jurisdiction} className="space-y-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {calendar.name}{" "}
              <span className="font-mono text-xs font-normal text-slate-500 dark:text-slate-400">
                {calendar.jurisdiction}
              </span>
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {payrollLabel("holidayCalendar.citation", "Source")}: {calendar.citation}
            </p>
          </div>
          <ObservedHolidayTable holidays={calendar.holidays} labels={labels} />
        </section>
      ))}

      <p className="text-xs text-slate-500 dark:text-slate-400">
        {t("payrollStatutoryHolidays.note")}{" "}
        <Link
          href={payrollHolidaysHref}
          className="font-medium text-teal-700 hover:underline dark:text-teal-300"
        >
          {t("payrollStatutoryHolidays.noteLink")}
        </Link>
      </p>
    </div>
  );
}
