/**
 * Assignment conflict rules for the dispatch board. A proposed booking of a
 * technician for a visit is checked against the technician's day: other
 * bookings on any board, recorded leave, held qualifications, the person's
 * work schedule and working hours, and the visit's arrival window and
 * response target.
 *
 * Blocking conflicts (overlap, leave, missing qualification) can never be
 * overridden; the booking ledger refuses them again in storage. Warnings
 * (outside working hours, a non-working day, over scheduled hours, outside
 * the promised arrival window, after the response target) need an explicit
 * override reason, which is recorded with the assignment.
 *
 * Pure: shared by the engine, the API and the client preview.
 */
export type ConflictCode =
  | "overlap"
  | "leave"
  | "qualification"
  | "non_working_day"
  | "outside_working_hours"
  | "over_capacity"
  | "outside_arrival_window"
  | "after_response_target";

export interface AssignmentConflict {
  readonly code: ConflictCode;
  readonly severity: "block" | "warn";
  /** Operator-facing explanation in English; the client localizes by code and detail. */
  readonly message: string;
  readonly detail: Readonly<Record<string, string | number | null>>;
}

export interface TechnicianDayFacts {
  /** Live bookings the technician holds on any board that day (other than the ones being moved). */
  readonly bookings: readonly {
    readonly id: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly label: string;
  }[];
  /** Recorded leave on the dates the booking covers. */
  readonly absences: readonly { readonly onDate: string; readonly leaveTypeName: string }[];
  /** Qualification types verified and valid over the whole booking. */
  readonly qualificationTypeIds: ReadonlySet<string>;
  /** The person's work schedule for the day: false when it is a day off, null when no schedule applies. */
  readonly scheduledDay: boolean | null;
  /** Scheduled hours for the day as a decimal string, or null when unknown. */
  readonly scheduledHours: string | null;
  /** Working hours for the day (the board's working day), as instants. */
  readonly workingWindow: { readonly startsAt: string; readonly endsAt: string } | null;
}

export interface AssignmentProposal {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly requiredQualificationTypeIds: readonly string[];
  readonly qualificationNames?: Readonly<Record<string, string>>;
  readonly arrivalWindow: { readonly startsAt: string; readonly endsAt: string } | null;
  readonly responseDueAt: string | null;
}

function overlaps(
  a: { startsAt: string; endsAt: string },
  b: { startsAt: string; endsAt: string },
): boolean {
  return (
    Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt)
  );
}

/** Whole minutes a span lasts. */
export function spanMinutes(span: { startsAt: string; endsAt: string }): number {
  return Math.round((Date.parse(span.endsAt) - Date.parse(span.startsAt)) / 60000);
}

/** Minutes in a decimal hours string ("7.5000" → 450), exact to the minute. */
export function hoursToMinutes(hours: string): number | null {
  const match = /^(\d{1,4})(?:\.(\d{1,4}))?$/.exec(hours.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(4, "0");
  // Hours carry four decimal places; minutes round half up from ten-thousandths of an hour.
  const tenThousandths = whole * 10000 + Number(fraction);
  return Math.floor((tenThousandths * 60 + 5000) / 10000);
}

/** Every conflict the proposed booking meets, blocking first. */
export function evaluateAssignment(
  proposal: AssignmentProposal,
  facts: TechnicianDayFacts,
): AssignmentConflict[] {
  const out: AssignmentConflict[] = [];
  if (!(Date.parse(proposal.endsAt) > Date.parse(proposal.startsAt))) {
    out.push({
      code: "overlap",
      severity: "block",
      message: "The booking must end after it starts.",
      detail: {},
    });
    return out;
  }
  for (const booking of facts.bookings) {
    if (overlaps(proposal, booking)) {
      out.push({
        code: "overlap",
        severity: "block",
        message: `Already booked for ${booking.label}.`,
        detail: {
          bookingId: booking.id,
          label: booking.label,
          startsAt: booking.startsAt,
          endsAt: booking.endsAt,
        },
      });
    }
  }
  for (const absence of facts.absences) {
    out.push({
      code: "leave",
      severity: "block",
      message: `On ${absence.leaveTypeName} leave on ${absence.onDate}.`,
      detail: { onDate: absence.onDate, leaveType: absence.leaveTypeName },
    });
  }
  for (const required of proposal.requiredQualificationTypeIds) {
    if (!facts.qualificationTypeIds.has(required)) {
      const name = proposal.qualificationNames?.[required] ?? required;
      out.push({
        code: "qualification",
        severity: "block",
        message: `Does not hold a verified ${name} qualification for this visit.`,
        detail: { qualificationTypeId: required, qualification: name },
      });
    }
  }
  if (facts.scheduledDay === false) {
    out.push({
      code: "non_working_day",
      severity: "warn",
      message: "This is a day off in the person's work schedule.",
      detail: {},
    });
  }
  if (
    facts.workingWindow &&
    (Date.parse(proposal.startsAt) < Date.parse(facts.workingWindow.startsAt) ||
      Date.parse(proposal.endsAt) > Date.parse(facts.workingWindow.endsAt))
  ) {
    out.push({
      code: "outside_working_hours",
      severity: "warn",
      message: "The visit falls outside working hours.",
      detail: {
        workStartsAt: facts.workingWindow.startsAt,
        workEndsAt: facts.workingWindow.endsAt,
      },
    });
  }
  const capacity = facts.scheduledHours === null ? null : hoursToMinutes(facts.scheduledHours);
  if (capacity !== null && capacity > 0) {
    const booked =
      facts.bookings.reduce((sum, booking) => sum + spanMinutes(booking), 0) +
      spanMinutes(proposal);
    if (booked > capacity) {
      out.push({
        code: "over_capacity",
        severity: "warn",
        message: `Books ${booked} minutes against ${capacity} scheduled minutes.`,
        detail: { bookedMinutes: booked, scheduledMinutes: capacity },
      });
    }
  }
  if (
    proposal.arrivalWindow &&
    (Date.parse(proposal.startsAt) < Date.parse(proposal.arrivalWindow.startsAt) ||
      Date.parse(proposal.startsAt) > Date.parse(proposal.arrivalWindow.endsAt))
  ) {
    out.push({
      code: "outside_arrival_window",
      severity: "warn",
      message: "The visit starts outside the arrival window promised to the customer.",
      detail: {
        windowStartsAt: proposal.arrivalWindow.startsAt,
        windowEndsAt: proposal.arrivalWindow.endsAt,
      },
    });
  }
  if (
    proposal.responseDueAt &&
    Date.parse(proposal.startsAt) > Date.parse(proposal.responseDueAt)
  ) {
    out.push({
      code: "after_response_target",
      severity: "warn",
      message: "The visit starts after its response target.",
      detail: { responseDueAt: proposal.responseDueAt },
    });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1));
}

/** Blocking conflicts refuse; warnings need an override reason. */
export function assignmentDecision(
  conflicts: readonly AssignmentConflict[],
  overrideReason: string | null,
):
  | { ok: true; warnings: AssignmentConflict[] }
  | { ok: false; blocking: boolean; conflicts: AssignmentConflict[] } {
  const blocking = conflicts.filter((conflict) => conflict.severity === "block");
  if (blocking.length) return { ok: false, blocking: true, conflicts: [...conflicts] };
  const warnings = conflicts.filter((conflict) => conflict.severity === "warn");
  if (warnings.length && !overrideReason?.trim())
    return { ok: false, blocking: false, conflicts: warnings };
  return { ok: true, warnings };
}
