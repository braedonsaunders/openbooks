import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can, type Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import {
  createEquipmentUnit,
  EquipmentIdempotencyConflict,
  type createEquipmentSchema,
} from "../equipment-create";
import {
  deleteEquipmentUnit,
  requestBodySchema as nativeEquipmentUpdateSchema,
  updateEquipmentUnit,
} from "../equipment-actions";
import { capitalizeEquipmentUnit } from "../equipment-capitalization";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID returned by the equipment or project reads.");
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional()
  .describe("Calendar date in YYYY-MM-DD format, or null.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact equipment mutation.");
const canManageAssets = (authz: Authz) => can(authz, "assets.manage");
const equipmentUpdateInput = z
  .object({
    acquiredOn: z
      .string()
      .max(10)
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional()
      .describe("Acquisition date in YYYY-MM-DD format."),
    capacityQuantity: z
      .string()
      .max(80)
      .nullable()
      .optional()
      .describe("Exact decimal capacity amount."),
    capacityUnit: z.string().max(80).nullable().optional().describe("Unit label for capacity."),
    chargeItemId: UUID.nullable().optional().describe("Active equipment charge item id."),
    description: z.string().max(2000).nullable().optional().describe("Equipment description."),
    fixedAssetId: UUID.nullable().optional().describe("Linked fixed asset id."),
    inServiceOn: z
      .string()
      .max(10)
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional()
      .describe("In-service date in YYYY-MM-DD format."),
    name: z.string().max(200).nullable().optional().describe("Equipment unit name."),
    purchasePrice: z
      .string()
      .max(40)
      .regex(/^\d+(?:\.\d{1,4})?$/)
      .optional()
      .describe("Exact decimal acquisition price."),
    revision: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Revision returned by get_equipment; protects against stale writes."),
    rateBookId: UUID.nullable().optional().describe("Project rate book id for equipment billing."),
    serialNumber: z.string().max(200).nullable().optional().describe("Equipment serial number."),
    status: z
      .enum(["draft", "active", "inactive", "retired"])
      .optional()
      .describe("Equipment lifecycle status."),
    subsidiaryId: UUID.nullable().optional().describe("Owning legal entity id."),
    unitNumber: z.string().max(100).nullable().optional().describe("Equipment unit number."),
  })
  .refine(
    (input) => Object.keys(input).length > 0,
    "Provide at least one equipment field to update.",
  );

async function requireEquipment(context: ApplicationContext) {
  if (!(await isFeatureEnabled(context.authz.user.orgId, "projects"))) throw notFound("equipment");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "equipment"))) throw notFound("equipment");
}

