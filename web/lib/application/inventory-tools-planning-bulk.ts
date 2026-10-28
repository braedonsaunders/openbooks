import "server-only";
import { can } from "../authz";
import {
  bulkConvertPlanSuggestions,
  Body as bulkConvertBody,
} from "../inventory-planning-bulk-conversion";
import { type ApplicationToolDefinition } from "./tool-definition";
import {
  inventoryDefinition as definition,
  IDEMPOTENCY_KEY,
  settleInventoryRefusal,
} from "./inventory-tools-common";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";

async function readConversion(response: Response): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Keep a stable refusal if the native route returned no body.
  }
  if (response.ok) return body;
  const message =
    typeof body.message === "string"
      ? body.message
      : typeof body.error === "string"
        ? body.error
        : "Planning suggestion conversion was refused.";
  if (response.status === 403) throw new ApplicationError("forbidden", message, 403, body);
  if (response.status === 404) throw notFound("planning suggestion");
  if (response.status === 409) throw conflict(message, body);
  throw invalidInput(message, body);
}

export const INVENTORY_PLANNING_BULK_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "bulk_convert_plan_suggestions",
    title: "Bulk Convert Planning Suggestions",
    description:
      "Convert a batch of confirmed purchase and transfer suggestions, grouping purchase suggestions by supplier. Find suggestion ids with list_plan_suggestions and verify the created draft orders or transfers there and in their native lists.",
    inputSchema: bulkConvertBody.extend({
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "inventory.plan"),
    featureKey: "demandPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "inventory.plan");
      try {
        const { idempotencyKey: _key, ...body } = input;
        const result = await readConversion(await bulkConvertPlanSuggestions(context.authz, body));
        return { ok: true, ...result, href: "/inventory/planning" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
];
