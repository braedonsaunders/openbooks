import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { subsidiaryScopeAllows, ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { arePeriodModulesOpen } from "../periods/period-policy.ts";

export class GlAuditNumberError extends Error {
  readonly name = "GlAuditNumberError";
  constructor(
    message: string,
    readonly status: 403 | 404 | 409 | 422 = 422,
    readonly remedy = "Review the period, entity and audit numbering policy in Setup.",
  ) {
    super(message);
  }
}

export async function assignGlAuditNumbers(input: {
  orgId: string;
  actorId: string;
  periodId: string;
  bookId: string;
  subsidiaryId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  reason: string;
}): Promise<{ assigned: number; total: number }> {
  if (input.reason.trim().length < 5 || input.reason.trim().length > 2000)
    throw new GlAuditNumberError("Provide a reason of 5–2000 characters.");
  if (!subsidiaryScopeAllows(input.allowedSubsidiaryIds, input.subsidiaryId))
    throw new ScopeNotFoundError();
  return withOrgTransaction(input.orgId, async () => {
    await lockLedgerSetupFence(db, input.orgId, "shared");
    await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      input.subsidiaryId,
      "close.run",
    );
    const period = (
      await db.execute<{ fiscal_year: number; ends_on: string; fiscal_calendar_id: string }>(
        sql`
      select fiscal_year,ends_on::text,fiscal_calendar_id from accounting_periods where org_id=${input.orgId} and id=${input.periodId}`,
        "objects",
      )
    )[0];
    if (!period) throw new GlAuditNumberError("The period is unavailable.", 404);
    const identity = (
      await db.execute<{ found: boolean }>(
        sql`select exists(select 1 from accounting_books b,subsidiaries s
      where b.org_id=${input.orgId} and b.id=${input.bookId} and b.is_active and b.posts_gl and s.org_id=b.org_id and s.id=${input.subsidiaryId}) as found`,
        "objects",
      )
    )[0];
    const calendar = (
      await db.execute<{ id: string }>(
        sql`select public.subsidiary_posting_calendar(${input.orgId},${input.subsidiaryId},${period.ends_on}::date) as id`,
        "objects",
      )
    )[0]?.id;
    if (calendar !== period.fiscal_calendar_id)
      throw new GlAuditNumberError(
        "Choose a period of this entity's effective accounting calendar.",
      );
    if (!identity?.found) throw new GlAuditNumberError("The book or entity is unavailable.", 404);
    await db.execute(
      sql`select period_posting_fence(${input.orgId},${input.periodId},${input.bookId})`,
    );
    if (
      await arePeriodModulesOpen(db, {
        orgId: input.orgId,
        periodId: input.periodId,
        bookId: input.bookId,
        subsidiaryIds: [input.subsidiaryId],
        modules: ["gl"],
      })
    ) {
      throw new GlAuditNumberError(
        "Close the entity's GL period before allocating audit numbers.",
        409,
        "Complete the native period-close workflow, then allocate the audit numbers.",
      );
    }
    const policy = (
      await db.execute<{
        id: string;
        reset_rule: "period" | "fiscal_year" | "never";
        prefix: string;
      }>(
        sql`
      select id,reset_rule,prefix from gl_audit_number_policies where org_id=${input.orgId} and subsidiary_id=${input.subsidiaryId}
      and effective_from<=${period.ends_on}::date order by effective_from desc limit 1`,
        "objects",
      )
    )[0];
    if (!policy)
      throw new GlAuditNumberError(
        "No GL audit-number policy covers this entity and period.",
        422,
        "Record an effective-dated policy in Setup → GL audit number policies.",
      );
    const scope =
      policy.reset_rule === "period"
        ? `period:${input.periodId}`
        : policy.reset_rule === "fiscal_year"
          ? `year:${period.fiscal_calendar_id}:${period.fiscal_year}`
          : "all";
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`gl-audit:${input.orgId}:${input.bookId}:${input.subsidiaryId}:${scope}`},0))`,
    );
    const entries = await db.execute<{ id: string }>(
      sql`
      select distinct e.id,e.posting_date,e.posted_at from journal_entries e
      join journal_lines l on l.org_id=e.org_id and l.entry_id=e.id
      where e.org_id=${input.orgId} and e.book_id=${input.bookId} and e.status in ('posted','reversed')
      and l.subsidiary_id=${input.subsidiaryId} and coalesce(l.period_id,e.period_id)=${input.periodId}
      and not exists(select 1 from gl_audit_number_assignments n where n.org_id=e.org_id and n.book_id=e.book_id
        and n.subsidiary_id=${input.subsidiaryId} and n.entry_id=e.id)
      order by e.posting_date,e.posted_at,e.id`,
      "objects",
    );
    let ordinal = (
      await db.execute<{ ordinal: number }>(
        sql`select coalesce(max(ordinal),0)::int as ordinal from gl_audit_number_assignments
      where org_id=${input.orgId} and book_id=${input.bookId} and subsidiary_id=${input.subsidiaryId} and scope_key=${scope}`,
        "objects",
      )
    )[0]!.ordinal;
    for (const entry of entries) {
      ordinal += 1;
      const number = `${policy.prefix}-${scope.replaceAll(":", "-")}-${String(ordinal).padStart(6, "0")}`;
      const inserted = await db.execute(
        sql`insert into gl_audit_number_assignments(org_id,book_id,subsidiary_id,period_id,entry_id,policy_id,scope_key,ordinal,audit_number,created_by,updated_by)
        values(${input.orgId},${input.bookId},${input.subsidiaryId},${input.periodId},${entry.id},${policy.id},${scope},${ordinal},${number},${input.actorId},${input.actorId}) returning id`,
        "objects",
      );
      if (inserted.length !== 1)
        throw new GlAuditNumberError(
          "The GL audit number was not recorded; the allocation was rolled back.",
          409,
        );
    }
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${input.orgId},'gl_audit_number_assignments',${input.periodId},'assign',${JSON.stringify({ reason: input.reason.trim(), bookId: input.bookId, subsidiaryId: input.subsidiaryId, scope, assigned: entries.length, lastOrdinal: ordinal })}::jsonb,${input.actorId})`);
    return { assigned: entries.length, total: ordinal };
  });
}
