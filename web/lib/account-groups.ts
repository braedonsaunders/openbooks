import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import type { AccountGroupMatch } from "@openbooks/schema";

/**
 * Account-group resolver — the reporting primitive. Given a grouping
 * `dimension` (e.g. "cost_pool"), it classifies every account into a group via
 * the RULE + PIN model (see schema/src/account-groups.ts): an explicit pin
 * wins, else the first active group (by sort_order) whose match rule matches,
 * else the dimension's catch-all group. Any report can call `resolveAccountGroups`
 * and bucket its per-account figures — the GL is sliced by the grouping the way
 * it's sliced by department.
 */

export interface AccountGroup {
  id: string;
  dimension: string;
  key: string;
  name: string;
  color: string | null;
  sortOrder: number;
  match: AccountGroupMatch;
  isCatchAll: boolean;
}

export interface GroupRef {
  groupId: string;
  key: string;
  name: string;
  color: string | null;
}

function matchesRule(acct: { number: string | null; name: string; type: string }, m: AccountGroupMatch): boolean {
  const conditions = (m.accountTypes?.length ? 1 : 0) + (m.numberPrefixes?.length ? 1 : 0) + (m.namePattern ? 1 : 0);
  if (conditions === 0) return false; // empty rule never matches (use isCatchAll)
  if (m.accountTypes?.length && !m.accountTypes.includes(acct.type)) return false;
  if (m.numberPrefixes?.length && !m.numberPrefixes.some((p) => (acct.number ?? "").startsWith(p))) return false;
  if (m.namePattern) {
    let re: RegExp;
    try {
      re = new RegExp(m.namePattern, "i");
    } catch {
      return false;
    }
    if (!re.test(acct.name)) return false;
  }
  return true;
}

export async function listAccountGroups(dimension: string, orgId?: string): Promise<AccountGroup[]> {
  const orgFilter = orgId ? sql` and org_id = ${orgId}` : sql``;
  const r = (await db.execute(sql`
    select id, dimension, key, name, color, sort_order, match, is_catch_all
    from account_groups
    where dimension = ${dimension} and is_active = true${orgFilter}
    order by sort_order, name
  `)) as any;
  return (r.rows as any[]).map((x) => ({
    id: x.id,
    dimension: x.dimension,
    key: x.key,
    name: x.name,
    color: x.color,
    sortOrder: Number(x.sort_order),
    match: (x.match ?? {}) as AccountGroupMatch,
    isCatchAll: x.is_catch_all === true,
  }));
}

export interface ResolvedGroups {
  groups: AccountGroup[];
  byAccount: Map<string, GroupRef>;
  /** Account ids whose classification comes from an explicit pin (not a rule). */
  pinned: Set<string>;
}

export async function resolveAccountGroups(dimension: string, orgId?: string): Promise<ResolvedGroups> {
  const orgFilter = orgId ? sql` and g.org_id = ${orgId}` : sql``;
  const acctOrgFilter = orgId ? sql` and org_id = ${orgId}` : sql``;
  const [groups, pinRows, acctRows] = await Promise.all([
    listAccountGroups(dimension, orgId),
    db.execute(sql`
      select m.account_id, g.id as group_id, g.key, g.name, g.color
      from account_group_members m
      join account_groups g on g.id = m.group_id
      where g.dimension = ${dimension} and g.is_active = true${orgFilter}
    `) as Promise<any>,
    db.execute(sql`select id, number, name, type from accounts where is_summary = false${acctOrgFilter}`) as Promise<any>,
  ]);

  const pins = new Map<string, GroupRef>();
  for (const p of pinRows.rows as any[]) {
    pins.set(p.account_id, { groupId: p.group_id, key: p.key, name: p.name, color: p.color });
  }
  const catchAll = groups.find((g) => g.isCatchAll) ?? null;

  const byAccount = new Map<string, GroupRef>();
  for (const a of acctRows.rows as any[]) {
    const acct = { number: a.number, name: a.name as string, type: a.type as string };
    const pinned = pins.get(a.id);
    if (pinned) {
      byAccount.set(a.id, pinned);
      continue;
    }
    let hit = groups.find((g) => !g.isCatchAll && matchesRule(acct, g.match)) ?? catchAll;
    if (hit) byAccount.set(a.id, { groupId: hit.id, key: hit.key, name: hit.name, color: hit.color });
  }
  return { groups, byAccount, pinned: new Set(pins.keys()) };
}
