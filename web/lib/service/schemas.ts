import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { civilDateInput } from "../api/civil-date";

/**
 * Request shapes for the service API. Shapes only: the engine commands own
 * every business rule (exact decimals, effective dates, scope, lifecycle),
 * so a well-formed body still meets the same refusals as any other caller.
 */

const uuid = uuidString().describe("UUID of an organization-owned record.");
const optionalUuid = uuid
  .nullable()
  .optional()
  .describe("Related record UUID, or null when unset.");
const text = (max: number) => z.string().max(max).describe(`Text value up to ${max} characters.`);
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .optional()
    .describe(`Optional text up to ${max} characters, or null to clear it.`);
/** Exact decimals travel as strings and are parsed by the engine's decimal helpers. */
const decimal = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .describe("Exact decimal string; do not convert money or quantity to a number.");
const optionalDecimal = z
  .string()
  .trim()
  .max(40)
  .nullable()
  .optional()
  .describe("Exact decimal string, or null when unset.");
const instant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  .refine(
    (value) => z.string().datetime({ offset: true }).safeParse(value).success,
    "must be an ISO 8601 timestamp with an explicit timezone offset",
  )
  .describe("ISO 8601 timestamp with an explicit timezone offset.");
const optionalInstant = instant
  .nullable()
  .optional()
  .describe("Optional ISO 8601 timestamp with timezone, or null.");
const revision = z
  .number()
  .int()
  .min(0)
  .describe("Current integer revision from the matching service read.");
const reason = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .describe("Reason recorded with this service change.");

export const priority = z.enum(["low", "normal", "high", "urgent"]).describe("Service priority.");
export const billingMode = z
  .enum(["per_job", "per_visit", "not_billable"])
  .describe("Service billing mode.");

export const idParams = z.object({ id: uuid });
export const visitFileParams = z.object({ id: uuid, fileId: uuid });
export const visitPartParams = z.object({ id: uuid, partId: uuid });
export const tokenParams = z.object({
  token: z.string().min(16).max(2000).describe("Possession token from the signature link."),
});

export const visitInput = z
  .strictObject({
    estimatedMinutes: z.number().int().describe("Estimated visit duration in minutes."),
    priority: priority.optional(),
    preferredOn: civilDateInput()
      .nullable()
      .optional()
      .describe("Preferred service date in YYYY-MM-DD format, or null."),
    windowStartsAt: optionalInstant,
    windowEndsAt: optionalInstant,
    instructions: optionalText(4000),
    requiredQualificationTypeIds: z
      .array(uuid)
      .max(50)
      .optional()
      .describe("Required technician qualification type UUIDs."),
  })
  .describe("Service visit plan details.");

const requestFields = {
  customerPartyId: uuid,
  serviceAddressId: optionalUuid,
  contactId: optionalUuid,
  subsidiaryId: optionalUuid,
  title: text(200),
  description: optionalText(8000),
  priority,
  preferredOn: civilDateInput()
    .nullable()
    .optional()
    .describe("Preferred service date in YYYY-MM-DD format, or null."),
  preferredTime: z
    .enum(["any", "morning", "afternoon", "evening"])
    .optional()
    .describe("Preferred time of day."),
};

export const createRequestBody = z.strictObject({ id: uuid, ...requestFields });
export const updateRequestBody = z.strictObject({ expectedRevision: revision, ...requestFields });
export const closeRequestBody = z.strictObject({
  expectedRevision: revision,
  outcome: z
    .enum(["declined", "cancelled"])
    .describe("Whether the request was declined or cancelled."),
  reason,
});
export const assessmentBody = z.strictObject({ expectedRevision: revision, visit: visitInput });
export const startQuoteBody = z.strictObject({ idempotencyKey: uuid });

export const jobLine = z.strictObject({
  itemId: uuid,
  description: optionalText(2000),
  quantity: decimal,
  unitPrice: decimal,
  taxCodeId: optionalUuid,
  sourceQuoteLineId: optionalUuid,
});

const jobFields = {
  serviceAddressId: optionalUuid,
  contactId: optionalUuid,
  title: text(200).optional(),
  description: optionalText(8000),
  priority: priority.optional(),
  requiredQualificationTypeIds: z
    .array(uuid)
    .max(50)
    .optional()
    .describe("Required technician qualification type UUIDs."),
  estimatedMinutes: z.number().int().describe("Estimated visit duration in minutes."),
  billingMode,
  laborItemId: optionalUuid,
  laborUnitPrice: optionalDecimal,
  depositRequired: optionalDecimal,
};

