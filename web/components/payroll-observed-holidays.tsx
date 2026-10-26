import {
  Table as SharedTable,
  TableHeader as SharedTableHeader,
  TableRow as SharedTableRow,
  TableHead as SharedTableHead,
  TableBody as SharedTableBody,
  TableCell as SharedTableCell,
} from "@openbooks/ui";
import { Badge } from "@openbooks/ui";
import type { ObservedHoliday } from "@openbooks/engine/payroll/holidays";

/**
 * The observed statutory holiday table, shared by every surface that shows
 * the days payroll treats as holidays for a jurisdiction and year. Callers
 * pass the resolved holidays unchanged; this component only presents them.
 */

export interface ObservedHolidayLabels {
  date: string;
  holiday: string;
  statutoryDate: string;
  source: string;
  paid: string;
  statutory: string;
  elected: string;
  company: string;
  yes: string;
  unpaid: string;
  empty: string;
}

/** Builds the table's labels from the payroll holiday-calendar catalog keys. */
export function observedHolidayLabels(
  label: (key: string, fallback: string) => string,
): ObservedHolidayLabels {
  return {
    date: label("holidayCalendar.date", "Observed"),
    holiday: label("holidayCalendar.holiday", "Holiday"),
    statutoryDate: label("holidayCalendar.statutoryDate", "Falls on"),
    source: label("holidayCalendar.source", "Source"),
    paid: label("holidayCalendar.paid", "Paid"),
    statutory: label("holidayCalendar.statutory", "Statutory"),
    elected: label("holidayCalendar.elected", "Optional — elected"),
    company: label("holidayCalendar.company", "Company"),
    yes: label("holidayCalendar.yes", "Yes"),
    unpaid: label("holidayCalendar.unpaid", "Unpaid closure"),
    empty: label("holidayCalendar.empty", "No holidays are observed in this year."),
  };
}

export function ObservedHolidayTable({
  holidays,
  labels,
}: {
  holidays: readonly ObservedHoliday[];
  labels: ObservedHolidayLabels;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
      <SharedTable className="w-full text-sm">
        <SharedTableHeader className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
          <SharedTableRow>
            <SharedTableHead className="px-3 py-2">{labels.date}</SharedTableHead>
            <SharedTableHead className="px-3 py-2">{labels.holiday}</SharedTableHead>
            <SharedTableHead className="px-3 py-2">{labels.statutoryDate}</SharedTableHead>
            <SharedTableHead className="px-3 py-2">{labels.source}</SharedTableHead>
            <SharedTableHead className="px-3 py-2">{labels.paid}</SharedTableHead>
          </SharedTableRow>
        </SharedTableHeader>
        <SharedTableBody className="divide-y divide-slate-200 dark:divide-slate-800">
          {holidays.map((holiday) => (
            <SharedTableRow key={`${holiday.key}-${holiday.date}`}>
              <SharedTableCell className="px-3 py-2 tabular-nums">{holiday.date}</SharedTableCell>
              <SharedTableCell className="px-3 py-2">{holiday.name}</SharedTableCell>
              {/* Shown only when the observance rule MOVED the day — that
                  shift is the thing an operator most often disbelieves. */}
              <SharedTableCell className="px-3 py-2 tabular-nums text-slate-500 dark:text-slate-400">
                {holiday.statutoryDate === holiday.date ? "" : holiday.statutoryDate}
              </SharedTableCell>
              <SharedTableCell className="px-3 py-2">
                <Badge variant={holiday.source === "pack" ? "outline" : "success"}>
                  {holiday.source === "pack"
                    ? holiday.elected
                      ? labels.elected
                      : labels.statutory
                    : labels.company}
                </Badge>
              </SharedTableCell>
              <SharedTableCell className="px-3 py-2">
                {holiday.paid ? labels.yes : labels.unpaid}
              </SharedTableCell>
            </SharedTableRow>
          ))}
          {holidays.length === 0 ? (
            <SharedTableRow>
              <SharedTableCell
                colSpan={5}
                className="px-3 py-6 text-center text-slate-500 dark:text-slate-400"
              >
                {labels.empty}
              </SharedTableCell>
            </SharedTableRow>
          ) : null}
        </SharedTableBody>
      </SharedTable>
    </div>
  );
}
