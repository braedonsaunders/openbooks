import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { RATIO_INPUT_DIMENSION, RATIO_INPUT_KEYS, type RatioInputKey } from "./financial-health";

/**
 * The organization's classifications behind the leverage ratios: which
 * accounts carry interest expense and which hold interest-bearing debt. The
 * chart's account types cannot answer either question (an `expense_other`
 * line may be interest, an FX loss or income tax; a `liability_long_term`
 * may be a loan or a deferred tax balance), so the organization answers it
 * once, here, and the Financial Health engine reads it.
 *
 * Stored as pin-only groups in the `financial_ratios` account-group
 * dimension, so the classification also appears beside the organization's
 * other account groups in Setup. A group that exists with no accounts is a
 * decision ("we carry no debt"); a missing group means the organization has
 * not decided, and the ratios that need it say so.
 */

/** Account types each classification may hold. */
export const RATIO_INPUT_ACCOUNT_TYPES: Record<RatioInputKey, readonly string[]> = {
  interest_expense: ["expense", "expense_other"],
  interest_bearing_debt: ["liability_current_other", "liability_long_term", "liability_card"],
};

export type RatioInputAccount = {
  id: string;
  number: string | null;
  name: string;
  type: string;
};

export interface RatioInputState {
  /** null = not yet decided. */
  accounts: RatioInputAccount[] | null;
  /** Active, posting accounts of an allowed type, for the picker. */
  candidates: RatioInputAccount[];
}

export class RatioInputError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "RatioInputError";
  }
}

export function isRatioInputKey(value: string): value is RatioInputKey {
  return (RATIO_INPUT_KEYS as readonly string[]).includes(value);
}

export async function loadRatioInputs(orgId: string): Promise<Record<RatioInputKey, RatioInputState>> {
  const [groups, members, accounts] = await Promise.all([
    db.execute<{ id: string; key: string }>(sql`
      select id, key from account_groups
       where org_id = ${orgId} and dimension = ${RATIO_INPUT_DIMENSION} and is_active
    `),
    db.execute<{ group_id: string; id: string; number: string | null; name: string; type: string }>(sql`
      select m.group_id, a.id, a.number, a.name, a.type
        from account_group_members m
        join accounts a on a.id = m.account_id and a.org_id = m.org_id
       where m.org_id = ${orgId} and m.dimension = ${RATIO_INPUT_DIMENSION}
       order by a.number nulls last, a.name
    `),
    db.execute<RatioInputAccount>(sql`
      select id, number, name, type from accounts
       where org_id = ${orgId} and is_active and not is_summary
       order by number nulls last, name
    `),
  ]);
  return Object.fromEntries(RATIO_INPUT_KEYS.map((key) => {
    const group = groups.rows.find((g) => g.key === key);
    return [key, {
      accounts: group
        ? members.rows.filter((m) => m.group_id === group.id).map(({ id, number, name, type }) => ({ id, number, name, type }))
        : null,
      candidates: accounts.rows.filter((a) => RATIO_INPUT_ACCOUNT_TYPES[key].includes(a.type)),
    }];
  })) as Record<RatioInputKey, RatioInputState>;
}

/**
 * Replace one classification's accounts. Creates the group on first save
 * (named in the saving user's language), refuses accounts of a type the
 * classification cannot hold, and records before/after audit evidence.
 */
export async function saveRatioInput(
  orgId: string,
  actorId: string,
  key: RatioInputKey,
  accountIds: string[],
  groupName: string,
): Promise<RatioInputAccount[]> {
  const ids = [...new Set(accountIds)];
  return db.transaction(async (tx) => {
    const found = ids.length === 0
      ? { rows: [] as RatioInputAccount[] }
      : await tx.execute<RatioInputAccount>(sql`
          select id, number, name, type from accounts
           where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])
           for share
        `);
    const missing = ids.filter((id) => !found.rows.some((a) => a.id === id));
    if (missing.length > 0) throw new RatioInputError(`unknown account ${missing[0]} — reload and choose from the list`);
    const wrong = found.rows.filter((a) => !RATIO_INPUT_ACCOUNT_TYPES[key].includes(a.type));
    if (wrong.length > 0) {
      throw new RatioInputError(
        `${wrong.map((a) => [a.number, a.name].filter(Boolean).join(" ")).join(", ")} cannot be classified as ${key.replace(/_/g, " ")}: only ${RATIO_INPUT_ACCOUNT_TYPES[key].join(", ")} accounts can`,
      );
    }

    // One writer per classification at a time; concurrent savers serialize.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`ratio-inputs:${orgId}:${key}`}, 0))`);
    let group = (await tx.execute<{ id: string }>(sql`
      select id from account_groups where org_id = ${orgId} and dimension = ${RATIO_INPUT_DIMENSION} and key = ${key}
    `)).rows[0];
    if (!group) {
      const inserted = await tx.execute<{ id: string }>(sql`
        insert into account_groups (org_id, dimension, key, name, sort_order, match, is_catch_all, created_by, updated_by)
        values (${orgId}, ${RATIO_INPUT_DIMENSION}, ${key}, ${groupName}, ${RATIO_INPUT_KEYS.indexOf(key) * 10}, '{}'::jsonb, false, ${actorId}, ${actorId})
        returning id
      `);
      group = inserted.rows[0];
      if (!group) throw new Error(`the ${key} classification could not be created`);
    } else {
      // A deactivated classification is reactivated by an explicit save.
      await tx.execute(sql`update account_groups set is_active = true, updated_by = ${actorId}, updated_at = now() where id = ${group.id} and org_id = ${orgId}`);
    }

    const before = (await tx.execute<{ account_id: string }>(sql`
      select account_id from account_group_members where org_id = ${orgId} and group_id = ${group.id} order by account_id
    `)).rows.map((r) => r.account_id);

    await tx.execute(sql`
      delete from account_group_members
       where org_id = ${orgId} and group_id = ${group.id}
         and not (account_id = any(${`{${ids.join(",")}}`}::uuid[]))
    `);
    for (const id of ids) {
      // One classification per account in this dimension: choosing an
      // account here moves it out of the other classification.
      await tx.execute(sql`
        insert into account_group_members (org_id, group_id, account_id, dimension, created_by)
        values (${orgId}, ${group.id}, ${id}, ${RATIO_INPUT_DIMENSION}, ${actorId})
        on conflict (org_id, dimension, account_id) do update
          set group_id = excluded.group_id, updated_at = now(), updated_by = excluded.created_by
      `);
    }

    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'account_groups', ${group.id}, 'update',
        ${JSON.stringify({ before: { classification: key, accountIds: before }, after: { classification: key, accountIds: [...ids].sort() } })}::jsonb,
        ${actorId})
    `);
    return found.rows.sort((a, b) => (a.number ?? a.name).localeCompare(b.number ?? b.name));
  });
}
