import "server-only";
import { can } from "../authz";
import {
  getSchedules,
  postSchedule,
  patchSchedule,
  deleteSchedule,
  type ScheduleActor,
  type ScheduleSubject,
} from "../../app/api/_pricing/schedule-store";
import { type ApplicationToolDefinition } from "./tool-definition";
import {
  inventoryDefinition as definition,
  DATE,
  IDEMPOTENCY_KEY,
  nativeIdempotencyUuid,
  UUID,
} from "./inventory-tools-common";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { z } from "zod";

const MONEY = z
  .string()
  .regex(/^\d+(?:\.\d{1,4})?$/)
  .describe("Exact non-negative decimal string; never use a JSON number.");
const subjectHref = (subject: ScheduleSubject) =>
  subject.kind === "item"
    ? `/items?item=${encodeURIComponent(subject.id)}`
    : `/items/families?family=${encodeURIComponent(subject.id)}`;
const actorFor = (context: Parameters<ApplicationToolDefinition["execute"]>[0]): ScheduleActor => ({
  orgId: context.authz.user.orgId,
  actorId: context.authz.user.id,
  allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
});
function assertUnrestrictedFamily(
  context: Parameters<ApplicationToolDefinition["execute"]>[0],
  family: boolean,
): void {
  if (family && context.authz.allowedSubsidiaryIds !== null)
    throw forbidden("subsidiary.unrestricted");
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    /* the route returned no JSON body */
  }
  if (response.ok) return payload;
  const message =
    typeof payload.error === "string" ? payload.error : "Pricing schedule request was refused.";
  if (response.status === 404) throw notFound("price schedule");
  if (response.status === 403) throw new ApplicationError("forbidden", message, 403, payload);
  if (response.status === 409) throw conflict(message, payload);
  throw invalidInput(message, payload);
}

function scheduleRead(subject: ScheduleSubject, family: boolean): ApplicationToolDefinition {
  return definition({
    name: family ? "list_item_family_price_schedules" : "list_item_price_schedules",
    title: family ? "List Item Family Price Schedules" : "List Item Price Schedules",
    description: family
      ? "Read a family's active and retained price schedule revisions before changing them. Find the family id with list_item_families."
      : "Read an item's active and retained price schedule revisions before changing them. Find the item id with search_items or get_item.",
    inputSchema: z.object({
      subjectId: UUID.describe(
        family ? "Family id from list_item_families." : "Item id from get_item.",
      ),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "items.read"),
    ...(family ? { featureKey: "itemVariants" } : {}),
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.read");
      const scoped = { ...subject, id: input.subjectId } as ScheduleSubject;
      const schedules = await getSchedules(actorFor(context), scoped);
      if (!schedules) throw notFound(family ? "item family" : "item");
      return { ...schedules, href: subjectHref(scoped) };
    },
  });
}

