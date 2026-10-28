import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID from a project, time entry, or field ticket read.");
const DATE = z
  .string()
  .max(10)
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional()
  .describe("Calendar date in YYYY-MM-DD format, or null when not applicable.");

export const projectBillingRequestBody = z.object({
  projectId: UUID.describe("Project UUID for this billing request."),
  invoiceType: z
    .enum(["progress", "final"])
    .optional()
    .describe("Progress or final invoice stage."),
  basis: z
    .enum(["date_range", "draw_amount", "time_selection", "milestone", "field_ticket"])
    .optional()
    .describe("Billing basis enabled for the project type."),
  drawAmount: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe("Exact draw amount as decimal text when the basis is draw_amount."),
  startDate: DATE.describe("Start of the billed work period, if applicable."),
  cutoffDate: DATE.describe("End of the billed work period, if applicable."),
  invoiceDescription: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Description to carry to the invoice."),
  customerPo: z
    .string()
    .max(120)
    .nullable()
    .optional()
    .describe("Customer purchase-order reference."),
  backupRequired: z.boolean().optional().describe("Whether supporting invoice backup is required."),
  backupType: z.string().max(120).optional().describe("Configured backup packet type."),
  selectedTimeEntryIds: z
    .array(UUID)
    .max(500)
    .nullable()
    .optional()
    .describe("Time entry ids selected for time-based billing."),
  fieldTicketIds: z
    .array(UUID)
    .max(500)
    .nullable()
    .optional()
    .describe("Billable field ticket ids selected for this request."),
  notes: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Operator notes for the billing request."),
});
