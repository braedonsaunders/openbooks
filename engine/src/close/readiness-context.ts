import { CloseError } from "../periods/period-policy.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/**
 * The close run, period, and entity currencies a readiness pass reads once.
 *
 * Split from the readiness checklist so that module stays within the line bound.
 */
export async function loadCloseRunContext(orgId: string, runId: string) {
  const context = await db.execute<{
    period_id: string;
    book_id: string;
    scope: { subsidiaryIds?: string[] };
    system_blueprint: boolean;
    starts_on: string;
    ends_on: string;
    fiscal_calendar_id: string;
    period_number: number;
    is_adjustment: boolean;
    base_currency: string;
    elimination_currency: string;
  }>(
    sql`
    select r.period_id, r.book_id, r.scope, p.starts_on, p.ends_on,
           b.name = 'close.defaultData.blueprint.name' as system_blueprint,
           p.fiscal_calendar_id, p.period_number, p.is_adjustment,
           o.base_currency,
           coalesce(
             (select s.base_currency from subsidiaries s
               where s.org_id = o.id and s.is_elimination and s.is_active
               order by s.created_at, s.id limit 1),
             o.base_currency) as elimination_currency
      from close_runs r
      join close_blueprints b on b.id=r.blueprint_id and b.org_id=r.org_id
      join accounting_periods p on p.id = r.period_id and p.org_id = r.org_id
      join orgs o on o.id = r.org_id
     where r.id = ${runId} and r.org_id = ${orgId}`,
    "objects",
  );
  const ctx = context[0];
  if (!ctx) throw new CloseError("close run not found");
  return ctx;
}
