import { pgSchema, uuid, text, jsonb, timestamp, bigint, integer, primaryKey } from "drizzle-orm/pg-core";

// Administrative recovery evidence must survive removal of a tenant. No row
// references orgs/users, and normal runtime roles have no table privileges.
const retirement = pgSchema("tenant_retirement");
export const tenantRetirementRuns = retirement.table("runs", {
  id: uuid("id").primaryKey(),
  planDigest: text("plan_digest").notNull(),
  catalogDigest: text("catalog_digest").notNull(),
  databaseIdentity: jsonb("database_identity").notNull(),
  retainIds: uuid("retain_ids").array().notNull(),
  targetIds: uuid("target_ids").array().notNull(),
  actorId: uuid("actor_id").notNull(),
  reason: text("reason").notNull(),
  recoveryEvidence: jsonb("recovery_evidence").notNull(),
  reviewedState: jsonb("reviewed_state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const tenantRetirementFences = retirement.table("fences", {
  tenantId: uuid("tenant_id").primaryKey(),
  runId: uuid("run_id").references(() => tenantRetirementRuns.id),
  state: text("state").notNull().default("active"),
  receipt: jsonb("receipt"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const tenantRetirementDeleteAuthorities = retirement.table("delete_authorities", {
  transactionId: bigint("transaction_id", { mode: "bigint" }).notNull(),
  backendPid: integer("backend_pid").notNull(),
  tenantId: uuid("tenant_id").notNull().references(() => tenantRetirementFences.tenantId),
  runId: uuid("run_id").notNull().references(() => tenantRetirementRuns.id),
  loginName: text("login_name").notNull(),
}, t => [primaryKey({ columns: [t.transactionId] })]);
export const tenantRetirementStorageManifests = retirement.table("storage_manifests", {
  runId: uuid("run_id").notNull().references(() => tenantRetirementRuns.id),
  tenantId: uuid("tenant_id").notNull(),
  manifest: jsonb("manifest").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.runId, t.tenantId] })]);

export const tenantRetirementEvents = retirement.table("events", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  runId: uuid("run_id").notNull().references(() => tenantRetirementRuns.id),
  tenantId: uuid("tenant_id"),
  kind: text("kind").notNull(),
  loginName: text("login_name").notNull(),
  detail: jsonb("detail").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
