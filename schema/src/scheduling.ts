import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, id, money, orgRef } from "./helpers";

/**
 * Project scheduling — critical-path planning over the existing work breakdown.
 *
 * The scheduled activity IS `project_tasks`. Its scheduling columns are added
 * there (see the 0064 migration) rather than in a parallel `schedule_tasks`
 * table, because a task already carries the estimate that time entries post
 * against; splitting the plan from the WBS would create two answers to "what
 * work is on this job".
 *
 * Everything in this file is planning data. It never posts to the ledger, and
 * disabling the Project Scheduling feature leaves every row intact.
 */

/**
 * A working calendar: which weekdays are workdays, plus dated exceptions.
 * `working_days` is keyed '0'..'6' (Sunday..Saturday) so it round-trips
 * directly into the scheduling engine's calendar contract.
 */
export const scheduleCalendars = pgTable(
  "schedule_calendars",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id"),
    name: text("name").notNull(),
    description: text("description"),
    isDefault: boolean("is_default").notNull().default(false),
    workingDays: jsonb("working_days")
      .$type<Record<string, boolean>>()
      .notNull()
      .default({ "0": false, "1": true, "2": true, "3": true, "4": true, "5": true, "6": false }),
    /** Non-working exception dates (statutory holidays, shutdowns), ISO strings. */
    holidays: jsonb("holidays").$type<string[]>().notNull().default([]),
    shiftStartMinutes: integer("shift_start_minutes").notNull().default(480),
    shiftEndMinutes: integer("shift_end_minutes").notNull().default(1020),
    ...auditColumns,
  },
  (t) => [
    index("schedule_calendars_org").on(t.orgId, t.projectId),
  ],
);

/**
 * A schedulable capacity: a person, crew, machine, or subcontractor.
 * `capacity_per_day` and assignment `units` share one scale (1 = one full-time
 * unit) so overallocation is a plain comparison.
 */
export const scheduleResources = pgTable(
  "schedule_resources",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id"),
    calendarId: uuid("calendar_id"),
    name: text("name").notNull(),
    role: text("role"),
    kind: text("kind", { enum: ["labor", "crew", "equipment", "subcontractor"] })
      .notNull()
      .default("crew"),
    color: text("color"),
    /** Optional link to the party (employee/vendor) this resource represents. */
    partyId: uuid("party_id"),
    /** Optional link to a tracked equipment asset. */
    equipmentId: uuid("equipment_id"),
    defaultUnits: numeric("default_units", { precision: 9, scale: 4 }).notNull().default("1"),
    capacityPerDay: numeric("capacity_per_day", { precision: 9, scale: 4 }).notNull().default("1"),
    /** Planning rate only — never a posting rate. Actual cost comes from payroll. */
    costRate: money("cost_rate"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    index("schedule_resources_org").on(t.orgId, t.projectId),
  ],
);

/** One resource booked onto one task at `units` of capacity per working day. */
export const scheduleTaskAssignments = pgTable(
  "schedule_task_assignments",
  {
    id: id(),
    orgId: orgRef(),
    taskId: uuid("task_id").notNull(),
    resourceId: uuid("resource_id").notNull(),
    units: numeric("units", { precision: 9, scale: 4 }).notNull().default("1"),
    role: text("role"),
    ...auditColumns,
  },
  (t) => [
    index("schedule_task_assignments_task").on(t.orgId, t.taskId),
    index("schedule_task_assignments_resource").on(t.orgId, t.resourceId),
    // One booking per resource per task; change the units, don't stack rows.
    unique("schedule_task_assignments_unique").on(t.taskId, t.resourceId),
  ],
);

/**
 * Typed logic between two activities. `lag_days` is positive for lag and
 * negative for lead. Cycles are rejected at the service boundary — a loop makes
 * the critical path undefined for the whole plan.
 */
export const scheduleDependencies = pgTable(
  "schedule_dependencies",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    predecessorId: uuid("predecessor_id").notNull(),
    successorId: uuid("successor_id").notNull(),
    type: text("type", { enum: ["FS", "SS", "FF", "SF"] })
      .notNull()
      .default("FS"),
    lagDays: integer("lag_days").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    index("schedule_dependencies_project").on(t.orgId, t.projectId),
    index("schedule_dependencies_predecessor").on(t.predecessorId),
    index("schedule_dependencies_successor").on(t.successorId),
    unique("schedule_dependencies_unique").on(t.predecessorId, t.successorId),
  ],
);

/**
 * A frozen copy of the plan the current schedule is measured against.
 * Baselines are immutable once captured: re-baselining creates a new one so
 * the variance history a project was managed by stays reconstructable.
 */
export const scheduleBaselines = pgTable(
  "schedule_baselines",
  {
    id: id(),
    orgId: orgRef(),
    projectId: uuid("project_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind", { enum: ["primary", "secondary", "tertiary", "snapshot", "custom"] })
      .notNull()
      .default("snapshot"),
    isPrimary: boolean("is_primary").notNull().default(false),
    ...auditColumns,
  },
  (t) => [
    index("schedule_baselines_project").on(t.orgId, t.projectId),
  ],
);

export const scheduleBaselineTasks = pgTable(
  "schedule_baseline_tasks",
  {
    id: id(),
    orgId: orgRef(),
    baselineId: uuid("baseline_id").notNull(),
    taskId: uuid("task_id").notNull(),
    /** Denormalized so a baseline still reads correctly after a task is deleted. */
    taskName: text("task_name").notNull(),
    startDate: date("start_date"),
    endDate: date("end_date"),
    duration: integer("duration").notNull().default(0),
    ...auditColumns,
  },
  (t) => [
    index("schedule_baseline_tasks_baseline").on(t.orgId, t.baselineId),
    unique("schedule_baseline_tasks_unique").on(t.baselineId, t.taskId),
  ],
);
