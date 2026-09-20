import { compareCivilDates, parseCivilDate, type CivilDate } from "./temporal.ts";

/**
 * Pure HRM process checklist math (HR-4): due-date offsets, overdue
 * evaluation, progress summary, template snapshots, and template matching.
 *
 * Zero imports beyond temporal.ts (which is itself dependency-free): no
 * Date objects, no time zones, no database. "Today" always arrives as a
 * civil YYYY-MM-DD string — the service resolves business today through
 * platform/business-date.ts and hands it in, so this module never couples
 * to the pool the way a direct business-date import would. Never duplicated:
 * callers reuse these functions instead of reimplementing offsets.
 */

export type ProcessMathErrorCode =
  | "INVALID_DATE"
  | "DATE_OUT_OF_RANGE"
  | "EMPTY_SNAPSHOT"
  | "INVALID_TEMPLATE"
  | "NO_TEMPLATE"
  | "AMBIGUOUS_TEMPLATE"
  | "INVALID_STEP";

export class ProcessMathError extends Error {
  readonly code: ProcessMathErrorCode;
  constructor(code: ProcessMathErrorCode, message: string) {
    super(message);
    this.name = "ProcessMathError";
    this.code = code;
  }
}

/** Days since 0001-01-01 (day 0), proleptic Gregorian — mirrors temporal.ts. */
function dayNumberOf(year: number, month: number, day: number): number {
  const shiftedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(shiftedYear / 400);
  const yearOfEra = shiftedYear - era * 400;
  const monthPrime = month > 2 ? month - 3 : month + 9;
  const dayOfYear = Math.floor((153 * monthPrime + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 306;
}

/** Inverse of dayNumberOf: civil date for a day number (Hinnant's algorithm). */
function civilFromDayNumber(dayNumber: number): { year: number; month: number; day: number } {
  const shifted = dayNumber + 306;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9;
  return { year: month <= 2 ? year + 1 : year, month, day };
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function padYear(year: number): string {
  if (year < 10) return `000${year}`;
  if (year < 100) return `00${year}`;
  if (year < 1000) return `0${year}`;
  return String(year);
}

/**
 * Add whole calendar days to a civil date on the integer day grid.
 * Negative offsets walk backwards (pre-start preparation steps). A result
 * outside years 0001–9999 is refused — the reader cannot observe it, so it
 * must not be stored.
 */
export function addOffsetDays(effectiveDate: string, offsetDays: number): CivilDate {
  const start = parseCivilDate(effectiveDate);
  if (!Number.isSafeInteger(offsetDays)) {
    throw new ProcessMathError(
      "INVALID_DATE",
      `due offset ${String(offsetDays)} is not a whole number of days — store due offsets as integer days relative to the effective date`,
    );
  }
  const parts = start.split("-").map(Number);
  const target = dayNumberOf(parts[0]!, parts[1]!, parts[2]!) + offsetDays;
  const civil = civilFromDayNumber(target);
  if (civil.year < 1 || civil.year > 9999) {
    throw new ProcessMathError(
      "DATE_OUT_OF_RANGE",
      `effective date ${start} plus ${offsetDays} days leaves the supported calendar (0001 through 9999) — shorten the offset`,
    );
  }
  return parseCivilDate(`${padYear(civil.year)}-${pad2(civil.month)}-${pad2(civil.day)}`);
}

/**
 * Overdue = due_on strictly before business today while still pending.
 * Done and skipped steps are never overdue, whatever their dates.
 */
export function isStepOverdue(args: {
  dueOn: string;
  today: string;
  status: string;
}): boolean {
  const dueOn = parseCivilDate(args.dueOn);
  const today = parseCivilDate(args.today);
  if (args.status === "done" || args.status === "skipped") return false;
  if (args.status !== "pending") {
    throw new ProcessMathError(
      "INVALID_STEP",
      `unknown step status ${JSON.stringify(args.status)} — expect pending, done, or skipped`,
    );
  }
  return compareCivilDates(dueOn, today) < 0;
}

export interface ProgressSummary {
  readonly total: number;
  readonly required: number;
  /** Required steps in done state. Exact integers — never a float ratio. */
  readonly doneRequired: number;
  readonly allRequiredDone: boolean;
}

/**
 * Progress over a step list. Exact counts only: callers format the ratio,
 * so no float ever enters stored or compared state.
 */
export function summarizeProgress(
  steps: readonly { required: boolean; status: string }[],
): ProgressSummary {
  let required = 0;
  let doneRequired = 0;
  for (const step of steps) {
    if (step.status !== "pending" && step.status !== "done" && step.status !== "skipped") {
      throw new ProcessMathError(
        "INVALID_STEP",
        `unknown step status ${JSON.stringify(step.status)} — expect pending, done, or skipped`,
      );
    }
    if (step.required) {
      required += 1;
      if (step.status === "done") doneRequired += 1;
    }
  }
  return {
    total: steps.length,
    required,
    doneRequired,
    allRequiredDone: doneRequired === required,
  };
}

export interface TemplateStepInput {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly description: string | null;
  readonly ownerKind: string;
  readonly ownerPartyId: string | null;
  readonly dueOffsetDays: number;
  readonly required: boolean;
  readonly evidenceKind: string;
}

export interface ProcessStepSnapshot {
  readonly templateStepId: string;
  readonly position: number;
  readonly title: string;
  readonly description: string | null;
  readonly ownerKind: string;
  readonly ownerPartyId: string | null;
  readonly dueOn: CivilDate;
  readonly required: boolean;
  readonly evidenceKind: string;
}

/**
 * Instantiate a template as a snapshot: every step copied with its concrete
 * due date, ordered by position, all pending. Later template edits never
 * touch these copies — the copy IS the record.
 *
 * Refuses an empty template (a zero-step process would complete vacuously —
 * unconfigured input that is always owed), duplicated positions, and
 * unknown owner/evidence kinds, so a corrupt template fails at open time
 * with its template named, never as a half-copied process.
 */
export function snapshotTemplateSteps(
  templateId: string,
  steps: readonly TemplateStepInput[],
  effectiveDate: string,
): ProcessStepSnapshot[] {
  parseCivilDate(effectiveDate);
  if (steps.length === 0) {
    throw new ProcessMathError(
      "EMPTY_SNAPSHOT",
      `template ${templateId} carries no steps — add at least one checklist step before opening a process from it`,
    );
  }
  const seen = new Set<number>();
  for (const step of steps) {
    if (!Number.isSafeInteger(step.position) || step.position < 0) {
      throw new ProcessMathError(
        "INVALID_TEMPLATE",
        `template ${templateId} step ${step.id} carries position ${String(step.position)} — positions are whole numbers from 0`,
      );
    }
    if (seen.has(step.position)) {
      throw new ProcessMathError(
        "INVALID_TEMPLATE",
        `template ${templateId} lists position ${step.position} twice — give every step its own position`,
      );
    }
    seen.add(step.position);
    if (!["manager", "hr", "employee", "named_party"].includes(step.ownerKind)) {
      throw new ProcessMathError(
        "INVALID_TEMPLATE",
        `template ${templateId} step ${step.id} names owner ${JSON.stringify(step.ownerKind)} — expect manager, hr, employee, or named_party`,
      );
    }
    if ((step.ownerKind === "named_party") === (step.ownerPartyId === null)) {
      throw new ProcessMathError(
        "INVALID_TEMPLATE",
        `template ${templateId} step ${step.id} pairs owner ${step.ownerKind} with ${step.ownerPartyId === null ? "no" : "a"} party — named_party needs exactly one owner party, other owners need none`,
      );
    }
    if (!["none", "acknowledgement", "attachment"].includes(step.evidenceKind)) {
      throw new ProcessMathError(
        "INVALID_TEMPLATE",
        `template ${templateId} step ${step.id} names evidence ${JSON.stringify(step.evidenceKind)} — expect none, acknowledgement, or attachment`,
      );
    }
    if (typeof step.title !== "string" || step.title.trim().length === 0) {
      throw new ProcessMathError(
        "INVALID_TEMPLATE",
        `template ${templateId} step ${step.id} carries a blank title — name the work before opening a process from it`,
      );
    }
  }
  return [...steps]
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((step) => ({
      templateStepId: step.id,
      position: step.position,
      title: step.title,
      description: step.description,
      ownerKind: step.ownerKind,
      ownerPartyId: step.ownerPartyId,
      dueOn: addOffsetDays(effectiveDate, step.dueOffsetDays),
      required: step.required,
      evidenceKind: step.evidenceKind,
    }));
}

export interface MatchableTemplate {
  readonly id: string;
  /** Null/absent = applies to all. */
  readonly employerSubsidiaryId: string | null;
  readonly departmentId: string | null;
}

/**
 * Resolve the one template covering an employment. Specificity wins (both
 * filters set beats one, one beats none); a tie at the top is refused by
 * name instead of picked arbitrarily. No template is a refusal, never a
 * bare process: an employment event that is always owed a checklist must
 * name the checklist it runs.
 */
export function resolveTemplateForEmployment(
  kind: string,
  templates: readonly MatchableTemplate[],
  employment: { employerSubsidiaryId: string; departmentId: string | null },
): MatchableTemplate {
  const matching = templates.filter(
    (template) =>
      (template.employerSubsidiaryId === null || template.employerSubsidiaryId === employment.employerSubsidiaryId) &&
      (template.departmentId === null || template.departmentId === employment.departmentId),
  );
  if (matching.length === 0) {
    throw new ProcessMathError(
      "NO_TEMPLATE",
      `no active ${kind} template covers this employment — create or activate one in Setup that covers this employer subsidiary and department`,
    );
  }
  const specificity = (template: MatchableTemplate): number =>
    (template.employerSubsidiaryId === null ? 0 : 1) + (template.departmentId === null ? 0 : 1);
  const best = Math.max(...matching.map(specificity));
  const winners = matching.filter((template) => specificity(template) === best);
  if (winners.length > 1) {
    throw new ProcessMathError(
      "AMBIGUOUS_TEMPLATE",
      // Both ids are named (never the kind twice): the operator can tell
      // the two checklists apart and narrow one's filter.
      `${winners.length} active ${kind} templates cover this employment equally (${winners.map((w) => w.id).join(", ")}) — narrow one's applies_to filter so exactly one covers it`,
    );
  }
  return winners[0]!;
}
