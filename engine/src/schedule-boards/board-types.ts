/**
 * Scheduling board types: the registry every board type is declared in.
 *
 * A type names the row kind its boards schedule, the capabilities they
 * offer, the features those capabilities need, its views and defaults, the
 * publication policies it allows and the board settings sections it shows.
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
  /** Publication may be governed by an independent approver from an effective date. */
  "governed_publication",
  /** Time-clock attendance is observed against published shifts. */
  "attendance",
  /** Ended shifts with complete attendance may be formally closed. */
  "closing",
] as const;
export type ScheduleBoardCapability = (typeof SCHEDULE_BOARD_CAPABILITIES)[number];

export type ScheduleBoardRowKind = "people" | "tasks" | "resources";
export type SchedulePublishPolicy = "live" | "staged" | "governed";

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
  /** Board settings sections (Setup form section keys) shown for the type. */
  readonly settingsSections: readonly string[];
  /** Message keys under the `scheduling.boardTypes.<key>` namespace. */
  readonly labelKey: string;
  readonly descriptionKey: string;
}

const PEOPLE_VIEWS = ["grid", "targets", "timeline", "calendar"] as const;
const STANDARD_SETTINGS = ["identity", "scope", "display", "booking", "automation"] as const;

export const SCHEDULE_BOARD_TYPES: readonly ScheduleBoardTypeDefinition[] = [
  {
    key: "people", rowKind: "people", capabilities: ["bookings"], views: PEOPLE_VIEWS, defaultViews: PEOPLE_VIEWS, defaultView: "grid", defaultGrain: "day",
    publishPolicies: ["live", "staged"], defaultPublishPolicy: "live", settingsSections: STANDARD_SETTINGS,
    labelKey: "boardTypes.people.label", descriptionKey: "boardTypes.people.description",
  },
  {
    key: "tasks", rowKind: "tasks", capabilities: [], views: ["gantt", "progress"], defaultViews: ["gantt", "progress"], defaultView: "gantt", defaultGrain: "day",
    publishPolicies: ["live"], defaultPublishPolicy: "live", settingsSections: ["identity", "scope", "display"],
    labelKey: "boardTypes.tasks.label", descriptionKey: "boardTypes.tasks.description",
  },
  {
    key: "resources", rowKind: "resources", capabilities: ["bookings"], views: PEOPLE_VIEWS, defaultViews: PEOPLE_VIEWS, defaultView: "grid", defaultGrain: "day",
    publishPolicies: ["live", "staged"], defaultPublishPolicy: "live", settingsSections: ["identity", "scope", "display", "booking"],
    labelKey: "boardTypes.resources.label", descriptionKey: "boardTypes.resources.description",
  },
  {
    key: "shift_roster", rowKind: "people",
    capabilities: ["bookings", "patterns", "shift_requests", "governed_publication", "attendance", "closing"],
    views: PEOPLE_VIEWS, defaultViews: ["timeline", "grid", "calendar"], defaultView: "timeline", defaultGrain: "timed",
    publishPolicies: ["live", "staged", "governed"], defaultPublishPolicy: "staged",
    settingsSections: [...STANDARD_SETTINGS, "roster"],
    labelKey: "boardTypes.shift_roster.label", descriptionKey: "boardTypes.shift_roster.description",
  },
];

/** Feature switches a capability needs in addition to its board family (Scheduling or Project Scheduling). */
export const SCHEDULE_CAPABILITY_FEATURES: Readonly<Record<ScheduleBoardCapability, readonly string[]>> = {
  bookings: [],
  patterns: [],
  shift_requests: [],
  governed_publication: [],
  attendance: ["hrmAttendance"],
  closing: ["hrmAttendance", "hrmShiftClosing"],
};

const BY_KEY = new Map(SCHEDULE_BOARD_TYPES.map((type) => [type.key, type]));

export function scheduleBoardType(key: string): ScheduleBoardTypeDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/** Whether a board's type declares a capability. Unknown types declare none. */
export function boardHasCapability(board: { readonly boardType: string }, capability: ScheduleBoardCapability): boolean {
  return BY_KEY.get(board.boardType)?.capabilities.includes(capability) ?? false;
}

/** The board types that schedule a row kind, in registry order. */
export function boardTypesFor(rowKind: ScheduleBoardRowKind): readonly ScheduleBoardTypeDefinition[] {
  return SCHEDULE_BOARD_TYPES.filter((type) => type.rowKind === rowKind);
}
