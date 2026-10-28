import "server-only";
import { can } from "../authz";
import { getItemRateBookVersion, rateBookBody, saveItemRateBook } from "../item-rate-book-service";
import {
  getItemRateVersions,
  itemRatesBody,
  saveItemRateVersion,
} from "../item-rate-version-service";
import { type ApplicationToolDefinition } from "./tool-definition";
import {
  inventoryDefinition as definition,
  DATE,
  IDEMPOTENCY_KEY,
  UUID,
} from "./inventory-tools-common";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, forbidden, notFound } from "./errors";
import { z } from "zod";

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Native refusal responses should be JSON; use a stable fallback if one is not.
  }
  if (response.ok) return body;
  const message = typeof body.error === "string" ? body.error : "Rate configuration was refused.";
  const details = { ...body };
  delete details.error;
  if (response.status === 404) throw new ApplicationError("not_found", message, 404, details);
  if (response.status === 403) throw new ApplicationError("forbidden", message, 403, details);
  if (response.status === 409) throw conflict(message, details);
  if (response.status >= 400 && response.status < 500) {
    throw new ApplicationError("invalid_input", message, response.status, details);
  }
  throw new ApplicationError("internal_error", message, response.status, details);
}

function assertUnrestricted(context: Parameters<ApplicationToolDefinition["execute"]>[0]): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

const bookInput = rateBookBody.extend({
  id: z
    .union([UUID, z.literal("")])
    .optional()
    .describe("Existing rate-book id to update, or omit to create a book."),
  code: z.string().trim().min(1).max(100).describe("Unique rate-book code."),
  name: z.string().trim().min(1).max(200).describe("Rate-book display name."),
  currency: z.string().max(3).optional().describe("Optional three-letter rate-book currency."),
  effectiveFrom: DATE.optional().describe(
    "Start date for the replacement version in YYYY-MM-DD format.",
  ),
  effectiveTo: DATE.nullable().optional().describe("End date for the replacement version."),
  lines: z
    .array(
      z
        .object({
          itemId: UUID.optional().describe("Item id from search_items or get_item."),
          unitCode: z.string().max(50).optional().describe("Rate unit code."),
          unitName: z.string().max(100).optional().describe("Rate unit display name."),
          baseQuantity: z
            .string()
            .regex(/^\d+(?:\.\d{1,4})?$/)
            .optional()
            .describe("Exact positive quantity for this rate unit."),
          costRate: z
            .string()
            .regex(/^\d+(?:\.\d{1,4})?$/)
            .nullable()
            .optional()
            .describe("Exact non-negative cost rate, or null when not supplied."),
          billRate: z
            .string()
            .regex(/^\d+(?:\.\d{1,4})?$/)
            .optional()
            .describe("Exact non-negative bill rate."),
          baseUnit: z
            .string()
            .max(50)
            .optional()
            .describe("Base unit inherited by the item rate profile."),
          pricingPolicy: z
            .enum(["capped_ladder", "lowest_cost"])
            .optional()
            .describe("Pricing policy for this item."),
          invoicePresentation: z
            .enum(["summary", "rate_components"])
            .optional()
            .describe("Invoice presentation for this item."),
          timeTypeBillRates: z
            .record(
              UUID,
              z
                .string()
                .regex(/^\d+(?:\.\d{1,4})?$/)
                .describe("Exact per-time-type bill rate."),
            )
            .optional()
            .describe("Per-time-type bill rates keyed by active time-type id."),
        })
        .describe("One item's rate lines and profile for the new version."),
    )
    .max(2000)
    .optional()
    .describe(
      "Complete rate lines for the replacement version; blank rows are ignored by the native validator.",
    ),
  idempotencyKey: IDEMPOTENCY_KEY,
});

const itemVersionInput = itemRatesBody.extend({
  rateBookId: UUID.nullable()
    .optional()
    .describe("Active rate-book id, or null to use the default book."),
  baseUnit: z.string().trim().min(1).max(50).describe("Base unit used by the item rate profile."),
  effectiveFrom: DATE.describe("Effective start date in YYYY-MM-DD format."),
  tiers: z
    .array(
      z
        .object({
          unitCode: z.string().trim().min(1).max(50).describe("Unique code for this rate unit."),
          unitName: z.string().trim().min(1).max(100).describe("Display name for this rate unit."),
          baseQuantity: z
            .string()
            .regex(/^\d+(?:\.\d{1,4})?$/)
            .describe("Exact positive quantity at this rate tier."),
          costRate: z
            .string()
            .regex(/^\d+(?:\.\d{1,4})?$/)
            .describe("Exact non-negative cost rate."),
          billRate: z
            .string()
            .regex(/^\d+(?:\.\d{1,4})?$/)
            .describe("Exact non-negative bill rate."),
          timeTypeBillRates: z
            .record(
              UUID,
              z
                .string()
                .regex(/^\d+(?:\.\d{1,4})?$/)
                .describe("Exact per-time-type bill rate."),
            )
            .optional()
            .describe("Per-time-type bill rates keyed by active time-type id."),
        })
        .describe("One rate unit for this item version."),
    )
    .min(1)
    .max(2000)
    .describe("One or more rate units for this item version."),
  idempotencyKey: IDEMPOTENCY_KEY,
});
export const INVENTORY_RATE_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_item_rate_versions",
    title: "Get Item Rate Versions",
    description:
      "Read an item's effective rate versions, profile, and active time types before changing its rates. Find the item id with search_items or get_item.",
    inputSchema: z.object({ itemId: UUID.describe("Item id from search_items or get_item.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "items.read"),
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.read");
      const result = await responseBody(await getItemRateVersions(input.itemId, context.authz));
      return { ...result, href: `/items?item=${encodeURIComponent(input.itemId)}` };
    },
  }),
  definition({
    name: "get_item_rate_book_version",
    title: "Get Item Rate Book Version",
    description:
      "Read the latest active rate version and its lines before changing an item rate book. Find the book id with list_setup_records for item-rate-books and verify the result in Items → Rate Books.",
    inputSchema: z.object({
      bookId: UUID.describe("Rate-book id from list_setup_records for item-rate-books."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      assertUnrestricted(context);
      const version = await getItemRateBookVersion(context.authz.user.orgId, input.bookId);
      if (!version) throw notFound("item rate book");
      return { ...version, href: "/items?view=rate-books" };
    },
  }),
  definition({
    name: "create_item_rate_version",
    title: "Create Item Rate Version",
    description:
      "Save a new effective-dated rate version and its complete item tier schedule. Find the item id with search_items, then verify the active version through the item's rate read.",
    inputSchema: z
      .object({ itemId: UUID.describe("Item id from search_items or get_item.") })
      .merge(itemVersionInput),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "items.manage"),
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertUnrestricted(context);
      const { itemId, idempotencyKey: _key, ...body } = input;
      const result = await responseBody(await saveItemRateVersion(itemId, body, context.authz));
      return { ok: true, ...result, href: `/items?item=${encodeURIComponent(itemId)}` };
    },
  }),
  definition({
    name: "save_item_rate_book_version",
    title: "Save Item Rate Book Version",
    description:
      "Create a new effective-dated version of a rate book and replace its complete rate lines. Find item ids with search_items and the book id in the Rate Books view under Items; verify the saved version there.",
    inputSchema: bookInput,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    featureKey: "projects",
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      assertUnrestricted(context);
      const { idempotencyKey: _key, ...body } = input;
      const result = await responseBody(await saveItemRateBook(body, context.authz));
      return { ok: true, ...result, href: "/items?view=rate-books" };
    },
  }),
];
