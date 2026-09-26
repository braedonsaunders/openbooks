import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/** Lock state is book/module/entity scoped and independent of period identity.
 * A null subsidiary is the tenant-wide default; a subsidiary-specific row
 * overrides it for that entity. */
export const periodLocks = pgTable(
  "period_locks",
  {
    id: id(),
    orgId: orgRef(),
    periodId: uuid("period_id").notNull(),
    bookId: uuid("book_id").notNull(),
    subsidiaryId: uuid("subsidiary_id"),
    module: text("module", {
      enum: ["ar", "ap", "banking", "assets", "tax", "gl"],
    }).notNull(),
    state: text("state", { enum: ["open", "soft_closed", "closed"] })
      .notNull()
      .default("open"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: uuid("locked_by"),
    reason: text("reason"),
    reopenExpiresAt: timestamp("reopen_expires_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    ...auditColumns,
  },
  (t) => [
    unique("period_locks_scope")
      .on(t.orgId, t.periodId, t.bookId, t.subsidiaryId, t.module)
      .nullsNotDistinct(),
    index("period_locks_lookup").on(
      t.orgId,
      t.periodId,
      t.bookId,
      t.module,
      t.subsidiaryId,
    ),
  ],
);

export const closeRuns = pgTable(
  "close_runs",
  {
    id: id(),
    orgId: orgRef(),
    periodId: uuid("period_id").notNull(),
    bookId: uuid("book_id").notNull(),
    blueprintId: uuid("blueprint_id").notNull(),
    reportingPackageId: uuid("reporting_package_id"),
    status: text("status", {
      enum: [
        "draft",
        "in_progress",
        "review",
        "approved",
        "closed",
        "published",
        "cancelled",
      ],
    })
      .notNull()
      .default("draft"),
    currentStage: text("current_stage", {
      enum: ["scope", "readiness", "execute", "review", "lock", "publish"],
    })
      .notNull()
      .default("scope"),
    targetCloseDate: date("target_close_date").notNull(),
    scope: jsonb("scope").notNull().default({}),
    readinessScore: integer("readiness_score").notNull().default(0),
    dataFingerprint: text("data_fingerprint"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    startedBy: uuid("started_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by"),
    /** Immutable point-in-time audit package frozen at publication. */
    binderSnapshot: jsonb("binder_snapshot"),
    binderHash: text("binder_hash"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("close_runs_period_book").on(t.orgId, t.periodId, t.bookId),
    index("close_runs_org_status").on(t.orgId, t.status, t.targetCloseDate),
  ],
);