export const createJobBody = z.strictObject({
  id: uuid,
  requestId: optionalUuid,
  customerPartyId: uuid.optional(),
  subsidiaryId: optionalUuid,
  ...jobFields,
  lines: z.array(jobLine).max(500).optional().describe("Exact decimal billable scope lines."),
  firstVisit: z
    .strictObject({
      preferredOn: civilDateInput()
        .nullable()
        .optional()
        .describe("Preferred service date in YYYY-MM-DD format, or null."),
      windowStartsAt: optionalInstant,
      windowEndsAt: optionalInstant,
      instructions: optionalText(4000),
    })
    .nullable()
    .optional()
    .describe("Optional first visit plan."),
});
export const updateJobBody = z.strictObject({ expectedRevision: revision, ...jobFields });
export const jobLinesBody = z.strictObject({
  expectedRevision: revision,
  lines: z.array(jobLine).max(500).describe("Complete replacement job scope lines."),
});
export const jobVisitBody = z.strictObject({ expectedRevision: revision, visit: visitInput });
export const jobLifecycleBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("complete"), expectedRevision: revision }),
  z.strictObject({ action: z.literal("reopen"), expectedRevision: revision, reason }),
  z.strictObject({ action: z.literal("cancel"), expectedRevision: revision, reason }),
]);
export const invoiceBody = z.strictObject({
  visitId: optionalUuid.describe("Optional visit UUID to invoice individually."),
});
export const depositBody = z.strictObject({ paymentDocumentId: uuid });
export const applyDepositsBody = z.strictObject({ invoiceDocumentId: uuid });

export const quoteTermsBody = z.strictObject({
  depositBasis: z.enum(["none", "percent", "amount"]).describe("Deposit calculation method."),
  depositValue: z.string().trim().max(40).describe("Exact decimal deposit amount or percentage."),
  optionalLineIds: z
    .array(uuid)
    .max(500)
    .describe("Estimate line UUIDs that are optional for acceptance."),
});
export const sendQuoteBody = z.strictObject({
  signerName: text(120),
  signerEmail: text(320),
  expiresInDays: z.number().int().optional().describe("Signature link lifetime in days."),
  message: optionalText(2000),
});
export const convertQuoteBody = z.strictObject({
  id: uuid,
  estimatedMinutes: z.number().int().describe("Estimated visit duration in minutes."),
  billingMode,
  laborItemId: optionalUuid,
  laborUnitPrice: optionalDecimal,
  serviceAddressId: optionalUuid,
  contactId: optionalUuid,
  title: text(200).optional(),
});

export const visitPlanBody = z.strictObject({
  expectedRevision: revision,
  visit: visitInput,
  reason: optionalText(2000),
});
export const visitStatusBody = z.strictObject({
  expectedRevision: revision,
  to: z
    .enum(["dispatched", "en_route", "on_site", "unable_to_complete"])
    .describe("Target field-service visit status."),
  reason: optionalText(2000),
});
export const visitCancelBody = z.strictObject({
  expectedRevision: revision,
  reason,
  skip: z
    .boolean()
    .optional()
    .describe("Mark an agreement occurrence skipped instead of cancelling the visit."),
});
export const visitPartBody = z.strictObject({
  expectedRevision: revision,
  itemId: uuid,
  stockLocationId: uuid,
  quantity: decimal,
  billable: z.boolean().describe("Whether this part is billed to the customer."),
  lotId: optionalUuid,
  serialId: optionalUuid,
  memo: optionalText(500),
});
export const visitPartRemoveBody = z.strictObject({ expectedRevision: revision });
export const visitCompleteBody = z.strictObject({
  expectedRevision: revision,
  workNotes: text(8000),
  labor: z
    .array(
      z
        .strictObject({
          workerPartyId: optionalUuid.describe(
            "Technician party UUID, or null for the current technician.",
          ),
          startedAt: instant.describe("Work start timestamp with timezone."),
          hours: decimal.describe("Exact labor hours worked."),
        })
        .describe("Labor entry for a technician."),
    )
    .max(20)
    .optional()
    .describe("Technician labor entries recorded for the visit."),
});
export const signatureLinkBody = z.strictObject({
  recipient: optionalText(320),
  email: z
    .boolean()
    .optional()
    .describe("Email the sign-off link to the recipient when available."),
});

