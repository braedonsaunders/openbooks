/**
 * Service lifecycles. The database guard mirrors these transitions; the
 * service layer checks them first so a refusal names the remedy.
 *
 * Pure: shared by the engine, the API and the client.
 */
export const VISIT_STATUSES = [
  "unscheduled",
  "scheduled",
  "dispatched",
  "en_route",
  "on_site",
  "completed",
  "unable_to_complete",
  "cancelled",
] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];

export const JOB_STATUSES = ["open", "completed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const REQUEST_STATUSES = [
  "new",
  "assessment_scheduled",
  "assessed",
  "quoted",
  "converted",
  "declined",
  "cancelled",
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const SERVICE_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type ServicePriority = (typeof SERVICE_PRIORITIES)[number];

/** Who moves a visit: the assigned technician, or office staff acting on the board. */
export type VisitActorMode = "technician" | "staff";

const VISIT_TRANSITIONS: Readonly<Record<VisitStatus, readonly VisitStatus[]>> = {
  unscheduled: ["scheduled", "cancelled"],
  scheduled: ["unscheduled", "dispatched", "en_route", "cancelled"],
  dispatched: ["unscheduled", "scheduled", "en_route", "cancelled"],
  en_route: ["on_site", "unable_to_complete"],
  on_site: ["completed", "unable_to_complete"],
  // Reopened only when a completion review sends the visit back.
  completed: ["on_site"],
  unable_to_complete: [],
  cancelled: [],
};

/** Field statuses a technician sets from My visits. */
const TECHNICIAN_TARGETS: ReadonlySet<VisitStatus> = new Set([
  "en_route",
  "on_site",
  "completed",
  "unable_to_complete",
]);

export function visitTransitionAllowed(from: VisitStatus, to: VisitStatus): boolean {
  return VISIT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Whether `mode` may move a visit from `from` to `to` (reopening is the review's, never a direct move). */
export function visitTransitionPermitted(
  from: VisitStatus,
  to: VisitStatus,
  mode: VisitActorMode,
): boolean {
  if (!visitTransitionAllowed(from, to)) return false;
  if (from === "completed") return false;
  if (mode === "technician") return TECHNICIAN_TARGETS.has(to);
  return true;
}

/** The field statuses the actor may move a visit to next, in lifecycle order. */
export function nextVisitStatuses(from: VisitStatus, mode: VisitActorMode): VisitStatus[] {
  return VISIT_STATUSES.filter(
    (to) => to !== "scheduled" && to !== "unscheduled" && visitTransitionPermitted(from, to, mode),
  );
}

/** A visit holding technicians on the board: booked and not yet finished. */
export function visitIsBooked(status: VisitStatus): boolean {
  return (
    status === "scheduled" ||
    status === "dispatched" ||
    status === "en_route" ||
    status === "on_site"
  );
}

/** A visit whose bookings may still move: nobody has left for it yet. */
export function visitIsReschedulable(status: VisitStatus): boolean {
  return status === "unscheduled" || status === "scheduled" || status === "dispatched";
}

export function visitIsFinished(status: VisitStatus): boolean {
  return status === "completed" || status === "unable_to_complete" || status === "cancelled";
}

const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  open: ["completed", "cancelled"],
  completed: ["open"],
  cancelled: [],
};

export function jobTransitionAllowed(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from]?.includes(to) ?? false;
}

const REQUEST_TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  new: ["assessment_scheduled", "assessed", "quoted", "converted", "declined", "cancelled"],
  assessment_scheduled: ["new", "assessed", "quoted", "converted", "declined", "cancelled"],
  assessed: ["quoted", "converted", "declined", "cancelled"],
  quoted: ["assessed", "converted", "declined", "cancelled"],
  converted: [],
  declined: [],
  cancelled: [],
};

export function requestTransitionAllowed(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[from]?.includes(to) ?? false;
}

export function requestIsOpen(status: RequestStatus): boolean {
  return status !== "converted" && status !== "declined" && status !== "cancelled";
}

/** Response target in hours by priority, from the policy in force; null when the policy sets none. */
export function responseHours(
  policy: {
    readonly urgentResponseHours: number | null;
    readonly highResponseHours: number | null;
    readonly normalResponseHours: number | null;
    readonly lowResponseHours: number | null;
  },
  priority: ServicePriority,
): number | null {
  return priority === "urgent"
    ? policy.urgentResponseHours
    : priority === "high"
      ? policy.highResponseHours
      : priority === "normal"
        ? policy.normalResponseHours
        : policy.lowResponseHours;
}

/** Sort weight for the unscheduled queue: urgent first. */
export function priorityRank(priority: ServicePriority): number {
  return priority === "urgent" ? 0 : priority === "high" ? 1 : priority === "normal" ? 2 : 3;
}
