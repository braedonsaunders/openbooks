/**
 * Scheduling board types: the registry every board type is declared in.
 *
 * A type names the row kind its boards schedule, the capabilities they
 * offer (and through them the features they need), its views and defaults,
 * and the publication policies it allows. Board creation, the Setup board
 * form and its validation read these declarations.
 * The database mirrors each type's row kind and capabilities in
 * openbooks_schedule_board_types and refuses a capability on a board whose
 * type does not declare it. Adding a type adds an entry here, a registry row
 * in a migration, and any capability-specific commands and views.
 *
 * Pure: shared by the engine, the API and the client.
 */
export const SCHEDULE_BOARD_CAPABILITIES = [
  /** People or resources are booked on the board. */
  "bookings",
  /** Recurring shift patterns are assigned to people and generate bookings. */
  "patterns",
  /** Employees request to release, change or swap their own shifts. */
  "shift_requests",
  /** Time-clock attendance is observed against published shifts. */
  "attendance",
  /** Ended shifts with complete attendance may be formally closed. */
  "closing",
  /** Service visits are dispatched to technicians from an unscheduled queue, with live field status. */
  "dispatch",
] as const;
export type ScheduleBoardCapability = (typeof SCHEDULE_BOARD_CAPABILITIES)[number];

export type ScheduleBoardRowKind = "people" | "tasks" | "resources";
export type SchedulePublishPolicy = "live" | "staged";

export interface ScheduleBoardTypeDefinition {
  readonly key: string;
  readonly rowKind: ScheduleBoardRowKind;
  readonly capabilities: readonly ScheduleBoardCapability[];
  /** Views the type offers, the views a new board starts with, and the default view. */
  readonly views: readonly string[];
  readonly defaultViews: readonly string[];
  readonly defaultView: string;
  readonly defaultGrain: "day" | "timed";
  readonly publishPolicies: readonly SchedulePublishPolicy[];
  readonly defaultPublishPolicy: SchedulePublishPolicy;
}

const PEOPLE_VIEWS = ["grid", "targets", "timeline", "calendar"] as const;

export const SCHEDULE_BOARD_TYPES: readonly ScheduleBoardTypeDefinition[] = [
  {
    key: "people",
    rowKind: "people",
    capabilities: ["bookings"],
    views: PEOPLE_VIEWS,
    defaultViews: PEOPLE_VIEWS,
    defaultView: "grid",
    defaultGrain: "day",
    publishPolicies: ["live", "staged"],
    defaultPublishPolicy: "live",
  },
  {
    key: "tasks",
    rowKind: "tasks",
    capabilities: [],
    views: ["gantt", "progress"],
    defaultViews: ["gantt", "progress"],
    defaultView: "gantt",
    defaultGrain: "day",
    publishPolicies: ["live", "staged"],
    defaultPublishPolicy: "live",
  },
  {
    key: "resources",
    rowKind: "resources",
    capabilities: ["bookings"],
    views: PEOPLE_VIEWS,
    defaultViews: PEOPLE_VIEWS,
    defaultView: "grid",
    defaultGrain: "day",
    publishPolicies: ["live", "staged"],
    defaultPublishPolicy: "live",
  },
  {
    key: "shift_roster",
    rowKind: "people",
    capabilities: ["bookings", "patterns", "shift_requests", "attendance", "closing"],
    views: PEOPLE_VIEWS,
    defaultViews: ["timeline", "grid", "calendar"],
    defaultView: "timeline",
    defaultGrain: "timed",
    publishPolicies: ["live", "staged"],
    defaultPublishPolicy: "staged",
  },
  {
    // Dispatch boards publish each assignment at once so technicians see it.
    key: "dispatch",
    rowKind: "people",
    capabilities: ["bookings", "dispatch"],
    views: ["dispatch", "timeline", "grid", "calendar"],
    defaultViews: ["dispatch", "timeline", "calendar"],
    defaultView: "dispatch",
    defaultGrain: "timed",
    publishPolicies: ["live"],
    defaultPublishPolicy: "live",
  },
];

/** Feature switches a capability needs in addition to its board family (Scheduling or Project Scheduling). */
export const SCHEDULE_CAPABILITY_FEATURES: Readonly<
  Record<ScheduleBoardCapability, readonly string[]>
> = {
  bookings: [],
  patterns: [],
  shift_requests: [],
  attendance: ["hrmAttendance"],
  closing: ["hrmAttendance", "hrmShiftClosing"],
  dispatch: ["serviceDispatch"],
};

const BY_KEY = new Map(SCHEDULE_BOARD_TYPES.map((type) => [type.key, type]));

export function scheduleBoardType(key: string): ScheduleBoardTypeDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/** Whether a board's type declares a capability. Unknown types declare none. */
export function boardHasCapability(
  board: { readonly boardType: string },
  capability: ScheduleBoardCapability,
): boolean {
  return BY_KEY.get(board.boardType)?.capabilities.includes(capability) ?? false;
}

/**
 * Feature switches a board of this type needs before it is listed or opened
 * at all: the features of every capability beyond bookings that the type is
 * built around. Shift roster boards stay usable without attendance; a
 * dispatch board exists only for service dispatch.
 */
export function boardTypeRequiredFeatures(boardType: string): readonly string[] {
  return BY_KEY.get(boardType)?.capabilities.includes("dispatch")
    ? SCHEDULE_CAPABILITY_FEATURES.dispatch
    : [];
}

/** The board types that schedule a row kind, in registry order. */
export function boardTypesFor(
  rowKind: ScheduleBoardRowKind,
): readonly ScheduleBoardTypeDefinition[] {
  return SCHEDULE_BOARD_TYPES.filter((type) => type.rowKind === rowKind);
}
