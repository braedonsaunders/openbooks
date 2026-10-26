/**
 * The window a home-page year tile sums. A fiscal year that is still open runs
 * past the business day, and the ledger accepts future-dated postings, so the
 * tile is cut at the business day: it sums the fiscal year from its start
 * through today, and it names that day whenever the year is still open. A
 * closed year, or one ending today, keeps its own end date and needs no cut-off.
 */
export interface HomeFiscalWindow {
  from: string;
  to: string;
  /** The business day the window is cut at, or null when the year has closed. */
  throughDate: string | null;
}

export function homeFiscalWindow(
  period: { from: string; to: string },
  today: string,
): HomeFiscalWindow {
  if (today < period.from) {
    throw new Error(
      `business date '${today}' precedes the fiscal window starting '${period.from}'`,
    );
  }
  if (period.to >= today) {
    return { from: period.from, to: today, throughDate: today };
  }
  return { from: period.from, to: period.to, throughDate: null };
}