function equipmentCreateRequestId(orgId: string, idempotencyKey: string): string {
  // Equipment stores the route's UUID request key as the row id. The catalog
  // accepts the shared opaque retry-key format, so derive a stable org-scoped
  // UUID before entering that same native create path.
  const hex = createHash("sha256").update(`${orgId}:${idempotencyKey}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function settleEquipment(error: unknown): never {
  if (error instanceof EquipmentIdempotencyConflict) {
    throw conflict(error.message, { remedy: error.remedy, code: error.code });
  }
  throw error;
}

async function equipmentResponse(response: Response, id: string, fallbackStatus?: string) {
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof result.error === "string" ? result.error : "Equipment could not be saved";
    const details = {
      ...(typeof result.code === "string" ? { code: result.code } : {}),
      ...(typeof result.remedy === "string" ? { remedy: result.remedy } : {}),
    };
    if (response.status === 404) throw new ApplicationError("not_found", message, 404, details);
    if (response.status === 409) throw conflict(message, details);
    if (response.status === 403) throw new ApplicationError("forbidden", message, 403, details);
    throw invalidInput(message, details);
  }
  return {
    ok: true,
    id,
    status: typeof result.status === "string" ? result.status : fallbackStatus,
    href: `/assets/equipment?equipment=${id}`,
  };
}

const createEquipmentInput = z.object({
  name: z.string().trim().min(1).max(200).describe("Equipment unit name."),
  unitNumber: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .describe("Optional equipment unit number; omitted values use the next EQ number."),
  description: z
    .string()
    .max(2000)
    .nullable()
    .optional()
    .describe("Optional equipment description."),
  subsidiaryId: UUID.nullable().optional().describe("Legal entity that owns this equipment unit."),
  chargeItemId: UUID.nullable()
    .optional()
    .describe("Active equipment charge item; set this before activating the unit."),
  fixedAssetId: UUID.nullable()
    .optional()
    .describe("Optional fixed asset in the same legal entity."),
  rateBookId: UUID.nullable()
    .optional()
    .describe("Optional active project rate book for equipment billing."),
  purchasePrice: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe("Exact decimal acquisition price; never pass a JSON number."),
  acquiredOn: DATE,
  inServiceOn: DATE,
  serialNumber: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("Optional equipment serial number."),
  capacityQuantity: z
    .string()
    .max(40)
    .nullable()
    .optional()
    .describe("Optional positive exact decimal capacity."),
  capacityUnit: z
    .string()
    .max(80)
    .nullable()
    .optional()
    .describe("Unit for the equipment capacity."),
  status: z.enum(["draft"]).optional().describe("New equipment units must start as a draft."),
  idempotencyKey: IDEMPOTENCY_KEY,
});

export const PROJECT_EQUIPMENT_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "create_equipment_unit",
    title: "Create Equipment Unit",
    description:
      "Create a draft equipment unit with optional charge item, rate book, legal entity, and acquisition details. Find related ids with native item, fixed asset, and project rate-book reads; verify the saved unit with get_equipment.",
    inputSchema: createEquipmentInput,
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManageAssets,
    featureKey: "equipment",
    execute: async (context, input) => {
      assertApplicationPermission(context, "assets.manage");
      await requireEquipment(context);
      const { idempotencyKey, ...body } = input;
      try {
        const response = await createEquipmentUnit(
          context.authz,
          equipmentCreateRequestId(context.authz.user.orgId, idempotencyKey),
          body as z.infer<typeof createEquipmentSchema>,
        );
        const result = (await response.json()) as Record<string, unknown>;
        if (!response.ok) {
          const message =
            typeof result.error === "string" ? result.error : "Equipment could not be saved";
          const details = {
            ...(typeof result.code === "string" ? { code: result.code } : {}),
            ...(typeof result.field === "string" ? { field: result.field } : {}),
            ...(typeof result.remedy === "string" ? { remedy: result.remedy } : {}),
          };
          if (response.status === 404)
            throw new ApplicationError("not_found", message, 404, details);
          if (response.status === 409) throw conflict(message, details);
          if (response.status === 403)
            throw new ApplicationError("forbidden", message, 403, details);
          throw invalidInput(message, details);
        }
        const id = typeof result.id === "string" ? result.id : null;
        if (!id)
          throw new ApplicationError("internal_error", "Equipment save returned no unit id", 500);
        return { ok: true, id, status: "draft", href: `/assets/equipment?equipment=${id}` };
      } catch (error) {
        settleEquipment(error);
      }
    },
  }),
  definition({
    name: "update_equipment_unit",
    title: "Update Equipment Unit",
    description:
      "Update an equipment unit's details, legal entity, charge item, rate book, asset link, or lifecycle state using the revision from get_equipment. Use search_equipment and get_equipment to find its id and current revision.",
    inputSchema: z.object({
      equipmentId: UUID.describe("Equipment unit id from search_equipment or get_equipment."),
      updates: equipmentUpdateInput.describe(
        "Equipment fields to update, including the current revision.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManageAssets,
    featureKey: "equipment",
    execute: async (context, input) => {
      assertApplicationPermission(context, "assets.manage");
      await requireEquipment(context);
      let updates: z.infer<typeof nativeEquipmentUpdateSchema>;
      try {
        updates = nativeEquipmentUpdateSchema.parse(input.updates);
      } catch (error) {
        throw invalidInput(error instanceof Error ? error.message : "Equipment update is invalid");
      }
      const response = await updateEquipmentUnit(context.authz, input.equipmentId, updates);
      return equipmentResponse(response, input.equipmentId);
    },
  }),
  definition({
    name: "delete_equipment_unit",
    title: "Delete Equipment Unit",
    description:
      "Delete an unused draft equipment unit. Find it with search_equipment; the native service refuses active units and units with charge history.",
    inputSchema: z.object({
      equipmentId: UUID.describe("Draft equipment unit id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManageAssets,
    featureKey: "equipment",
    execute: async (context, input) => {
      assertApplicationPermission(context, "assets.manage");
      await requireEquipment(context);
      const response = await deleteEquipmentUnit(context.authz, { id: input.equipmentId });
      return equipmentResponse(response, input.equipmentId, "deleted");
    },
  }),
  definition({
    name: "capitalize_equipment_unit",
    title: "Capitalize Equipment Unit",
    description:
      "Create a fixed asset from an equipment unit and link the asset back to the unit. Find the unit with search_equipment; Fixed Assets must be enabled, and verify the result with get_asset and get_equipment.",
    inputSchema: z.object({
      equipmentId: UUID.describe("Equipment unit id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManageAssets,
    featureKey: "equipment",
    execute: async (context, input) => {
      assertApplicationPermission(context, "assets.manage");
      await requireEquipment(context);
      if (!(await isFeatureEnabled(context.authz.user.orgId, "fixedAssets")))
        throw notFound("fixed asset");
      const response = await capitalizeEquipmentUnit(context.authz, { id: input.equipmentId });
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const message =
          typeof result.error === "string" ? result.error : "Equipment could not be capitalized";
        if (response.status === 404) throw new ApplicationError("not_found", message, 404);
        if (response.status === 409) throw conflict(message);
        if (response.status === 403) throw new ApplicationError("forbidden", message, 403);
        throw invalidInput(message);
      }
      const id = typeof result.assetId === "string" ? result.assetId : null;
      if (!id)
        throw new ApplicationError(
          "internal_error",
          "Equipment capitalization returned no asset id",
          500,
        );
      return {
        ok: true,
        id,
        equipmentId: input.equipmentId,
        assetNumber: result.assetNumber,
        status: "capitalized",
        href: `/assets?asset=${id}`,
      };
    },
  }),
];
