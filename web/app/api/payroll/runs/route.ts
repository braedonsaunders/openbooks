import { uuidId } from "@/lib/api/json-schema";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { payrollRunPopulationScopeFilter } from "@openbooks/engine/payroll/scope";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { createPayRun } from "@openbooks/engine/payroll/run-lifecycle";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { type PayRunType } from "@openbooks/engine/payroll/run-contracts";
import { guardSubsidiaryScope, subsidiaryScopeAllows } from "../../../../lib/authz";
import { subsidiaryVisibleFilter } from "../../../../lib/subsidiaries";
import { notFound } from "@/lib/api/responses";

const optionalCalendarDate = z
  .string()
  .refine(isIsoCalendarDate, "must be a real calendar date (YYYY-MM-DD)")
  .optional();
const requestBodySchema = z
  .strictObject({
    payScheduleId: uuidId,
    periodStart: optionalCalendarDate,
    periodEnd: optionalCalendarDate,
    payDate: optionalCalendarDate,
    runType: z.enum(["regular", "bonus", "termination", "supplemental"]).default("regular"),
    employeePartyIds: z.array(uuidId).default([]),
  })
  .refine((body) => body.runType !== "termination" || body.employeePartyIds.length > 0, {
    message: "a final pay run must name the employees it pays",
    path: ["employeePartyIds"],
  });

export const dynamic = "force-dynamic";

/**
 * Pay runs collection.
 *
 *  GET  → runs joined to their documents (number/status ride the document).
 *         Subsidiary-restricted callers see only runs whose legal entity is
 *         inside their scope, using the same fail-closed filter as the other
 *         subsidiary-aware list queries.
 *  POST → mint the next run for a schedule (period derives from the schedule's
 *         anchor when not supplied). Creation is a payroll.run action — the
 *         run itself is a posting document and posts through the standard
 *         document actions route.
 */

export const GET = defineRoute({
  permission: "payroll.read",
  feature: "payroll",
  handler: async ({ authz: gate }) => {
    const runs = await db.execute<Record<string, unknown>>(
      sql`
      select r.document_id, d.document_number, d.status as document_status, d.currency,
             r.pay_schedule_id, s.name as schedule_name,
             r.period_start::text as period_start, r.period_end::text as period_end,
             r.pay_date::text as pay_date, r.tax_year, r.run_status,
             r.gross_total, r.net_total, r.employer_cost_total, r.employee_count
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
        left join pay_schedules s on s.id = r.pay_schedule_id and s.org_id = r.org_id
       where r.org_id = ${gate.user.orgId}${subsidiaryVisibleFilter(sql`d.subsidiary_id`, gate.allowedSubsidiaryIds)}
         ${payrollRunPopulationScopeFilter(gate.user.orgId, sql`r.document_id`, gate.allowedSubsidiaryIds)}
       order by r.pay_date desc, d.document_number desc`,
      "objects",
    );
    return NextResponse.json({ runs });
  },
});

export const POST = defineRoute({
  permission: "payroll.run",
  feature: "payroll",
  body: requestBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body }) => {
    const payScheduleId = body.payScheduleId;
    const requestedRunType = body.runType;
    const runType: PayRunType =
      requestedRunType === "bonus" ||
      requestedRunType === "termination" ||
      requestedRunType === "supplemental"
        ? requestedRunType
        : "regular";
    const periodStart = body.periodStart;
    const periodEnd = body.periodEnd;
    const payDate = body.payDate;
    // A final pay run pays out and clears every accrued bank, so it must name
    // the employees it pays; the engine refuses an unscoped one outright.
    const employeePartyIds = body.employeePartyIds;
    // A run belongs to the schedule's legal entity. Resolve that entity before
    // entering createPayRun so a restricted caller cannot mint another
    // subsidiary's run (a termination run can clear every accrued bank). An
    // org-wide schedule follows the engine's root-subsidiary convention. Missing
    // schedules, roots, and out-of-scope entities all fail closed with the same
    // not-found response and therefore disclose no payroll metadata.
    if (gate.allowedSubsidiaryIds) {
      const schedule = (
        await db.execute<{ subsidiaryId: string | null }>(
          sql`
        select subsidiary_id as "subsidiaryId"
          from pay_schedules
         where org_id = ${gate.user.orgId} and id = ${payScheduleId} and is_active`,
          "objects",
        )
      )[0];
      const runSubsidiaryId =
        schedule?.subsidiaryId ??
        (schedule
          ? ((
              await db.execute<{ id: string }>(
                sql`
              select id
                from subsidiaries
               where org_id = ${gate.user.orgId} and parent_id is null and is_active
               order by created_at
               limit 1`,
                "objects",
              )
            )[0]?.id ?? null)
          : null);
      const denied = guardSubsidiaryScope(gate, runSubsidiaryId);
      if (denied) return denied;

      // Termination (and any explicitly named run) also carries employee
      // payroll data. Parties with no subsidiary are org-wide shared identities,
      // matching the party-list semantics; unknown ids fail closed because the
      // number of visible rows must equal the number requested.
      const namedEmployees = [...new Set(employeePartyIds)];
      if (namedEmployees.length > 0) {
        const people = await db.execute<{ subsidiaryId: string | null }>(
          sql`
          select subsidiary_id as "subsidiaryId"
            from parties
           where org_id = ${gate.user.orgId}
             and id = any(${`{${namedEmployees.join(",")}}`}::uuid[])`,
          "objects",
        );
        const visible = people.filter((person) =>
          subsidiaryScopeAllows(gate.allowedSubsidiaryIds, person.subsidiaryId, {
            orgWideNull: true,
          }),
        );
        if (visible.length !== namedEmployees.length) {
          return notFound("record");
        }
      }
    }
    try {
      const result = await createPayRun({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        payScheduleId,
        periodStart,
        periodEnd,
        payDate,
        runType,
        employeePartyIds,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (e) {
      if (e instanceof ScopeNotFoundError) return notFound("record");
      if (e instanceof PayrollError) return apiErrorResponse(e, { safeStatus: 422 });
      throw e;
    }
  },
});
