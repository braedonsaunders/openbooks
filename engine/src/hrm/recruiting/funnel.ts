/**
 * Pure recruiting math (HR-6): offer expiry, funnel counts, time-to-fill,
 * and the stage-move transition matrix. No imports — unit tests run these
 * directly, and the services reuse them so the rules cannot drift.
 */

export type EffectiveOfferStatus = "draft" | "sent" | "accepted" | "declined" | "withdrawn" | "expired";

/**
 * The offer status the reader reports. Expiry is COMPUTED here and
 * materialised on the next write: a sent offer whose expires_on is before
 * the org business day reads expired without any background sweeper owning
 * offer state.
 */
export function effectiveOfferStatus(args: {
  status: string;
  expiresOn: string | null;
  businessToday: string;
}): EffectiveOfferStatus {
  const { status, expiresOn, businessToday } = args;
  if (status === "sent" && expiresOn !== null && expiresOn < businessToday) return "expired";
  if (
    status === "draft" ||
    status === "sent" ||
    status === "accepted" ||
    status === "declined" ||
    status === "withdrawn" ||
    status === "expired"
  ) {
    return status;
  }
  throw new Error(`unknown offer status ${JSON.stringify(status)} — the stored value set is fixed by migration 0195`);
}

/** Whole days from requisition opening to hire (both civil dates). */
export function timeToFillDays(openedOn: string, hiredOn: string): number {
  const openMs = Date.parse(`${openedOn}T00:00:00Z`);
  const hiredMs = Date.parse(`${hiredOn}T00:00:00Z`);
  if (!Number.isFinite(openMs) || !Number.isFinite(hiredMs)) {
    throw new Error("time-to-fill needs two YYYY-MM-DD dates — the funnel never averages an unreadable date");
  }
  return Math.round((hiredMs - openMs) / 86_400_000);
}

/** Per-stage application counts over the template's ordered stage keys. */
export function funnelCounts(args: {
  stageKeys: readonly string[];
  applications: readonly { stageKey: string }[];
}): { stageKey: string; count: number }[] {
  const counts = new Map<string, number>(args.stageKeys.map((key) => [key, 0]));
  for (const application of args.applications) {
    if (!counts.has(application.stageKey)) {
      throw new Error(
        `application sits on unknown stage ${JSON.stringify(application.stageKey)} — the funnel counts only the template's own stages`,
      );
    }
    counts.set(application.stageKey, counts.get(application.stageKey)! + 1);
  }
  return args.stageKeys.map((stageKey) => ({ stageKey, count: counts.get(stageKey)! }));
}

export interface StageMoveAssertion {
  readonly fromStatus: string;
  readonly fromIsTerminal: boolean;
  readonly toKind: string;
  readonly toIsTerminal: boolean;
  readonly sameTemplate: boolean;
  /** True only when the move rides the hire transaction. */
  readonly viaHire: boolean;
}

/**
 * The pure half of the stage-move matrix. Template membership, liveness of
 * both rows, and the hire-stage target come from the service on the trusted
 * runner; this decides the shape. Throws Error naming the refused shape —
 * the service wraps it in a RecruitingError with the remedy.
 */
export function assertStageMoveAllowed(move: StageMoveAssertion): void {
  if (move.fromStatus !== "active") {
    throw new Error(
      `a ${move.fromStatus} application is terminal — file a new application for a revised candidacy instead`,
    );
  }
  if (move.fromIsTerminal) {
    throw new Error(
      "the current stage is terminal — move to a non-terminal stage first instead of moving out of the funnel end",
    );
  }
  if (!move.sameTemplate) {
    throw new Error(
      "the target stage belongs to another pipeline template — move within the requisition's own funnel instead",
    );
  }
  if (move.toKind === "hired" && !move.viaHire) {
    throw new Error(
      "the hired stage is reached only through hire — accept the offer instead of moving the application by hand",
    );
  }
  if (move.toIsTerminal && move.toKind === "rejected") {
    throw new Error(
      "the rejected stage is reached through reject with a reason — reject the application instead of moving it by hand",
    );
  }
}
