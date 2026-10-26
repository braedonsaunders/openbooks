import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { NativeDocument } from "./native.ts";

/** How a connection mirrors a source transaction dated outside the posting period it names. */
export type OutOfPeriodDatePolicy = "refuse" | "period_boundary";

/** Dates a posting in the named period may carry, as the storage guard defines them. */
export interface SourcePeriodWindow {
  periodId: string;
  start: string;
  end: string;
}

/**
 * Evidence kept on a document posted on its period boundary: the source date, the period the
 * source named and the date the mirror posted on.
 */
export interface SourcePostingDateEvidence {
  sourceDate: string;
  periodId: string;
  postedOn: string;
  policy: "period_boundary";
}

/** Document `custom` key that carries {@link SourcePostingDateEvidence}. */
export const SOURCE_POSTING_DATE_EVIDENCE_KEY = "sourcePostingDateOutsidePeriod";

export type SourcePostingDateResolution =
  | { kind: "inside" }
  | { kind: "boundary"; postingDate: string; evidence: SourcePostingDateEvidence }
  | { kind: "refused"; message: string };

/**
 * Places a source posting inside the period the source named. A source date inside the window
 * is kept. Outside it, the connection's policy either refuses the transaction with the remedy,
 * or posts on the window date nearest the source date; the period, and therefore the ledger
 * impact, stays the one the source chose.
 */
export function resolveSourcePostingDate(
  sourceDate: string,
  window: SourcePeriodWindow,
  policy: OutOfPeriodDatePolicy,
  sourceName: string,
): SourcePostingDateResolution {
  if (sourceDate >= window.start && sourceDate <= window.end) return { kind: "inside" };
  if (policy === "refuse") {
    return {
      kind: "refused",
      message:
        `source date ${sourceDate} is outside its ${sourceName} posting period ` +
        `(${window.start} to ${window.end}). Correct the date in ${sourceName}, or set this ` +
        `connection's out-of-period dates to post on the period boundary.`,
    };
  }
  const postedOn = sourceDate < window.start ? window.start : window.end;
  return {
    kind: "boundary",
    postingDate: postedOn,
    evidence: { sourceDate, periodId: window.periodId, postedOn, policy: "period_boundary" },
  };
}

/** Reads each named period's posting window once per run. */
export function sourcePeriodWindowReader(
  orgId: string,
  runner: Pick<typeof db, "execute"> = db,
): (periodId: string) => Promise<SourcePeriodWindow> {
  const windows = new Map<string, Promise<SourcePeriodWindow>>();
  return (periodId) => {
    let window = windows.get(periodId);
    if (!window) {
      window = runner
        .execute<{ window_start: string; window_end: string }>(
          sql`
            select window_start::text as window_start, window_end::text as window_end
              from accounting_period_posting_window(${orgId}, ${periodId})`,
          "objects",
        )
        .then((rows) => {
          const row = rows[0];
          if (!row)
            throw new Error(`accounting period ${periodId} does not exist in this organization`);
          return { periodId, start: row.window_start, end: row.window_end };
        });
      windows.set(periodId, window);
      window.catch(() => windows.delete(periodId));
    }
    return window;
  };
}

/**
 * The posting date the mirror writes for a source document under the connection's
 * out-of-period policy. Change detection keeps comparing the source date: the stored key reads
 * it back from the evidence, so an unchanged source stays unchanged on every later run.
 */
export async function placeSourcePostingDate(
  doc: NativeDocument,
  readWindow: (periodId: string) => Promise<SourcePeriodWindow>,
  policy: OutOfPeriodDatePolicy,
  sourceName: string,
): Promise<
  { postingDate: string; evidence: SourcePostingDateEvidence | null } | { refused: string }
> {
  const sourceDate = doc.postingDate ?? doc.documentDate;
  if (!doc.posting || !doc.postingPeriodId) return { postingDate: sourceDate, evidence: null };
  const resolution = resolveSourcePostingDate(
    sourceDate,
    await readWindow(doc.postingPeriodId),
    policy,
    sourceName,
  );
  if (resolution.kind === "refused") return { refused: resolution.message };
  if (resolution.kind === "inside") return { postingDate: sourceDate, evidence: null };
  return { postingDate: resolution.postingDate, evidence: resolution.evidence };
}
