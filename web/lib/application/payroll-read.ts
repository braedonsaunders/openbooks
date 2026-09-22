import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { isFeatureEnabled } from "../features";
import { clamp } from "../list-params";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError } from "./errors";

/**
 * Employees with a payroll profile. Summary columns only — withholding
 * elections and sealed government ids are never selected. Scope is
 * `parties.subsidiary_id` through the shared visibility filter, not a
 * parallel payroll predicate.
 */
export async function listApplicationPayrollEmployees(
  context: ApplicationContext,
  input: { query?: string; limit?: number },
) {
  assertApplicationPermission(context, "payroll.manage");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "payroll"))) {
    throw new ApplicationError(
      "not_found",
      "payroll is off; enable it from GET /api/v1/settings/features",
      404,
    );
  }
  const limit = clamp(input.limit ?? 50, 1, 200);
  const like = input.query?.trim() ? `%${input.query.trim()}%` : null;
  const rows = await db.execute<Record<string, unknown>>(sql`
    select prof.id, prof.employee_party_id, p.display_name as employee_name,
           prof.pay_schedule_id, s.name as schedule_name, prof.country, prof.province,
           prof.pay_basis, prof.is_active, prof.stub_delivery, prof.payment_method,
           prof.vacation_method, fa.account_number as filing_account_number
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
      left join pay_schedules s on s.id = prof.pay_schedule_id and s.org_id = prof.org_id
      left join payroll_filing_accounts fa on fa.id = prof.filing_account_id and fa.org_id = prof.org_id
     where prof.org_id = ${context.authz.user.orgId}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, context.authz.allowedSubsidiaryIds)}
       ${like ? sql` and p.display_name ilike ${like}` : sql``}
     order by p.display_name
     limit ${limit}`);
  return {
    employees: rows.rows.map((row) => ({
      profileId: row.id,
      employeePartyId: row.employee_party_id,
      name: row.employee_name,
      payScheduleId: row.pay_schedule_id,
      scheduleName: row.schedule_name,
      country: row.country,
      region: row.province,
      payBasis: row.pay_basis,
      isActive: row.is_active,
      filingAccountNumber: row.filing_account_number,
      stubDelivery: row.stub_delivery,
      paymentMethod: row.payment_method,
      vacationMethod: row.vacation_method,
    })),
  };
}
