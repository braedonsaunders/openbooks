import type {
  PayrollRemittanceSchedule,
} from "../../packs.ts";

/**
 * Revenu Québec source-deductions remittance schedule (form TPZ-1015.R) —
 * the destination schedule for the CA pack's `rqRemittancePartyId` vendor.
 *
 * A Québec employer's QPP/QPIP (both shares) and Québec income tax are NOT
 * CRA remittances: they go to Revenu Québec on TPZ-1015.R, on Revenu Québec's
 * own frequencies and deadlines. Stamping them with the CRA schedule from
 * `payroll_filing_accounts.remitter_type` (a CRA registration — see
 * schema/src/payroll-filing.ts) is how an RQ bill lands with a CRA
 * accelerated-threshold-2 date that Revenu Québec never set.
 *
 * Transcribed from:
 *   - Revenu Québec, Guide TP-1015.G-V, "Guide for Employers: Source
 *     Deductions and Contributions", s. "Remittance frequency" and s. "Remittance
 *     deadlines" — the three average-monthly-remittance bands below and the
 *     deadline of each;
 *   - Revenu Québec, form TPZ-1015.R-V, "Remittance Slip — Source Deductions
 *     and Employer Contributions" — the slip an RQ bill remits against;
 *   - https://www.revenuquebec.ca/en/employers/source-deductions-and-employer-
 *     contributions/remitting-source-deductions-and-employer-contributions/
 *     (the "Remittance frequency" topic page).
 *
 * The bands: an employer's frequency for the year follows its average monthly
 * remittance (source deductions plus employer contributions) for the previous
 * calendar year — under $3,000 quarterly, $3,000 to under $25,000 monthly,
 * $25,000 or more twice a month. A new employer remits monthly in its first
 * calendar year, which is why `defaultFrequency` is monthly rather than a
 * guess from partial-year history: the product's in-year stub lines are only
 * part of what Revenu Québec counts (the health services fund, CNT and WSDRF
 * levies are not computed — see RLZ1S_GAPS), so deriving the band from them
 * can only UNDERSTATE the frequency and push a deadline late. The org's
 * frequency is explicit configuration (`rqRemittanceFrequency`, validated
 * against `frequencies`); the bands let readiness compare the configured
 * frequency with the measured average instead of silently trusting either.
 *
 * The deadlines: quarterly — the 15th of the month following the end of the
 * quarter (April 15, July 15, October 15, January 15); monthly — the 15th of
 * the month following the month the remuneration was paid; twice-monthly —
 * the 25th of the same month for remuneration paid the 1st to the 15th, the
 * 10th of the following month for the 16th to month end. A deadline falling on
 * a Saturday, Sunday or statutory holiday moves to the next business day.
 *
 * The calendar is the Québec due-date calendar the product already transcribes
 * (`CA-CRA-QC`: Saint-Jean-Baptiste Day observed, the federal Civic Holiday
 * not): Revenu Québec observes Québec statutory holidays, not the federal
 * list. With fixed 10th/15th/25th deadlines the two calendars essentially
 * never diverge — unlike the CRA's working-day-counted threshold 2 — but the
 * declaration names the authority's own calendar anyway, because the day a
 * future rule starts counting working days is exactly when a borrowed calendar
 * goes wrong silently.
 *
 * `effectiveFrom` marks transcription coverage, not a law change: these bands
 * long predate it. A future Revenu Québec change ships as a second schedule
 * version with a contiguous range, and `remittanceScheduleInForce` resolves by
 * period-end date — past bills keep the rule text stamped at creation, so a
 * change never reinterprets history.
 */
export const RQ_REMITTANCE_SCHEDULE: PayrollRemittanceSchedule = {
  vendorSettingsKey: "rqRemittancePartyId",
  authority: "Revenu Québec",
  sources: [
    "Revenu Québec, Guide TP-1015.G-V, Guide for Employers: Source Deductions and Contributions (remittance frequency and deadlines)",
    "Revenu Québec, form TPZ-1015.R-V, Remittance Slip — Source Deductions and Employer Contributions",
    "https://www.revenuquebec.ca/en/employers/source-deductions-and-employer-contributions/remitting-source-deductions-and-employer-contributions/",
  ],
  effectiveFrom: "2024-01-01",
  calendar: "CA-CRA-QC",
  frequencySettingsKey: "rqRemittanceFrequency",
  defaultFrequency: "monthly",
  frequencies: [
    {
      frequency: "quarterly",
      label: "Quarterly",
      averageMonthlyMaxExclusive: "3000",
      due: { kind: "quarter_day", day: 15, monthsAfterQuarterEnd: 1 },
      rule: "Revenu Québec quarterly remitter (average monthly remittance under $3,000) — "
        + "the 15th of the month following the end of the quarter",
    },
    {
      frequency: "monthly",
      label: "Monthly",
      averageMonthlyMin: "3000",
      averageMonthlyMaxExclusive: "25000",
      due: { kind: "month_day", day: 15, monthsAfterPeriodMonth: 1 },
      rule: "Revenu Québec monthly remitter (average monthly remittance $3,000 to under $25,000) — "
        + "the 15th of the month following the month of the pay date",
    },
    {
      frequency: "twice_monthly",
      label: "Twice monthly",
      averageMonthlyMin: "25000",
      due: {
        kind: "split_month",
        cutoffDay: 15,
        firstDueDay: 25,
        firstDueMonthOffset: 0,
        secondDueDay: 10,
        secondDueMonthOffset: 1,
      },
      rule: "Revenu Québec twice-monthly remitter (average monthly remittance $25,000 or more) — "
        + "remuneration paid the 1st to the 15th, due the 25th of the same month",
      ruleSecondHalf: "Revenu Québec twice-monthly remitter (average monthly remittance $25,000 or more) — "
        + "remuneration paid the 16th to month end, due the 10th of the following month",
    },
  ],
};
