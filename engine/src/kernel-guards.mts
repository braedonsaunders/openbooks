/**
 * Drop / restore the immutability guard TRIGGERS (je_guard, jl_guard) so a
 * migration can bulk-delete posted journal entries + lines. The user is not a
 * DB superuser, so `set session_replication_role = replica` is unavailable;
 * dropping and re-creating these two triggers is the sanctioned path.
 *
 * ONLY the two guard triggers are touched. The BALANCE trigger (jl_balanced),
 * ACCOUNT trigger (jl_check_account) and APPLICATION trigger (app_check_open)
 * stay in force. The trigger FUNCTIONS are left intact — we only drop/recreate
 * the trigger bindings, so restore is an exact re-create matching
 * schema/migrations/kernel-constraints.sql.
 */
import { sql } from "drizzle-orm";
import { db } from "./db.ts";

export async function dropGuards(): Promise<void> {
  await db.execute(sql`drop trigger if exists je_guard on journal_entries`);
  await db.execute(sql`drop trigger if exists jl_guard on journal_lines`);
}

export async function restoreGuards(): Promise<void> {
  // idempotent: drop first in case a prior run left them, then re-create
  // exactly as kernel-constraints.sql defines them.
  await db.execute(sql`drop trigger if exists je_guard on journal_entries`);
  await db.execute(sql`drop trigger if exists jl_guard on journal_lines`);
  await db.execute(sql`
    create trigger je_guard before update or delete on journal_entries
      for each row execute function je_guard()`);
  await db.execute(sql`
    create trigger jl_guard before insert or update or delete on journal_lines
      for each row execute function jl_guard()`);
}

/** Verify both guard triggers are present (post-restore sanity). */
export async function guardsPresent(): Promise<{ je: boolean; jl: boolean }> {
  const rows = (await db.execute(sql`
    select tgname from pg_trigger
     where tgname in ('je_guard', 'jl_guard') and not tgisinternal`)).rows as any[];
  const names = new Set(rows.map((r) => r.tgname));
  return { je: names.has("je_guard"), jl: names.has("jl_guard") };
}
