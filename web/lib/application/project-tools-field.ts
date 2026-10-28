import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  certifyFieldTicketSourceIdentity,
  FieldTicketSourceCertificationError,
  listFieldTicketSourceCertificationCandidates,
} from "@openbooks/engine/projects/field-ticket-source-certification";
import { can, type Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import {
  addTicketLine,
  discardEmptyTicketDraft,
  FieldTicketError,
  FieldTicketNotFoundError,
  loadFieldTicket,
  removeTicketLine,
  saveCrewGrid,
  updateTicketHeader,
} from "../field-tickets";
import { addTicketQuantity, removeTicketQuantity } from "../field-ticket-production";
import { sendTicketForSignature } from "../field-ticket-signing";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID returned by get_field_ticket or the related project read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const REVISION = z
  .string()
  .min(1)
  .max(200)
  .describe("Exact document revision returned by get_field_ticket.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
const canRead = (authz: Authz) => can(authz, "time.read");
const canManage = (authz: Authz) => can(authz, "time.manage");
const INVENTORY_ITEM_KINDS = new Set(["inventory", "assembly", "kit"]);

async function requireFieldTickets(context: ApplicationContext, child?: string): Promise<void> {
  const orgId = context.authz.user.orgId;
  if (
    !(await isFeatureEnabled(orgId, "projects")) ||
    !(await isFeatureEnabled(orgId, "fieldTickets"))
  ) {
    throw notFound("field ticket");
  }
  if (child && !(await isFeatureEnabled(orgId, child))) throw notFound("field ticket");
}

function settleFieldTicket(error: unknown): never {
  if (error instanceof FieldTicketNotFoundError) throw notFound("field ticket");
  if (error instanceof FieldTicketError) {
    const status = "status" in error && typeof error.status === "number" ? error.status : 422;
    if (status === 409)
      throw conflict(error.message, {
        ...(error instanceof Error
          ? { remedy: (error as Error & { remedy?: string }).remedy }
          : {}),
      });
    throw invalidInput(error.message);
  }
  if (error instanceof FieldTicketSourceCertificationError) {
    if (error.status === 404) throw new ApplicationError("not_found", error.message, 404);
    throw invalidInput(error.message);
  }
  throw error;
}

async function readTicket(context: ApplicationContext, ticketId: string) {
  return loadFieldTicket(context.authz.user.orgId, ticketId, {
    allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
  });
}

const crewRow = z.object({
  employeePartyId: UUID,
  itemId: UUID.nullable().describe("Time item, or null for unclassified time."),
  projectTaskId: UUID.nullable()
    .optional()
    .describe("WBS task for the crew hours, or null for project-only time."),
  timeTypeId: UUID.nullable().describe("Time type assigned to this row."),
  hours: z
    .record(DATE, z.string().max(40).describe("Exact decimal hours for this date."))
    .describe("Hours keyed by work date in YYYY-MM-DD format."),
});

export const PROJECT_FIELD_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_field_ticket_source_certification_candidates",
    title: "List Field Ticket Certification Candidates",
    description:
      "List native field tickets available for source-identity certification, with their revisions and source markers. Use get_field_ticket to inspect ticket details before certifying.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: canRead,
    featureKey: "fieldTickets",
    execute: async (context) => {
      assertApplicationPermission(context, "time.read");
      await requireFieldTickets(context);
      try {
        return {
          ok: true,
          ...(await listFieldTicketSourceCertificationCandidates({
            orgId: context.authz.user.orgId,
            actorId: context.authz.user.id,
          })),
          href: "/field-tickets",
        };
      } catch (error) {
        settleFieldTicket(error);
      }
    },
  }),
  definition({
    name: "certify_field_ticket_source",
    title: "Certify Field Ticket Source",
    description:
      "Record an operator's attestation linking an existing native ticket to a retained external source file and exact revision. Find candidate ids and revisions with list_field_ticket_source_certification_candidates.",
    inputSchema: z.object({
      requestId: UUID,
      nativeDocumentId: UUID,
      expectedNativeRevision: z
        .string()
        .regex(/^\d{1,20}$/)
        .describe("Exact revision from the certification candidate read."),
      sourceSystem: z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i)
        .describe("Stable identifier for the source system."),
      sourceTicketId: z
        .string()
        .min(1)
        .max(200)
        .describe("Exact ticket identifier in the source system."),
      sourceFileId: UUID,
      sourceVersionId: UUID,
      sourceFileSha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe("SHA-256 digest of the retained source file version."),
      attestation: z
        .string()
        .trim()
        .min(8)
        .max(2000)
        .describe("Operator attestation describing the source identity review."),
      reason: z
        .string()
        .trim()
        .min(8)
        .max(2000)
        .describe("Reason this source identity is being certified."),
      explicitReferenceMap: z
        .object({
          jobRef: z.string().trim().min(1).max(200).describe("External project/job reference."),
          customerRef: z
            .string()
            .trim()
            .max(200)
            .nullable()
            .describe("External customer reference, or null."),
          foremanRef: z
            .string()
            .trim()
            .max(200)
            .nullable()
            .describe("External foreman reference, or null."),
          superintendentRef: z
            .string()
            .trim()
            .max(200)
            .nullable()
            .optional()
            .describe("External superintendent reference, when present."),
          projectId: UUID,
          customerPartyId: UUID.nullable().describe("Matched native customer party, or null."),
          foremanPartyId: UUID.nullable().describe("Matched native foreman party, or null."),
          superintendentPartyId: UUID.nullable().describe(
            "Matched native superintendent party, or null.",
          ),
        })
        .describe(
          "Explicit, reviewed mapping from external references to native project and parties.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "fieldTickets",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      await requireFieldTickets(context);
      try {
        const record = await certifyFieldTicketSourceIdentity({
          ...input,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
        });
        return { ok: true, record, href: `/field-tickets/${input.nativeDocumentId}` };
      } catch (error) {
        settleFieldTicket(error);
      }
    },
  }),
  definition({
    name: "update_field_ticket_header",
    title: "Update Field Ticket Header",
    description:
      "Update a draft field ticket's project, date, purchase order, memo, period, or foreman using its current revision. Find the ticket and related project or party ids with get_field_ticket and their native reads.",
    inputSchema: z.object({
      ticketId: UUID.describe("Field ticket id."),
      expectedRevision: REVISION,
      documentDate: DATE.optional().describe("Ticket document date in YYYY-MM-DD format."),
      projectId: UUID.nullable()
        .optional()
        .describe("Project assigned to this ticket; null is refused."),
      foremanPartyId: UUID.nullable().optional().describe("Foreman party id, or null to clear."),
      period: z
        .enum(["shift", "daily", "weekly"])
        .optional()
        .describe("Ticket period aggregation."),
      referenceNumber: z
        .string()
        .max(100)
        .nullable()
        .optional()
        .describe("Purchase order or external reference number."),
      memo: z.string().max(2000).nullable().optional().describe("Ticket memo."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "fieldTickets",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      await requireFieldTickets(context);
      await readTicket(context, input.ticketId);
      try {
        await updateTicketHeader(
          context.authz.user.orgId,
          context.authz.user.id,
          input.ticketId,
          {
            ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
            ...(input.documentDate !== undefined ? { documentDate: input.documentDate } : {}),
            ...(input.referenceNumber !== undefined
              ? { referenceNumber: input.referenceNumber }
              : {}),
            ...(input.memo !== undefined ? { memo: input.memo } : {}),
            ...(input.period !== undefined ? { period: input.period } : {}),
            ...(input.foremanPartyId !== undefined ? { foremanPartyId: input.foremanPartyId } : {}),
          },
          input.expectedRevision,
          context.authz.allowedSubsidiaryIds,
        );
        const ticket = await readTicket(context, input.ticketId);
        return { ok: true, ticket, href: `/field-tickets/${input.ticketId}` };
      } catch (error) {
        settleFieldTicket(error);
      }
    },
  }),
  definition({
    name: "save_field_ticket_crew_grid",
    title: "Save Field Ticket Crew Grid",
    description:
      "Replace the crew time grid on a draft ticket using its current revision. Find ticket and employee ids with get_field_ticket and organization people reads.",
    inputSchema: z.object({
      ticketId: UUID,
      expectedRevision: REVISION,
      rows: z.array(crewRow).max(1000).describe("Complete replacement set of crew time rows."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "fieldTickets",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      await requireFieldTickets(context);
      try {
        await saveCrewGrid(
          context.authz.user.orgId,
          context.authz.user.id,
          input.ticketId,
          input.rows as never,
          input.expectedRevision,
          context.authz.allowedSubsidiaryIds,
        );
        const ticket = await readTicket(context, input.ticketId);
        return { ok: true, ticket, href: `/field-tickets/${input.ticketId}` };
      } catch (error) {
        settleFieldTicket(error);
      }
    },
  }),
  definition({
    name: "add_field_ticket_line",
    title: "Add Field Ticket Charge Line",
    description:
      "Add an item or equipment charge line to a draft ticket using its current revision and the native rate engine. Find item and equipment ids with their native read tools; verify through get_field_ticket.",
    inputSchema: z.object({
      ticketId: UUID,
      expectedRevision: REVISION,
      itemId: UUID,
      quantity: z.string().min(1).max(40).describe("Positive exact decimal quantity."),
      equipmentUnitId: UUID.nullable()
        .optional()
        .describe("Equipment unit used for this line, when applicable."),
      rateUnitCode: z
        .string()
        .max(64)
        .nullable()
        .optional()
        .describe("Selected rate-book unit code."),
      employeeId: UUID.nullable()
        .optional()
        .describe("Employee who used the equipment, when applicable."),
      description: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Line description override."),
      projectTaskId: UUID.nullable()
        .optional()
        .describe("Project task receiving this line's cost."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "fieldTickets",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      await requireFieldTickets(context);
      const orgId = context.authz.user.orgId;
      if (input.equipmentUnitId && !(await isFeatureEnabled(orgId, "equipment")))
        throw notFound("field ticket");
      const item = await db.execute<{ kind: string }>(
        sql`select kind from items where id = ${input.itemId} and org_id = ${orgId}`,
        "objects",
      );
      if (!item[0]) throw notFound("item");
      if (!(await isFeatureEnabled(orgId, "inventory")) && INVENTORY_ITEM_KINDS.has(item[0].kind))
        throw notFound("field ticket");
      if (!(await isFeatureEnabled(orgId, "equipment")) && item[0].kind === "equipment_charge")
        throw notFound("field ticket");
      try {
        await addTicketLine(
          orgId,
          context.authz.user.id,
          input.ticketId,
          {
            itemId: input.itemId,
            quantity: input.quantity,
            equipmentUnitId: input.equipmentUnitId ?? null,
            rateUnitCode: input.rateUnitCode ?? null,
            employeeId: input.employeeId ?? null,
            description: input.description ?? null,
            projectTaskId: input.projectTaskId ?? null,
          },
          input.expectedRevision,
          context.authz.allowedSubsidiaryIds,
        );
        const ticket = await readTicket(context, input.ticketId);
        return { ok: true, ticket, href: `/field-tickets/${input.ticketId}` };
      } catch (error) {
        settleFieldTicket(error);
      }
    },
  }),
  definition({
    name: "remove_field_ticket_line",
    title: "Remove Field Ticket Charge Line",
    description:
      "Remove a charge line from a draft ticket at its current revision. Find line ids with get_field_ticket and verify the saved ticket there.",
    inputSchema: z.object({
      ticketId: UUID,
      lineId: UUID,
      expectedRevision: REVISION,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "fieldTickets",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      await requireFieldTickets(context);
      try {
        await removeTicketLine(
          context.authz.user.orgId,
          input.ticketId,
          input.lineId,
          input.expectedRevision,
          context.authz.allowedSubsidiaryIds,
        );
        const ticket = await readTicket(context, input.ticketId);
        return { ok: true, ticket, href: `/field-tickets/${input.ticketId}` };
      } catch (error) {
        settleFieldTicket(error);
      }
    },
  }),
  definition({
    name: "add_field_ticket_quantity",
    title: "Add Field Ticket Production Quantity",
    description:
      "Add installed production quantity to a draft ticket and a budgeted task under Progress tracking. Find the task and its unit with list_project_work_breakdown; use get_field_ticket for the ticket revision.",
    inputSchema: z.object({
      ticketId: UUID,
      expectedRevision: REVISION,
      projectTaskId: UUID,
      quantity: z.string().min(1).max(40).describe("Positive exact decimal installed quantity."),
      unit: z.string().trim().min(1).max(32).describe("Unit matching the task production budget."),
      note: z.string().max(500).nullable().optional().describe("Optional production note."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "projectProgress",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      await requireFieldTickets(context, "projectProgress");
      try {
        await addTicketQuantity(
          context.authz.user.orgId,
          context.authz.user.id,
          input.ticketId,
          {
            projectTaskId: input.projectTaskId,
            quantity: input.quantity,
            unit: input.unit,
            note: input.note ?? null,
          },
          input.expectedRevision,
          context.authz.allowedSubsidiaryIds,
        );
        const ticket = await readTicket(context, input.ticketId);
        return { ok: true, ticket, href: `/field-tickets/${input.ticketId}` };
      } catch (error) {
        settleFieldTicket(error);
      }
    },
  }),
  definition({
    name: "remove_field_ticket_quantity",
    title: "Remove Field Ticket Production Quantity",
    description:
      "Remove a production quantity from a draft ticket at its current revision. Find quantity ids with get_field_ticket and verify the result there.",
    inputSchema: z.object({
      ticketId: UUID,
      quantityId: UUID,
      expectedRevision: REVISION,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "projectProgress",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      await requireFieldTickets(context, "projectProgress");
      try {
        await removeTicketQuantity(
          context.authz.user.orgId,
          context.authz.user.id,
          input.ticketId,
          input.quantityId,
          input.expectedRevision,
          context.authz.allowedSubsidiaryIds,
        );
        const ticket = await readTicket(context, input.ticketId);
        return { ok: true, ticket, href: `/field-tickets/${input.ticketId}` };
      } catch (error) {
        settleFieldTicket(error);
      }
    },
  }),
  definition({
    name: "send_field_ticket_for_signature",
    title: "Send Field Ticket for Signature",
    description:
      "Email an approved ticket PDF and a possession-authenticated customer signature link. Find the ticket with get_field_ticket; it must be approved and have a current revision.",
    inputSchema: z.object({
      ticketId: UUID,
      expectedRevision: REVISION,
      to: z
        .string()
        .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
        .max(320)
        .describe("Customer email address for the signing link."),
      message: z
        .string()
        .max(1000)
        .nullable()
        .optional()
        .describe("Optional message included in the email."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "fieldTickets",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      await requireFieldTickets(context);
      const appBaseUrl = process.env.OPENBOOKS_APP_URL?.trim();
      if (!appBaseUrl)
        throw invalidInput("Configure the application URL before sending customer signing links.");
      try {
        const result = await sendTicketForSignature({
          orgId: context.authz.user.orgId,
          userId: context.authz.user.id,
          ticketId: input.ticketId,
          expectedRevision: input.expectedRevision,
          to: input.to,
          message: input.message ?? null,
          appBaseUrl,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return {
          ok: true,
          ...result,
          ticketId: input.ticketId,
          href: `/field-tickets/${input.ticketId}`,
        };
      } catch (error) {
        settleFieldTicket(error);
      }
    },
  }),
  definition({
    name: "discard_empty_field_ticket_draft",
    title: "Discard Empty Field Ticket Draft",
    description:
      "Discard an untouched draft ticket using its current revision; tickets with content, signatures, links, or later status are refused. Find and verify it with get_field_ticket.",
    inputSchema: z.object({
      ticketId: UUID,
      expectedRevision: REVISION,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManage,
    featureKey: "fieldTickets",
    execute: async (context, input) => {
      assertApplicationPermission(context, "time.manage");
      await requireFieldTickets(context);
      try {
        await discardEmptyTicketDraft(
          context.authz.user.orgId,
          context.authz.user.id,
          input.ticketId,
          input.expectedRevision,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, id: input.ticketId, href: "/field-tickets" };
      } catch (error) {
        settleFieldTicket(error);
      }
    },
  }),
];
