import { sql } from "drizzle-orm";
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

/**
 * One product-owned default group. These are starting classification policy,
 * not the model: provisioning inserts the missing ones for a new org and
 * never touches an existing row, so a tenant edit always wins. The forward
 * migration that backfills pre-existing orgs carries a frozen copy of these
 * literals and is insert-missing too; this constant is the live source of
 * truth for every future seed.
 */
export interface DefaultAccountGroup {
  dimension: "cost_pool" | "burden";
  key: string;
  name: string;
  color: string;
  sortOrder: number;
  match: AccountGroupMatch;
  isCatchAll: boolean;
}

/**
 * The `cost_pool` dimension used by the True Cost report. `direct_labor`
 * names the labour accounts True Cost excludes from burden; `other` is the
 * catch-all that claims every account no earlier rule matches.
 */
export const DEFAULT_COST_POOL_GROUPS: DefaultAccountGroup[] = [
  { dimension: "cost_pool", key: "direct_cost", name: "Direct Cost", color: "#0d9488", sortOrder: 10, match: { accountTypes: ["cogs"] }, isCatchAll: false },
  { dimension: "cost_pool", key: "direct_labor", name: "Direct Labor", color: "#0ea5e9", sortOrder: 20, match: { namePattern: "\\b(wage|wages|labour|labor|payroll|salary|salaries|hourly|foreman|crew|journeyman|apprentice)\\b" }, isCatchAll: false },
  { dimension: "cost_pool", key: "overhead", name: "Overhead", color: "#8b5cf6", sortOrder: 30, match: { namePattern: "overhead|indirect|rent|lease|utilit|hydro|electric|gas|telephone|internet|deprec|amort|repair|maintenance|supplies|shop|vehicle|fuel|equipment|tools|freight|training|safety|uniform|licens|permit|dues|subscription|software|bank charge|interest" }, isCatchAll: false },
  { dimension: "cost_pool", key: "g_and_a", name: "G&A", color: "#f59e0b", sortOrder: 40, match: { namePattern: "admin|administrat|executive|office|professional fee|accounting|legal|management|rrsp|benefit|insurance|human resource" }, isCatchAll: false },
  { dimension: "cost_pool", key: "other", name: "Other", color: "#94a3b8", sortOrder: 90, match: {}, isCatchAll: true },
];

/**
 * Burden categories for the True Cost rate engine. Classifies OVERHEAD-type
 * expense accounts into rate-composition categories; deliberately NO
 * catch-all — accounts with spend that match no category surface as
 * "Unassigned" on the dashboard, exactly like the classifier.
 */
export const DEFAULT_BURDEN_GROUPS: DefaultAccountGroup[] = [
  { dimension: "burden", key: "facilities", name: "Facilities", color: "#f59e0b", sortOrder: 10, match: { namePattern: "rent|property tax|building|premises|heat|hydro|utilit|electric power|water|waste|janitor|snow" }, isCatchAll: false },
  { dimension: "burden", key: "admin_wages", name: "Admin & Salaries", color: "#3b82f6", sortOrder: 20, match: { namePattern: "office wages|management salar|executive salar|bonus|profit sharing|rrsp|ipp |severance|stat(utory)? holiday.*admin|short term disability|admin.*(wage|salar)" }, isCatchAll: false },
  { dimension: "burden", key: "insurance", name: "Insurance", color: "#ef4444", sortOrder: 30, match: { namePattern: "insurance" }, isCatchAll: false },
  { dimension: "burden", key: "it_software", name: "IT & Communications", color: "#8b5cf6", sortOrder: 40, match: { namePattern: "software|computer|communications|telephone|internet|website|it services" }, isCatchAll: false },
  { dimension: "burden", key: "fleet_equipment", name: "Fleet & Equipment", color: "#10b981", sortOrder: 50, match: { namePattern: "vehicle|truck|fleet|fuel|equipment|deprec|amort|tenant improvement|r&m|repairs" }, isCatchAll: false },
  { dimension: "burden", key: "professional", name: "Professional Fees", color: "#06b6d4", sortOrder: 60, match: { namePattern: "accounting|legal|consult|professional fee|audit" }, isCatchAll: false },
  { dimension: "burden", key: "people_safety", name: "People & Safety", color: "#ec4899", sortOrder: 70, match: { namePattern: "ppe|safety|training|weld testing|recruit|membership|dues|permit|codes|meals|entertainment|promotional|travel|uniform" }, isCatchAll: false },
  { dimension: "burden", key: "financial", name: "Financial", color: "#64748b", sortOrder: 80, match: { namePattern: "bank fee|interest|bad debt|exchange|penalt|provision for income tax" }, isCatchAll: false },
];

/** Every product-owned default group across dimensions, in seed order. */
export const DEFAULT_ACCOUNT_GROUPS: DefaultAccountGroup[] = [
  ...DEFAULT_COST_POOL_GROUPS,
  ...DEFAULT_BURDEN_GROUPS,
];

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
    // One ACTIVE catch-all per (org, dimension): a second catch-all makes
    // every unmatched account's bucket a silent sort_order guess (0319).
    // Inactive rows stay out so deactivated groups keep their history.
    uniqueIndex("account_groups_one_active_catch_all")
      .on(t.orgId, t.dimension)
      .where(sql`${t.isCatchAll} AND ${t.isActive}`),
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
    /** Copied from the parent group so one account can be pinned once per dimension. */
    dimension: text("dimension").notNull(),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("account_group_members_org_dimension_account").on(t.orgId, t.dimension, t.accountId),
    index("account_group_members_account").on(t.accountId),
  ],
);
