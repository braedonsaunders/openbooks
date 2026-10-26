import "server-only";
import { cache } from "react";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext } from "@openbooks/engine/platform/db";
import { preferenceUserIdentity, type PreferenceUser } from "./user-preference-identity";
import { resolveEntryPreferences, type EntryPreferences } from "./entry-preferences";

/**
 * The signed-in person's data-entry preferences. They belong to the
 * preference identity (the home user while a production workspace switch is
 * active), exactly like the language and menu-layout preferences.
 */
export const loadEntryPreferences = cache(
  async (user: PreferenceUser): Promise<EntryPreferences> => {
    const identity = preferenceUserIdentity(user);
    // bypass: user-keyed-lookup — read the personal preference of the verified preference identity across tenant scope.
    const row = await withBypassContext(() =>
      db.execute<{ entry_preferences: unknown }>(
        sql`
    select entry_preferences from users
     where id = ${identity.id} and org_id = ${identity.orgId} and is_active`,
        "objects",
      ),
    );
    return resolveEntryPreferences(row[0]?.entry_preferences);
  },
);

/**
 * Merge a change into the stored preferences and audit it. Returns the
 * resolved preferences, or null when the account is no longer active in the
 * workspace (nothing was written).
 */
export async function saveEntryPreferences(
  user: PreferenceUser & { id: string },
  patch: Partial<EntryPreferences>,
): Promise<EntryPreferences | null> {
  const identity = preferenceUserIdentity(user);
  // bypass: user-keyed-lookup — update and audit the verified home preference identity while another workspace is active.
  return withBypass(async () => {
    const current = await db.execute<{ entry_preferences: unknown }>(
      sql`
      select entry_preferences from users
       where id = ${identity.id} and org_id = ${identity.orgId} and is_active
       for update`,
      "objects",
    );
    if (current.length !== 1) return null;
    const before = resolveEntryPreferences(current[0]!.entry_preferences);
    const after: EntryPreferences = { ...before, ...patch };
    const updated = await db.execute<{ id: string }>(
      sql`
      update users
         set entry_preferences = ${JSON.stringify(after)}::jsonb, updated_at = now(), updated_by = ${user.id}
       where id = ${identity.id} and org_id = ${identity.orgId} and is_active
       returning id`,
      "objects",
    );
    if (updated.length !== 1) return null;
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${identity.orgId}, 'users', ${identity.id}, 'update',
              ${JSON.stringify({ entryPreferences: { before, after } })}, ${user.id})`);
    return after;
  });
}
