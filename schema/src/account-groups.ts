import { pgTable, text, integer, boolean, jsonb, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";
import { id, orgRef, auditColumns } from "./helpers";

/**
 * Account Groups — a native, reporting-oriented classification layer over the
 * chart of accounts, orthogonal to the parent/child hierarchy (which is
 * structural) and to account `type` (which is fixed by the kernel).
 *
 * The innovation is a RULE + PIN hybrid: each group carries an optional
 * auto-classification `match` rule (by account number prefix, name pattern, or
 * account type); an account's group within a `dimension` is the first group
 * (by sort_order) whose rule matches, UNLESS it's explicitly pinned via
 * `account_group_members`. So you get instant, zero-tagging classification with
 * surgical per-account override — and any report can slice the GL by a grouping
 * dimension the way it slices by department. `dimension` names the grouping set
 * (e.g. "cost_pool"), so multiple independent groupings coexist.
 */

export type AccountGroupMatch = {
  /** Account whose `number` starts with any of these (e.g. "5", "62"). */
  numberPrefixes?: string[];
  /** Case-insensitive regex source tested against the account name. */
  namePattern?: string;
  /** Account `type` values the group claims (e.g. ["cogs"]). */
  accountTypes?: string[];
};

export const accountGroups = pgTable(
  "account_groups",
  {
    id: id(),
    orgId: orgRef(),
    /** The grouping set this group belongs to, e.g. "cost_pool". */
    dimension: text("dimension").notNull(),
    /** Stable slug, unique within (org, dimension). */
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** Hex colour for charts/badges. */
    color: text("color"),
    /** Lower sorts first — also the rule-match precedence order. */
    sortOrder: integer("sort_order").notNull().default(0),
    /** Auto-classification rule; empty {} never matches (see isCatchAll). */
    match: jsonb("match").$type<AccountGroupMatch>().notNull().default({}),
    /** Claims every account not matched by an earlier group in the dimension. */
    isCatchAll: boolean("is_catch_all").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    custom: jsonb("custom").notNull().default({}),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("account_groups_org_dim_key").on(t.orgId, t.dimension, t.key),
    index("account_groups_org_dim").on(t.orgId, t.dimension),
  ],
);

/** Explicit account→group pin, overriding rule matching within the dimension. */
export const accountGroupMembers = pgTable(
  "account_group_members",
  {
    id: id(),
    orgId: orgRef(),
    groupId: uuid("group_id").notNull(),
    accountId: uuid("account_id").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("account_group_members_group_account").on(t.groupId, t.accountId),
    index("account_group_members_account").on(t.accountId),
  ],
);
