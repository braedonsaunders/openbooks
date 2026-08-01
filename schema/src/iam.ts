import { boolean, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/**
 * IAM — role-based access control, ported from the beaconhs iam foundation.
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
 * engine/src/seed-roles.ts; custom roles are created in the admin UI. `key` is
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
    index("app_roles_org").on(t.orgId),
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
  ],
);

/**
 * Cross-tenant access grants — the "one login, many tenants" model. A member
 * (identified by their home `users` row = the login identity) is granted access
 * to another production or isolated preview org, acting there as a specific
 * `users` row in that org.
 *
 * A user always has implicit access to their own home org (no row needed), and
 * to any sandbox of an org they can reach (the acting user is the deterministic
 * rebase of their production users row). Super admins reach every org without a
 * row. This table records the EXPLICIT grants managed in the super-admin console.
 *
 * Sandboxes are separate tenants (their own org row), so the same login moving
 * between production and its sandboxes — or between two production orgs — is the
 * one uniform mechanism: swap the effective org, resolve the acting users row.
 */
export const userOrgAccess = pgTable(
  "user_org_access",
  {
    id: id(),
    /** The login identity being granted access (home users row). */
    memberUserId: uuid("member_user_id").notNull(),
    /** The production or preview org granted. Sandboxes derive access from their parent. */
    orgId: orgRef(),
    /** The users row in `orgId` this member acts as when switched in. */
    actingUserId: uuid("acting_user_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("user_org_access_member_org").on(t.memberUserId, t.orgId),
    index("user_org_access_member").on(t.memberUserId),
    index("user_org_access_org").on(t.orgId),
  ],
);

/**
 * Per-user permission exceptions, layered on top of role-granted permissions.
 * `grant` adds a permission the user's roles don't carry; `deny` removes one
 * they would otherwise have. Resolved in web/lib/authz.ts after the role
 * union — denies win, including against wildcard grants.
 */
export const userPermissionOverrides = pgTable(
  "user_permission_overrides",
  {
    id: id(),
    orgId: orgRef(),
    userId: uuid("user_id").notNull(),
    permission: text("permission").$type<PermissionKey>().notNull(),
    effect: text("effect", { enum: ["grant", "deny"] }).notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("user_permission_overrides_user_permission").on(t.userId, t.permission),
    index("user_permission_overrides_org").on(t.orgId),
  ],
);

// ---------------------------------------------------------------------------
// Foreign keys (SQL, for the integrator's generated migration):
//
// -- ALTER TABLE app_roles                 ADD FOREIGN KEY (org_id)  REFERENCES orgs(id)      ON DELETE CASCADE;
// -- ALTER TABLE role_assignments          ADD FOREIGN KEY (org_id)  REFERENCES orgs(id)      ON DELETE CASCADE;
// -- ALTER TABLE role_assignments          ADD FOREIGN KEY (user_id) REFERENCES users(id)     ON DELETE CASCADE;
// -- ALTER TABLE role_assignments          ADD FOREIGN KEY (role_id) REFERENCES app_roles(id) ON DELETE CASCADE;
// -- ALTER TABLE user_permission_overrides ADD FOREIGN KEY (org_id)  REFERENCES orgs(id)      ON DELETE CASCADE;
// -- ALTER TABLE user_permission_overrides ADD FOREIGN KEY (user_id) REFERENCES users(id)     ON DELETE CASCADE;
// ---------------------------------------------------------------------------
