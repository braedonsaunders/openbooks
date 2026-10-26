import { sql } from "drizzle-orm";
import { db, withBypassContext, type SqlExecutor } from "../platform/db.ts";

/**
 * A login address resolves to exactly one active home identity across
 * production organizations: password sign-in, password reset and first
 * single-sign-on linking all refuse when two match, so a second active
 * identity for the same address locks its owner out everywhere.
 *
 * Every path that creates an active home identity takes this transaction
 * lock before checking, so two organizations cannot claim one address
 * concurrently.
 */
export async function lockLoginEmail(exec: SqlExecutor, email: string): Promise<void> {
  await exec.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`openbooks:login-identity:${email}`}, 0))`,
  );
}

/** Whether the address is already an active home identity outside `orgId`. */
export async function loginEmailSignsInElsewhere(
  email: string,
  orgId: string | null,
): Promise<boolean> {
  // bypass: user-keyed-lookup — the competing home identity belongs to another organization by definition.
  const row = (
    await withBypassContext(() =>
      db.execute<{ present: boolean }>(
        sql`
    select exists (
      select 1 from users u
        join orgs o on o.id = u.org_id and o.env_kind = 'production'
       where lower(u.email) = ${email} and u.is_active
         and (${orgId}::uuid is null or u.org_id <> ${orgId}::uuid)
    ) as present`,
        "objects",
      ),
    )
  )[0];
  return row?.present === true;
}
