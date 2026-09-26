import { boolean, foreignKey, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";
import { orgs } from "./core";
import { users } from "./extension";

/**
 * IAM — role-based access control.
 *
 * Permission keys are strings: `module.action[.qualifier]`, e.g. `gl.post`,
 * `ap.approve`, `admin.roles.manage`. Wildcards are supported at check time
 * (`ap.*` grants any `ap.x`). The catalogue of built-in keys and the
 * wildcard-matching logic live in web/lib/permissions.ts; the DB stores
 * whatever keys a role was saved with.
 */
export type PermissionKey = string;

/**
 * Org-scoped roles: named bundles of permission keys. Built-in roles
 * (admin/controller/accountant/approver/viewer) are seeded per org by
 * engine/src/provisioning/seed-roles.ts; custom roles are created in the admin UI. `key` is
 * the stable identifier used by workflow targets and policy evaluation.
 *
 * Named app_roles (not roles) to stay clear of Postgres's pg_roles and any
 * future DB-level role work.
 */
export const appRoles = pgTable(
  "app_roles",
  {
    id: id(),
    orgId: orgRef(),
    key: text("key").notNull(), // "controller", "ap_clerk", custom slugs
    name: text("name").notNull(),
    description: text("description"),
    isBuiltIn: boolean("is_built_in").notNull().default(false),
    permissions: jsonb("permissions").$type<PermissionKey[]>().notNull().default([]),
    /**
     * Subsidiary visibility for holders of this role — `{mode:'all'}`,
     * `{mode:'subtree', subsidiaryId}`, or `{mode:'list', subsidiaryIds}`.
     * A user's allowed set is the UNION across their roles; resolved in
     * web/lib/authz.ts and enforced as a query filter (never a tenancy wall).
     */
    subsidiaryRestriction: jsonb("subsidiary_restriction")
      .$type<import("./subsidiaries").SubsidiaryRestriction>()
      .notNull()
      .default({ mode: "all" }),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("app_roles_org_key").on(t.orgId, t.key),
    uniqueIndex("app_roles_org_id_id_unique").on(t.orgId, t.id),
    index("app_roles_org").on(t.orgId),
    foreignKey({ name: "app_roles_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }).onDelete("cascade"),
  ],
);

/**
 * User ↔ role links. A user may hold any number of roles; their effective
 * permissions are the union of every assigned role's keys. Active users must
 * receive at least one explicit assignment before they can access the product.
 */
export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: id(),
    orgId: orgRef(),
    userId: uuid("user_id").notNull(),
    roleId: uuid("role_id").notNull(),
    ...auditColumns,
  },
  (t) => [
    // One row per user/role — duplicates would be meaningless and make
    // unassign ambiguous. Also the ON CONFLICT target for idempotent seeding.
    uniqueIndex("role_assignments_org_user_role").on(t.orgId, t.userId, t.roleId),
    index("role_assignments_user").on(t.userId),
    index("role_assignments_role").on(t.roleId),
    foreignKey({ name: "role_assignments_org_id_fkey", columns: [t.orgId], foreignColumns: [orgs.id] }).onDelete("cascade"),
    foreignKey({ name: "role_assignments_user_id_fkey", columns: [t.orgId, t.userId], foreignColumns: [users.orgId, users.id] }).onDelete("cascade"),
    foreignKey({ name: "role_assignments_role_id_fkey", columns: [t.orgId, t.roleId], foreignColumns: [appRoles.orgId, appRoles.id] }),
  ],
);
