import { z } from "zod";
import { isUuid } from "../../../../../lib/list-params";

/**
 * Typed request bodies for /api/hrm/benefits/payroll-inputs. HR names a
 * coverage MONTH, never pay periods: payroll allocates months to periods
 * on its side. Voiding needs a reason — it is the row's evidence.
 */
const uuid = z.string().refine(isUuid, "must be a valid id");
const coverageMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "must be a YYYY-MM month");

export const benefitPayrollInputsBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("generate"), coverageMonth }),
  z.object({
    action: z.literal("void"),
    inputId: uuid,
    reason: z.string().trim().min(1, "reason required").max(2000),
  }),
]);
