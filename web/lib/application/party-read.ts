import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { normalizeMoneyValue } from "../cash/core";
import { clamp } from "../list-params";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { invalidInput } from "./errors";

export type PartyRole = "customer" | "vendor" | "employee";

/**
 * Active canonical role rows — keep in sync with ROLE_CONDITIONS in
 * web/app/(app)/parties/view.ts. A party is classified only by its active
 * role row, never by a kind flag.
 */
const ROLE_CONDITIONS = {
  customer: sql`exists (select 1 from customer_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)`,
  vendor: sql`exists (select 1 from vendor_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)`,
  employee: sql`exists (select 1 from employee_roles r where r.party_id = p.id and r.org_id = p.org_id and r.is_active)`,
} as const;

/** Parties holding one role — same directory filter as /entities/{role}. */
export async function listApplicationRoleParties(
  context: ApplicationContext,
  input: { role: string; query?: string; limit?: number },
) {
  assertApplicationPermission(context, "parties.read");
  if (input.role !== "customer" && input.role !== "vendor" && input.role !== "employee") {
    throw invalidInput("role must be customer, vendor, or employee");
  }
  const role = input.role as PartyRole;
  const limit = clamp(input.limit ?? 50, 1, 200);
  const like = input.query?.trim() ? `%${input.query.trim()}%` : null;
  const where = sql`p.org_id = ${context.authz.user.orgId}
    ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, context.authz.allowedSubsidiaryIds, { orgWideNull: true })}
    and p.is_active
    and ${ROLE_CONDITIONS[role]}
    ${like ? sql` and (p.display_name ilike ${like} or p.short_code ilike ${like} or p.email ilike ${like})` : sql``}`;
  const rows = (await db.execute<Record<string, unknown>>(sql`
    select p.id, p.display_name, p.short_code, p.email, p.phone, p.is_active,
           cr.credit_limit::text as credit_limit, cr.currency as customer_currency, cr.is_on_hold as customer_on_hold,
           vr.currency as vendor_currency, vr.is_on_hold as vendor_on_hold, vr.payment_method,
           er.employee_number, er.job_title, er.hired_on
      from parties p
      left join customer_roles cr on cr.party_id = p.id and cr.org_id = p.org_id and cr.is_active
      left join vendor_roles vr on vr.party_id = p.id and vr.org_id = p.org_id and vr.is_active
      left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id and er.is_active
     where ${where}
     order by p.display_name
     limit ${limit}
  `)).rows;
  return {
    role,
    parties: rows.map((row) => {
      const base = {
        id: row.id,
        name: row.display_name,
        shortCode: row.short_code,
        email: row.email,
        phone: row.phone,
        isActive: row.is_active,
      };
      if (role === "customer") {
        return {
          ...base,
          currency: row.customer_currency,
          isOnHold: row.customer_on_hold,
          creditLimit: row.credit_limit == null ? null : normalizeMoneyValue(String(row.credit_limit)),
        };
      }
      if (role === "vendor") {
        return {
          ...base,
          currency: row.vendor_currency,
          isOnHold: row.vendor_on_hold,
          paymentMethod: row.payment_method,
        };
      }
      return {
        ...base,
        employeeNumber: row.employee_number,
        jobTitle: row.job_title,
        hiredOn: row.hired_on,
      };
    }),
  };
}