const agreementVersion = z
  .strictObject({
    recurrence: z
      .strictObject({
        repeat: z
          .enum(["daily", "weekly", "monthly", "yearly"])
          .describe("Recurring visit frequency."),
        interval: z.number().int().describe("Number of frequency units between visits."),
        weekdays: z
          .array(z.number().int())
          .max(7)
          .optional()
          .describe("Weekday numbers for weekly recurrence."),
        monthlyBy: z.enum(["day", "weekday"]).optional().describe("Monthly recurrence rule."),
      })
      .describe("Recurring visit schedule."),
    windowStarts: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .describe("Local start time in HH:MM format."),
    windowEnds: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .describe("Local end time in HH:MM format."),
    estimatedMinutes: z.number().int().describe("Estimated visit duration in minutes."),
    priority,
    requiredQualificationTypeIds: z
      .array(uuid)
      .max(50)
      .optional()
      .describe("Required technician qualification type UUIDs."),
    instructions: optionalText(4000),
    lines: z.array(jobLine).max(200).describe("Recurring service scope lines."),
  })
  .describe("One effective version of a service agreement.");
export const createAgreementBody = z.strictObject({
  id: uuid,
  customerPartyId: uuid,
  serviceAddressId: optionalUuid,
  contactId: optionalUuid,
  subsidiaryId: optionalUuid,
  title: text(200),
  startsOn: civilDateInput().describe("Agreement start date in YYYY-MM-DD format."),
  endsOn: civilDateInput()
    .nullable()
    .optional()
    .describe("Agreement end date in YYYY-MM-DD format, or null."),
  version: agreementVersion,
  reason,
});
export const agreementVersionBody = z.strictObject({
  expectedRevision: revision,
  effectiveFrom: civilDateInput().describe("Version effective date in YYYY-MM-DD format."),
  version: agreementVersion,
  reason,
});
export const closeAgreementBody = z.strictObject({
  expectedRevision: revision,
  outcome: z.enum(["ended", "cancelled"]).describe("Whether to end or cancel the agreement."),
  endsOn: civilDateInput()
    .nullable()
    .optional()
    .describe("Agreement end date in YYYY-MM-DD format, or null."),
  reason,
});

export const dispatchQuery = z.object({
  board: uuid,
  date: civilDateInput().describe("Dispatch board date in YYYY-MM-DD format."),
});
const assignmentFields = {
  boardId: uuid,
  workerPartyId: uuid,
  startsAt: instant,
  minutes: z.number().int().optional().describe("Scheduled duration in minutes."),
  overrideReason: optionalText(500),
};
export const previewAssignmentBody = z.strictObject({
  boardId: uuid,
  visitId: uuid,
  workerPartyId: uuid,
  startsAt: instant,
  minutes: z.number().int().optional().describe("Scheduled duration in minutes."),
  movingEntryId: optionalUuid.describe("Existing booking UUID when moving a booking."),
});
export const assignBody = z.strictObject({
  ...assignmentFields,
  visitId: uuid,
  expectedRevision: revision,
});
export const moveBody = z.strictObject({
  ...assignmentFields,
  entryId: uuid,
  expectedEntryRevision: revision,
  expectedVisitRevision: revision,
});
export const unassignBody = z.strictObject({
  boardId: uuid,
  entryId: uuid,
  expectedEntryRevision: revision,
  expectedVisitRevision: revision,
  reason: optionalText(500),
});
export const dispatchVisitBody = z.strictObject({
  boardId: uuid,
  visitId: uuid,
  expectedRevision: revision,
});

export const myVisitsQuery = z.object({
  from: civilDateInput().describe("First service date in YYYY-MM-DD format."),
  through: civilDateInput().describe("Last service date in YYYY-MM-DD format."),
});

export const publicQuoteAnswerBody = z.discriminatedUnion("answer", [
  z.strictObject({
    answer: z.literal("accept"),
    name: text(120),
    selectedOptionalLineIds: z.array(uuid).max(500),
    signatureSvg: optionalText(200_000),
  }),
  z.strictObject({ answer: z.literal("decline"), name: text(120), reason: optionalText(2000) }),
]);
export const publicVisitSignBody = z.strictObject({
  token: z.string().min(16).max(2000),
  signature: z.string().min(1).max(400_000),
  name: text(120),
  comment: optionalText(2000),
});