function scheduleCreate(subject: ScheduleSubject, family: boolean): ApplicationToolDefinition {
  const name = family ? "create_item_family_price_schedule" : "create_item_price_schedule";
  return definition({
    name,
    title: family ? "Create Item Family Price Schedule" : "Create Item Price Schedule",
    description: family
      ? "Create an effective-dated quantity price schedule for a product family. Find the family id with list_item_families and verify the saved revision with list_item_family_price_schedules."
      : "Create an effective-dated quantity price schedule for an item. Find the item id with search_items or get_item and verify the saved revision with list_item_price_schedules.",
    inputSchema: z.object({
      subjectId: UUID.describe(
        family ? "Family id from list_item_families." : "Item id from get_item.",
      ),
      priceLevelId: UUID.nullable()
        .optional()
        .describe("Price level id, or null when this is customer-specific."),
      customerId: UUID.optional().describe("Customer party id for a customer-specific schedule."),
      currency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .describe("Three-letter currency code."),
      quantityBasis: z
        .enum(["line_quantity", "overall_item_quantity"])
        .optional()
        .describe("Quantity used to choose a break."),
      effectiveFrom: DATE.describe("Effective start date in YYYY-MM-DD format."),
      effectiveTo: DATE.nullable()
        .optional()
        .describe("Effective end date, or null for an open-ended schedule."),
      isActive: z.boolean().optional().describe("Whether the schedule is active."),
      breaks: z
        .array(
          z
            .object({
              minimumQuantity: MONEY.describe("Minimum exact quantity for the break."),
              unitPrice: MONEY.describe("Exact unit price at the break."),
            })
            .describe("One quantity and price break."),
        )
        .min(1)
        .max(1000)
        .describe("Ordered quantity price breaks."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "items.manage"),
    ...(family ? { featureKey: "itemVariants" } : {}),
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertUnrestrictedFamily(context, family);
      const scoped = { ...subject, id: input.subjectId } as ScheduleSubject;
      const { subjectId: _id, idempotencyKey, ...body } = input;
      const request = new Request("http://openbooks.local", {
        method: "POST",
        headers: {
          "Idempotency-Key": nativeIdempotencyUuid(idempotencyKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const result = await readResponse(
        await postSchedule(request, actorFor(context), scoped, body),
      );
      return { ok: true, ...result, href: subjectHref(scoped) };
    },
  });
}

function scheduleUpdate(subject: ScheduleSubject, family: boolean): ApplicationToolDefinition {
  return definition({
    name: family ? "update_item_family_price_schedule" : "update_item_price_schedule",
    title: family ? "Update Item Family Price Schedule" : "Update Item Price Schedule",
    description: family
      ? "Create a controlled revision of a family price schedule using the revision copied from list_item_family_price_schedules. Find the family id with list_item_families and read the new revision there."
      : "Create a controlled revision of an item price schedule using the revision copied from list_item_price_schedules. Find the item id with get_item and read the new revision there.",
    inputSchema: z.object({
      subjectId: UUID.describe(
        family ? "Family id from list_item_families." : "Item id from get_item.",
      ),
      id: UUID.describe("Schedule id from the schedule read."),
      revision: z
        .number()
        .int()
        .nonnegative()
        .describe("Current schedule revision from the schedule read."),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe(
          "Required by the native writer when changing a schedule that affects prior dates.",
        ),
      priceLevelId: UUID.nullable()
        .optional()
        .describe("Price level id, or null when this is customer-specific."),
      customerId: UUID.optional().describe("Customer party id for a customer-specific schedule."),
      currency: z
        .string()
        .trim()
        .regex(/^[A-Za-z]{3}$/)
        .describe("Three-letter currency code."),
      quantityBasis: z
        .enum(["line_quantity", "overall_item_quantity"])
        .optional()
        .describe("Quantity used to choose a break."),
      effectiveFrom: DATE.describe("Effective start date in YYYY-MM-DD format."),
      effectiveTo: DATE.nullable()
        .optional()
        .describe("Effective end date, or null for an open-ended schedule."),
      isActive: z.boolean().optional().describe("Whether the new schedule revision is active."),
      breaks: z
        .array(
          z
            .object({
              minimumQuantity: MONEY.describe("Minimum exact quantity for the break."),
              unitPrice: MONEY.describe("Exact unit price at the break."),
            })
            .describe("One quantity and price break."),
        )
        .min(1)
        .max(1000)
        .describe("Complete quantity price break set."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "items.manage"),
    ...(family ? { featureKey: "itemVariants" } : {}),
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertUnrestrictedFamily(context, family);
      const scoped = { ...subject, id: input.subjectId } as ScheduleSubject;
      const { subjectId: _id, idempotencyKey: _key, ...body } = input;
      const request = new Request("http://openbooks.local", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await readResponse(await patchSchedule(request, actorFor(context), scoped));
      return { ok: true, ...result, href: subjectHref(scoped) };
    },
  });
}

function scheduleDelete(subject: ScheduleSubject, family: boolean): ApplicationToolDefinition {
  return definition({
    name: family ? "delete_item_family_price_schedule" : "delete_item_price_schedule",
    title: family ? "Delete Item Family Price Schedule" : "Delete Item Price Schedule",
    description: family
      ? "End-date a family price schedule revision with a reason and current revision token; price history remains preserved. Find the schedule id and revision with list_item_family_price_schedules."
      : "End-date an item price schedule revision with a reason and current revision token; price history remains preserved. Find the schedule id and revision with list_item_price_schedules.",
    inputSchema: z.object({
      subjectId: UUID.describe(
        family ? "Family id from list_item_families." : "Item id from get_item.",
      ),
      scheduleId: UUID.describe("Schedule id from the schedule read."),
      revision: z
        .number()
        .int()
        .nonnegative()
        .describe("Current schedule revision from the schedule read."),
      reason: z.string().min(1).max(500).describe("Reason for ending this schedule."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "items.manage"),
    ...(family ? { featureKey: "itemVariants" } : {}),
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertUnrestrictedFamily(context, family);
      const scoped = { ...subject, id: input.subjectId } as ScheduleSubject;
      const query = new URLSearchParams({
        schedule: input.scheduleId,
        revision: String(input.revision),
        reason: input.reason,
      });
      const request = new Request(`http://openbooks.local?${query}`);
      const result = await readResponse(await deleteSchedule(request, actorFor(context), scoped));
      return { ok: true, ...result, href: subjectHref(scoped) };
    },
  });
}

export const INVENTORY_SCHEDULE_TOOLS: ApplicationToolDefinition[] = [
  scheduleRead({ kind: "item", id: "" }, false),
  scheduleCreate({ kind: "item", id: "" }, false),
  scheduleUpdate({ kind: "item", id: "" }, false),
  scheduleDelete({ kind: "item", id: "" }, false),
  scheduleRead({ kind: "family", id: "" }, true),
  scheduleCreate({ kind: "family", id: "" }, true),
  scheduleUpdate({ kind: "family", id: "" }, true),
  scheduleDelete({ kind: "family", id: "" }, true),
];
