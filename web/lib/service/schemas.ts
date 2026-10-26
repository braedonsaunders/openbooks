import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { civilDateInput } from "../api/civil-date";

/**
 * Request shapes for the service API. Shapes only: the engine commands own
 * every business rule (exact decimals, effective dates, scope, lifecycle),
 * so a well-formed body still meets the same refusals as any other caller.
 */

const uuid = uuidString();
const optionalUuid = uuid.nullable().optional();
const text = (max: number) => z.string().max(max);
const optionalText = (max: number) => z.string().max(max).nullable().optional();
/** Exact decimals travel as strings and are parsed by the engine's decimal helpers. */
const decimal = z.string().trim().min(1).max(40);
const optionalDecimal = z.string().trim().max(40).nullable().optional();
const instant = z.string().datetime({ offset: true });
const optionalInstant = instant.nullable().optional();
const revision = z.number().int().min(0);
const reason = z.string().trim().min(1).max(2000);

export const priority = z.enum(["low", "normal", "high", "urgent"]);
export const billingMode = z.enum(["per_job", "per_visit", "not_billable"]);

export const idParams = z.object({ id: uuid });
export const visitFileParams = z.object({ id: uuid, fileId: uuid });
export const visitPartParams = z.object({ id: uuid, partId: uuid });
export const tokenParams = z.object({ token: z.string().min(16).max(2000) });

export const visitInput = z.strictObject({
  estimatedMinutes: z.number().int(),
  priority: priority.optional(),
  preferredOn: civilDateInput().nullable().optional(),
  windowStartsAt: optionalInstant,
  windowEndsAt: optionalInstant,
  instructions: optionalText(4000),
  requiredQualificationTypeIds: z.array(uuid).max(50).optional(),
});

const requestFields = {
  customerPartyId: uuid,
  serviceAddressId: optionalUuid,
  contactId: optionalUuid,
  subsidiaryId: optionalUuid,
  title: text(200),
  description: optionalText(8000),
  priority,
  preferredOn: civilDateInput().nullable().optional(),
  preferredTime: z.enum(["any", "morning", "afternoon", "evening"]).optional(),
};

export const createRequestBody = z.strictObject({ id: uuid, ...requestFields });
export const updateRequestBody = z.strictObject({ expectedRevision: revision, ...requestFields });
export const closeRequestBody = z.strictObject({
  expectedRevision: revision,
  outcome: z.enum(["declined", "cancelled"]),
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
  requiredQualificationTypeIds: z.array(uuid).max(50).optional(),
  estimatedMinutes: z.number().int(),
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
  lines: z.array(jobLine).max(500).optional(),
  firstVisit: z
    .strictObject({
      preferredOn: civilDateInput().nullable().optional(),
      windowStartsAt: optionalInstant,
      windowEndsAt: optionalInstant,
      instructions: optionalText(4000),
    })
    .nullable()
    .optional(),
});
export const updateJobBody = z.strictObject({ expectedRevision: revision, ...jobFields });
export const jobLinesBody = z.strictObject({
  expectedRevision: revision,
  lines: z.array(jobLine).max(500),
});
export const jobVisitBody = z.strictObject({ expectedRevision: revision, visit: visitInput });
export const jobLifecycleBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("complete"), expectedRevision: revision }),
  z.strictObject({ action: z.literal("reopen"), expectedRevision: revision, reason }),
  z.strictObject({ action: z.literal("cancel"), expectedRevision: revision, reason }),
]);
export const invoiceBody = z.strictObject({ visitId: optionalUuid });
export const depositBody = z.strictObject({ paymentDocumentId: uuid });
export const applyDepositsBody = z.strictObject({ invoiceDocumentId: uuid });

export const quoteTermsBody = z.strictObject({
  depositBasis: z.enum(["none", "percent", "amount"]),
  depositValue: z.string().trim().max(40),
  optionalLineIds: z.array(uuid).max(500),
});
export const sendQuoteBody = z.strictObject({
  signerName: text(120),
  signerEmail: text(320),
  expiresInDays: z.number().int().optional(),
  message: optionalText(2000),
});
export const convertQuoteBody = z.strictObject({
  id: uuid,
  estimatedMinutes: z.number().int(),
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
  to: z.enum(["dispatched", "en_route", "on_site", "unable_to_complete"]),
  reason: optionalText(2000),
});
export const visitCancelBody = z.strictObject({
  expectedRevision: revision,
  reason,
  skip: z.boolean().optional(),
});
export const visitPartBody = z.strictObject({
  expectedRevision: revision,
  itemId: uuid,
  stockLocationId: uuid,
  quantity: decimal,
  billable: z.boolean(),
  lotId: optionalUuid,
  serialId: optionalUuid,
  memo: optionalText(500),
});
export const visitPartRemoveBody = z.strictObject({ expectedRevision: revision });
export const visitCompleteBody = z.strictObject({
  expectedRevision: revision,
  workNotes: text(8000),
  labor: z
    .array(z.strictObject({ workerPartyId: optionalUuid, startedAt: instant, hours: decimal }))
    .max(20)
    .optional(),
});
export const signatureLinkBody = z.strictObject({
  recipient: optionalText(320),
  email: z.boolean().optional(),
});

const agreementVersion = z.strictObject({
  recurrence: z.strictObject({
    repeat: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int(),
    weekdays: z.array(z.number().int()).max(7).optional(),
    monthlyBy: z.enum(["day", "weekday"]).optional(),
  }),
  windowStarts: z.string().regex(/^\d{2}:\d{2}$/),
  windowEnds: z.string().regex(/^\d{2}:\d{2}$/),
  estimatedMinutes: z.number().int(),
  priority,
  requiredQualificationTypeIds: z.array(uuid).max(50).optional(),
  instructions: optionalText(4000),
  lines: z.array(jobLine).max(200),
});
export const createAgreementBody = z.strictObject({
  id: uuid,
  customerPartyId: uuid,
  serviceAddressId: optionalUuid,
  contactId: optionalUuid,
  subsidiaryId: optionalUuid,
  title: text(200),
  startsOn: civilDateInput(),
  endsOn: civilDateInput().nullable().optional(),
  version: agreementVersion,
  reason,
});
export const agreementVersionBody = z.strictObject({
  expectedRevision: revision,
  effectiveFrom: civilDateInput(),
  version: agreementVersion,
  reason,
});
export const closeAgreementBody = z.strictObject({
  expectedRevision: revision,
  outcome: z.enum(["ended", "cancelled"]),
  endsOn: civilDateInput().nullable().optional(),
  reason,
});

export const dispatchQuery = z.object({ board: uuid, date: civilDateInput() });
const assignmentFields = {
  boardId: uuid,
  workerPartyId: uuid,
  startsAt: instant,
  minutes: z.number().int().optional(),
  overrideReason: optionalText(500),
};
export const previewAssignmentBody = z.strictObject({
  boardId: uuid,
  visitId: uuid,
  workerPartyId: uuid,
  startsAt: instant,
  minutes: z.number().int().optional(),
  movingEntryId: optionalUuid,
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

export const myVisitsQuery = z.object({ from: civilDateInput(), through: civilDateInput() });

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
