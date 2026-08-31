import { sql } from "drizzle-orm";
import { db } from "./db.ts";
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

/**
 * Account-group patterns are tenant data and may have been stored before the
 * write route started validating them. Keep the runtime check bounded too:
 * JavaScript RegExp has no execution timeout, so an old ReDoS-shaped pattern
 * must never be allowed to run during report classification.
 */
export const ACCOUNT_GROUP_NAME_PATTERN_MAX_LENGTH = 256;

/** Return why a name pattern is unsafe, or null when it can be executed. */
export function accountGroupNamePatternError(pattern: unknown): string | null {
  if (pattern === undefined || pattern === null || pattern === "") return null;
  if (typeof pattern !== "string") return "must be a string";
  if (pattern.length > ACCOUNT_GROUP_NAME_PATTERN_MAX_LENGTH) {
    return `must be no longer than ${ACCOUNT_GROUP_NAME_PATTERN_MAX_LENGTH} characters`;
  }

  // Syntax errors are also unsafe legacy data: do not let RegExp construction
  // escape the per-account classification loop.
  try {
    new RegExp(pattern, "i");
  } catch {
    return "is not a valid regular expression";
  }

  // Backreferences and lookarounds can force the engine to revisit an
  // unbounded amount of input. Account-group matching has no need for either.
  if (/\\(?:[1-9]\d*|k<[^>]+>)/.test(pattern)) {
    return "must not contain backreferences";
  }
  if (/\(\?(?!:)/.test(pattern)) {
    return "must not contain lookaround or inline assertions";
  }

  type GroupFrame = {
    hasQuantifier: boolean;
    hasAlternation: boolean;
  };
  type Atom = {
    kind: "group" | "other";
    hasQuantifier: boolean;
    hasAlternation: boolean;
    quantified: boolean;
  };

  // Keep a synthetic root frame so top-level alternatives (for example the
  // seeded `rent|lease` rules) are handled like alternatives inside a group.
  const groups: GroupFrame[] = [
    { hasQuantifier: false, hasAlternation: false },
  ];
  let atom: Atom | undefined;
  let escaped = false;
  let inCharacterClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;

    if (escaped) {
      escaped = false;
      atom = {
        kind: "other",
        hasQuantifier: false,
        hasAlternation: false,
        quantified: false,
      };
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (char === "]") {
        inCharacterClass = false;
        atom = {
          kind: "other",
          hasQuantifier: false,
          hasAlternation: false,
          quantified: false,
        };
      }
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "(") {
      groups.push({ hasQuantifier: false, hasAlternation: false });
      atom = undefined;
      continue;
    }
    if (char === "|") {
      groups[groups.length - 1]!.hasAlternation = true;
      atom = undefined;
      continue;
    }
    if (char === ")") {
      if (groups.length === 1) return "is not a valid regular expression";
      const group = groups.pop();
      if (!group) return "is not a valid regular expression";
      const parent = groups[groups.length - 1];
      if (parent) {
        parent.hasQuantifier ||= group.hasQuantifier;
        parent.hasAlternation ||= group.hasAlternation;
      }
      atom = {
        kind: "group",
        hasQuantifier: group.hasQuantifier,
        hasAlternation: group.hasAlternation,
        quantified: false,
      };
      continue;
    }

    // `?:` is a non-capturing group prefix, not an optional quantifier.
    if (
      char === "?" &&
      pattern[index - 1] === "(" &&
      pattern[index + 1] === ":"
    ) {
      continue;
    }

    let isQuantifier = char === "*" || char === "+" || char === "?";
    if (char === "{") {
      const close = pattern.indexOf("}", index + 1);
      if (close !== -1) {
        const quantifier = pattern.slice(index, close + 1);
        // A missing upper bound is variable; {n,m} is finite and therefore
        // cannot recurse indefinitely on its own.
        isQuantifier = /^\{\d+(?:,\d*)?\}$/.test(quantifier);
        if (isQuantifier) index = close;
      } else {
        isQuantifier = false;
      }
    }

    if (isQuantifier) {
      // A lazy suffix (`+?`, `*?`, `??`, `{n,}?`) modifies the previous
      // quantifier. It is not an independently quantified atom.
      if (char === "?" && atom?.quantified) continue;

      if (
        atom?.kind === "group" &&
        (atom.hasQuantifier || atom.hasAlternation)
      ) {
        return "contains catastrophic backtracking";
      }
      if (atom) atom.quantified = true;
      // Record all quantifiers in the containing group. Even a finite inner
      // repetition (for example `(a{1,2})+`) becomes ambiguous when its group
      // is repeated, so the outer quantifier must fail closed too.
      groups[groups.length - 1]!.hasQuantifier = true;
      continue;
    }

    if (char !== "^" && char !== "$") {
      atom = {
        kind: "other",
        hasQuantifier: false,
        hasAlternation: false,
        quantified: false,
      };
    }
  }

  // RegExp construction above should already catch this, but leave the guard
  // here so the scanner fails closed if its syntax assumptions ever change.
  if (groups.length !== 1 || escaped || inCharacterClass) {
    return "is not a valid regular expression";
  }
  return null;
}

function matchesRule(acct: { number: string | null; name: string; type: string }, m: AccountGroupMatch): boolean {
  const conditions = (m.accountTypes?.length ? 1 : 0) + (m.numberPrefixes?.length ? 1 : 0) + (m.namePattern ? 1 : 0);
  if (conditions === 0) return false; // empty rule never matches (use isCatchAll)
  if (m.accountTypes?.length && !m.accountTypes.includes(acct.type)) return false;
  if (m.numberPrefixes?.length && !m.numberPrefixes.some((p) => (acct.number ?? "").startsWith(p))) return false;
  if (m.namePattern) {
    if (accountGroupNamePatternError(m.namePattern)) return false;
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
  `));
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
      order by m.account_id, g.id
    `),
    db.execute(sql`select id, number, name, type from accounts where is_summary = false${acctOrgFilter}`),
  ]);

  const pins = new Map<string, GroupRef>();
  for (const p of pinRows.rows as any[]) {
    // Migration 0081 makes duplicate account/dimension pins impossible. Keep
    // a deterministic tie-break for legacy rows that predate that constraint
    // so historical reports never depend on the database's physical order.
    const existing = pins.get(p.account_id);
    if (!existing || String(p.group_id) < existing.groupId) {
      pins.set(p.account_id, { groupId: p.group_id, key: p.key, name: p.name, color: p.color });
    }
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
