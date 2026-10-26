/** Refusals of the periodic runs: stock compensation and note interest, and the periods they post into. */
export const RUN_REFUSALS = {
  runPeriodNotEnded: {
    code: "equity_run_period_not_ended",
    status: 409,
    message:
      "The {run, select, compensation {stock compensation run} interest {note interest run} other {posting}} through {date} falls in {period}, which ends on {endsOn}, after today ({today}).",
    remedy:
      "Run through the end of a period that has ended by today ({today}); the runs view offers the next one with activity due, and anything recognized since the last run is caught up in it.",
    params: { run: "choice", date: "date", period: "period", endsOn: "date", today: "date" },
  },
  runPeriodClosed: {
    code: "equity_period_closed",
    status: 409,
    message:
      "The {run, select, compensation {stock compensation run} interest {note interest run} other {posting}} through {date} falls in {period}, which is closed for posting.",
    remedy:
      "Run through the end of an open period (the runs view offers the next one with activity due), or request a controlled reopen of {closing} through Period Close.",
    params: { run: "choice", date: "date", period: "period", closing: "period" },
  },
  compensationRunBackdated: {
    code: "equity_compensation_run_backdated",
    status: 409,
    message: "A stock compensation run through {last} is already posted.",
    remedy: "Run through a date after {last}; earlier periods are already measured.",
    params: { last: "date" },
  },
  interestRunBackdated: {
    code: "equity_interest_run_backdated",
    status: 409,
    message: "A note interest run through {last} is already posted.",
    remedy: "Run through a date after {last}; earlier periods are already accrued.",
    params: { last: "date" },
  },
  compensationNothingDue: {
    code: "equity_run_nothing_due",
    status: 409,
    message: "No stock compensation is due through {date}.",
    remedy:
      "Nothing changes in this period; run through a later period end once awards vest or are granted.",
    params: { date: "date" },
  },
  compensationNothingDueSince: {
    code: "equity_run_nothing_due",
    status: 409,
    message: "No stock compensation is due through {date} beyond the run through {last}.",
    remedy:
      "Nothing changes in this period; run through a later period end once awards vest or are granted.",
    params: { date: "date", last: "date" },
  },
  interestNothingDue: {
    code: "equity_run_nothing_due",
    status: 409,
    message: "No note interest is due through {date}.",
    remedy:
      "No note accrues interest in this period; run through a later period end while a note is outstanding.",
    params: { date: "date" },
  },
  interestNothingDueSince: {
    code: "equity_run_nothing_due",
    status: 409,
    message: "No note interest is due through {date} beyond the run through {last}.",
    remedy:
      "No note accrues interest in this period; run through a later period end while a note is outstanding.",
    params: { date: "date", last: "date" },
  },
  interestBelowAccrued: {
    code: "equity_interest_unreconciled",
    status: 409,
    message: "Interest on {security} through {date} is below what is already accrued.",
    remedy:
      "Review the note's interest entries and settlements in the journal; accrued interest only falls when a note is voided.",
    params: { security: "text", date: "date" },
  },
  noteDayCountMissing: {
    code: "equity_note_terms_missing",
    message: "The note has no day-count convention.",
    remedy: "Record the note's day count (Actual/365, Actual/360, 30/360 or Actual/Actual).",
  },
  noteInterestBasisMissing: {
    code: "equity_note_terms_missing",
    message: "The note has no interest basis.",
    remedy:
      "Record how the note's interest builds (simple, or compounded annually, semiannually, quarterly or monthly).",
  },
} as const;
