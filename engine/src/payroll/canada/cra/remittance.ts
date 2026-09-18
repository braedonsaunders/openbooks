import type {
  PayrollRemittanceSchedule,
} from "../../packs.ts";

/**
 * Canada Revenue Agency payroll source-deductions remittance schedule — the
 * destination schedule for the CA pack's `craRemittancePartyId` vendor.
 *
 * Transcribed from the CRA's published "When to remit (pay)" table and its
 * weekend/holiday sentence — the same page the legacy per-account function in
 * `engine/src/payroll-remittance.ts` (`remittanceDueDateExplained`) quotes:
 *
 *   https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/
 *     payroll/remitting-source-deductions/how-when-remit-due-dates.html
 *
 * The working-day calendar is the CRA's own public-holiday list (never an
 * employer's), transcribed as the `CA-CRA` / `CA-CRA-QC` tax-administration
 * jurisdictions:
 *
 *   https://www.canada.ca/en/revenue-agency/services/tax/public-holidays.html
 *
 * The frequencies are the CRA's remitter types, keyed EXACTLY as
 * `payroll_filing_accounts.remitter_type` spells them (`regular`,
 * `quarterly`, `accelerated_1`, `accelerated_2`), so the future
 * filing-account handoff (F-f7-001) feeds the account's registration straight
 * into this schedule with no translation table. Until that handoff lands, the
 * frequency resolves the RQ way — the org's configured `craRemittanceFrequency`
 * or the schedule default — and the legacy function stays the live path for
 * destinations the schedule does not yet govern.
 *
 * The bands: a remitter's threshold follows its average monthly withholding
 * amount (AMWA) — under $3,000 quarterly, $25,000 to under $100,000
 * accelerated threshold 1, $100,000 or more accelerated threshold 2, everyone
 * else monthly. Quarterly additionally requires a 12-month perfect compliance
 * history, so a small but non-compliant employer is a regular remitter the
 * bands read as quarterly — the bands only feed the readiness advisory (never
 * a bill date), which tells the operator to confirm against the CRA notice.
 * A new employer is a regular remitter, which is why `defaultFrequency` is
 * regular — the same default the legacy function applies when no filing
 * account names a type.
 *
 * The deadlines: regular — the 15th of the month following the month of the
 * pay date; quarterly — the 15th of the month following the end of the
 * quarter (April 15, July 15, October 15, January 15); accelerated
 * threshold 1 — the 25th of the same month for remuneration paid the 1st to
 * the 15th, the 10th of the following month for the 16th to month end;
 * accelerated threshold 2 — four quarter-month periods (1st–7th, 8th–14th,
 * 15th–21st, 22nd–month-end), each due the 3rd WORKING day after the period's
 * end. A fixed-date deadline falling on a Saturday, Sunday or CRA-recognized
 * public holiday moves to the next business day; a working-day-counted one
 * lands on a working day by construction.
 *
 * The calendar is the federal `CA-CRA` list: the CRA recognizes Easter Monday
 * and the Civic Holiday (first Monday in August), which no employment calendar
 * carries. A Québec-only payroll counts the same timetable on `CA-CRA-QC`
 * instead (Saint-Jean-Baptiste Day observed, the Civic Holiday not) — the two
 * calendars diverge only when a deadline touches June 24 or the August Civic
 * Holiday, and the declared executor resolves whichever calendar the schedule
 * names, so the Québec variant is proven from the same data.
 *
 * `effectiveFrom` marks transcription coverage, not a law change: these bands
 * long predate it. Periods ending before it keep the legacy function's dates
 * (byte-identical for regular filers — the goldens prove it), and a future CRA
 * change ships as a second schedule version with a contiguous range.
 */
export const CRA_REMITTANCE_SCHEDULE: PayrollRemittanceSchedule = {
  vendorSettingsKey: "craRemittancePartyId",
  authority: "Canada Revenue Agency",
  sources: [
    "CRA, When to remit (pay) your source deductions (remitter types, AMWA thresholds and due dates)",
    "CRA, Public holidays (the working-day calendar remittance deadlines move against)",
    "https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/payroll/remitting-source-deductions/how-when-remit-due-dates.html",
    "https://www.canada.ca/en/revenue-agency/services/tax/public-holidays.html",
  ],
  effectiveFrom: "2024-01-01",
  calendar: "CA-CRA",
  frequencySettingsKey: "craRemittanceFrequency",
  defaultFrequency: "regular",
  frequencies: [
    {
      frequency: "quarterly",
      label: "Quarterly",
      averageMonthlyMaxExclusive: "3000",
      due: { kind: "quarter_day", day: 15, monthsAfterQuarterEnd: 1 },
      rule: "quarterly remitter — the 15th of the month following the end of the quarter",
    },
    {
      frequency: "regular",
      label: "Regular",
      averageMonthlyMin: "3000",
      averageMonthlyMaxExclusive: "25000",
      due: { kind: "month_day", day: 15, monthsAfterPeriodMonth: 1 },
      rule: "regular remitter — the 15th of the month following the month of the pay date",
    },
    {
      frequency: "accelerated_1",
      label: "Accelerated threshold 1",
      averageMonthlyMin: "25000",
      averageMonthlyMaxExclusive: "100000",
      due: {
        kind: "split_month",
        cutoffDay: 15,
        firstDueDay: 25,
        firstDueMonthOffset: 0,
        secondDueDay: 10,
        secondDueMonthOffset: 1,
      },
      rule: "accelerated threshold 1 — remuneration paid the 1st to the 15th, "
        + "due the 25th of the same month",
      ruleSecondHalf: "accelerated threshold 1 — remuneration paid the 16th to month end, "
        + "due the 10th of the following month",
    },
    {
      frequency: "accelerated_2",
      label: "Accelerated threshold 2",
      averageMonthlyMin: "100000",
      due: { kind: "quarter_month_working_days", workingDays: 3 },
      rule: "accelerated threshold 2 — remuneration paid in a quarter-month period "
        + "(the 1st to the 7th, the 8th to the 14th, the 15th to the 21st, or the 22nd "
        + "to the last day of the month), due the 3rd working day after the end of that period",
    },
  ],
};
