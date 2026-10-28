import "server-only";
import { can } from "../authz";
import {
  bulkEditVariants,
  convertItemToFamily,
  createFamilyWithVariants,
  createItemFamily,
  detachVariant,
  generateFamilyVariants,
  getItemFamily,
  listItemFamilies,
  previewGenerateVariants,
  replaceFamilyOptions,
  updateItemFamily,
} from "@openbooks/engine/inventory";
import { type ApplicationToolDefinition } from "./tool-definition";
import {
  inventoryDefinition as definition,
  IDEMPOTENCY_KEY,
  itemHref,
  settleInventoryRefusal,
  UUID,
} from "./inventory-tools-common";
import { assertApplicationPermission } from "./context";
import { forbidden, notFound } from "./errors";
import { z } from "zod";

const AMOUNT = z
  .string()
  .regex(/^\d+(?:\.\d{1,10})?$/)
  .describe("Exact non-negative decimal string; never use a JSON number.");
const optionValue = z
  .union([
    z.string().max(200).describe("Option value."),
    z
      .object({
        value: z.string().max(200).describe("Option value."),
        previousValue: z
          .string()
          .max(200)
          .nullable()
          .optional()
          .describe("Prior value when renaming it."),
      })
      .describe("Option value, with its previous value when renamed."),
  ])
  .describe("One allowed value for an option.");
const familyOption = z
  .object({
    id: UUID.nullable().optional().describe("Existing option UUID, or null for a new option."),
    name: z.string().min(1).max(100).describe("Option name such as Color or Size."),
    values: z.array(optionValue).min(1).max(100).describe("Allowed values, in display order."),
    defaultValue: z
      .string()
      .max(200)
      .nullable()
      .optional()
      .describe("Value assigned to existing variants when adding this option."),
  })
  .describe("One ordered family option.");
const barcode = z
  .object({
    value: z.string().min(1).max(200).describe("Barcode text."),
    kind: z.enum(["gtin", "upc", "ean", "internal"]).describe("Barcode format."),
  })
  .nullable()
  .describe("Barcode to set, or null to clear it.");

const mutate =
  (permission: string) => (authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]) =>
    can(authz, permission);
function assertUnrestricted(context: Parameters<ApplicationToolDefinition["execute"]>[0]): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

export const INVENTORY_FAMILY_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_item_families",
    title: "List Item Families",
    description:
      "Find item families before creating variants or changing family defaults. Use the returned family id with get_item_family and the variant generation tools.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: mutate("items.read"),
    featureKey: "itemVariants",
    execute: async (context) => {
      assertApplicationPermission(context, "items.read");
      return {
        families: await listItemFamilies(context.authz.user.orgId),
        href: "/items/families",
      };
    },
  }),
  definition({
    name: "get_item_family",
    title: "Get Item Family",
    description:
      "Read one family and its options and variants before editing or generating. Find the family id with list_item_families.",
    inputSchema: z.object({ familyId: UUID.describe("Family id from list_item_families.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: mutate("items.read"),
    featureKey: "itemVariants",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.read");
      const family = await getItemFamily(context.authz.user.orgId, input.familyId);
      if (!family) throw notFound("item family");
      return { family, href: `/items/families?family=${encodeURIComponent(input.familyId)}` };
    },
  }),
  definition({
    name: "create_item_family",
    title: "Create Item Family",
    description:
      "Create a family with ordered options before generating variants. Use list_item_families to confirm the family id and its saved options.",
    inputSchema: z.object({
      code: z.string().min(1).max(100).describe("Unique family code."),
      name: z.string().min(1).max(200).describe("Family display name."),
      description: z.string().max(1000).nullable().optional().describe("Family description."),
      category: z.string().max(100).nullable().optional().describe("Item category."),
      kind: z
        .enum(["inventory", "non_inventory", "service", "kit", "assembly"])
        .describe("Kind inherited by generated variants."),
      defaultUnit: z
        .string()
        .max(50)
        .nullable()
        .optional()
        .describe("Default unit inherited by new variants."),
      defaultRate: AMOUNT.nullable()
        .optional()
        .describe("Default exact price inherited by new variants."),
      options: z.array(familyOption).min(1).max(20).describe("Ordered option definitions."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: mutate("items.manage"),
    featureKey: "itemVariants",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertUnrestricted(context);
      try {
        const family = await createItemFamily(context.authz.user.orgId, context.authz.user.id, {
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          category: input.category ?? null,
          kind: input.kind,
          defaultUnit: input.defaultUnit ?? null,
          defaultRate: input.defaultRate ?? null,
          options: input.options,
        });
        return {
          ok: true,
          family,
          href: `/items/families?family=${encodeURIComponent(family.id)}`,
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "create_item_family_with_variants",
    title: "Create Family With Variants",
    description:
      "Create a family and selected variants in one transaction when the option combinations are already decided. Read the result with get_item_family.",
    inputSchema: z.object({
      code: z.string().min(1).max(100).describe("Unique family code."),
      name: z.string().min(1).max(200).describe("Family display name."),
      description: z.string().max(1000).nullable().optional().describe("Family description."),
      category: z.string().max(100).nullable().optional().describe("Item category."),
      kind: z
        .enum(["inventory", "non_inventory", "service", "kit", "assembly"])
        .describe("Kind for the family and variants."),
      defaultUnit: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe("Default unit for generated variants."),
      defaultRate: AMOUNT.nullable()
        .optional()
        .describe("Default exact price for generated variants."),
      codePattern: z
        .string()
        .nullable()
        .optional()
        .describe("Variant code pattern supported by the native family generator."),
      options: z.array(familyOption).min(1).max(20).describe("Ordered option definitions."),
      variants: z
        .array(
          z
            .object({
              optionValues: z
                .record(z.string().max(100), z.string().max(200))
                .describe("Option name to selected value."),
              include: z
                .boolean()
                .nullable()
                .optional()
                .describe("Whether to create this combination."),
              code: z.string().max(100).nullable().optional().describe("Optional code override."),
              price: AMOUNT.nullable().optional().describe("Optional exact price override."),
              barcode: barcode.optional().describe("Optional barcode override."),
            })
            .describe("Variant combination and optional overrides."),
        )
        .min(1)
        .max(2000)
        .nullable()
        .optional()
        .describe("Chosen variants; omit to create the full combination set."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: mutate("items.manage"),
    featureKey: "itemVariants",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertUnrestricted(context);
      try {
        const result = await createFamilyWithVariants(
          context.authz.user.orgId,
          context.authz.user.id,
          {
            code: input.code,
            name: input.name,
            description: input.description ?? null,
            category: input.category ?? null,
            kind: input.kind,
            defaultUnit: input.defaultUnit ?? null,
            defaultRate: input.defaultRate ?? null,
            codePattern: input.codePattern ?? null,
            options: input.options,
            variants: input.variants ?? null,
          },
        );
        return {
          ok: true,
          ...result,
          href: `/items/families?family=${encodeURIComponent(result.family.id)}`,
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "update_item_family",
    title: "Update Item Family",
    description:
      "Change family defaults or status; existing variants keep their current values. Read the current family with get_item_family and verify with that tool after saving.",
    inputSchema: z.object({
      familyId: UUID.describe("Family id from list_item_families."),
      code: z.string().max(100).nullable().optional().describe("New family code."),
      name: z.string().max(200).nullable().optional().describe("New family name."),
      description: z.string().max(1000).nullable().optional().describe("New description."),
      category: z.string().max(100).nullable().optional().describe("New category."),
      kind: z.string().max(32).nullable().optional().describe("New variant kind."),
      defaultUnit: z.string().max(50).nullable().optional().describe("New default unit."),
      defaultRate: AMOUNT.nullable().optional().describe("New default exact rate."),
      status: z.enum(["active", "inactive"]).nullable().optional().describe("Family status."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: mutate("items.manage"),
    featureKey: "itemVariants",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertUnrestricted(context);
      try {
        const family = await updateItemFamily(
          context.authz.user.orgId,
          context.authz.user.id,
          input.familyId,
          {
            code: input.code,
            name: input.name,
            description: input.description,
            category: input.category,
            kind: input.kind,
            defaultUnit: input.defaultUnit,
            defaultRate: input.defaultRate,
            status: input.status,
          },
        );
        return {
          ok: true,
          family,
          href: `/items/families?family=${encodeURIComponent(input.familyId)}`,
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "preview_item_variant_generation",
    title: "Preview Variant Generation",
    description:
      "Preview missing combinations and exact item codes before generating variants. Find the family id with list_item_families.",
    inputSchema: z.object({
      familyId: UUID.describe("Family id from list_item_families."),
      codePattern: z
        .string()
        .nullable()
        .optional()
        .describe("Optional native variant code pattern."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: mutate("items.read"),
    featureKey: "itemVariants",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.read");
      return {
        preview: await previewGenerateVariants(
          context.authz.user.orgId,
          input.familyId,
          input.codePattern ?? null,
        ),
        href: `/items/families?family=${encodeURIComponent(input.familyId)}`,
      };
    },
  }),
  definition({
    name: "generate_item_variants",
    title: "Generate Item Variants",
    description:
      "Create the missing option combinations after reviewing preview_item_variant_generation. Find the family id with list_item_families; repeated generation only creates missing variants.",
    inputSchema: z.object({
      familyId: UUID.describe("Family id from list_item_families."),
      only: z
        .array(z.record(z.string().max(100), z.string().max(200)))
        .max(2000)
        .nullable()
        .optional()
        .describe("Specific option combinations, or null for every combination."),
      codePattern: z
        .string()
        .nullable()
        .optional()
        .describe("Optional native variant code pattern."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: mutate("items.manage"),
    featureKey: "itemVariants",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertUnrestricted(context);
      try {
        const result = await generateFamilyVariants(
          context.authz.user.orgId,
          context.authz.user.id,
          input.familyId,
          { only: input.only, codePattern: input.codePattern },
        );
        return {
          ok: true,
          ...result,
          href: `/items/families?family=${encodeURIComponent(input.familyId)}`,
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "replace_item_family_options",
    title: "Replace Family Options",
    description:
      "Replace option names and values when the family is in draft or when every removed value is unused. Read the family with get_item_family first; the result is available from that same read.",
    inputSchema: z.object({
      familyId: UUID.describe("Family id from list_item_families."),
      options: z
        .array(familyOption)
        .min(1)
        .max(20)
        .describe("The complete ordered option set after the change."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: mutate("items.manage"),
    featureKey: "itemVariants",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertUnrestricted(context);
      try {
        const family = await replaceFamilyOptions(
          context.authz.user.orgId,
          context.authz.user.id,
          input.familyId,
          input.options,
        );
        return {
          ok: true,
          family,
          href: `/items/families?family=${encodeURIComponent(input.familyId)}`,
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "bulk_edit_item_variants",
    title: "Bulk Edit Item Variants",
    description:
      "Set price, cost, barcode or active status on selected variants that belong to one family. Find variant ids with get_item_family and verify the saved values there.",
    inputSchema: z.object({
      familyId: UUID.describe("Family id from list_item_families."),
      variantIds: z.array(UUID).min(1).max(1000).describe("Variant item ids from get_item_family."),
      price: AMOUNT.nullable().optional().describe("Exact price to set, or null to clear."),
      cost: AMOUNT.nullable().optional().describe("Exact cost to set, or null to clear."),
      barcode: barcode.optional().describe("Barcode to set, or null to clear."),
      isActive: z.boolean().nullable().optional().describe("Whether the variants remain active."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: mutate("items.manage"),
    featureKey: "itemVariants",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertUnrestricted(context);
      try {
        const result = await bulkEditVariants(context.authz.user.orgId, context.authz.user.id, {
          variantIds: input.variantIds,
          expectedFamilyId: input.familyId,
          price: input.price,
          cost: input.cost,
          barcode: input.barcode,
          isActive: input.isActive,
        });
        if (!result || result.familyId !== input.familyId) throw notFound("item family");
        return {
          ok: true,
          ...result,
          href: `/items/families?family=${encodeURIComponent(input.familyId)}`,
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "convert_item_to_family",
    title: "Convert Item to Family",
    description:
      "Turn a standalone item into a family and keep it as the first variant. Find the item id with search_items or get_item; read the result with get_item_family.",
    inputSchema: z.object({
      itemId: UUID.describe("Standalone item id from get_item."),
      code: z
        .string()
        .max(100)
        .nullable()
        .optional()
        .describe("Family code, defaulting from the item."),
      name: z
        .string()
        .max(200)
        .nullable()
        .optional()
        .describe("Family name, defaulting from the item."),
      description: z.string().max(1000).nullable().optional().describe("Family description."),
      category: z.string().max(100).nullable().optional().describe("Family category."),
      options: z
        .array(
          z
            .object({
              name: z.string().max(100).describe("Option name."),
              value: z.string().max(200).describe("First variant's option value."),
            })
            .describe("An option/value pair for the existing item."),
        )
        .min(1)
        .max(20)
        .describe("Options that describe the existing item."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: mutate("items.manage"),
    featureKey: "itemVariants",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertUnrestricted(context);
      try {
        const family = await convertItemToFamily(context.authz.user.orgId, context.authz.user.id, {
          itemId: input.itemId,
          code: input.code ?? null,
          name: input.name ?? null,
          description: input.description ?? null,
          category: input.category ?? null,
          options: input.options,
        });
        return {
          ok: true,
          family,
          href: `/items/families?family=${encodeURIComponent(family.id)}`,
        };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "detach_item_variant",
    title: "Detach Item Variant",
    description:
      "Detach a family variant as a standalone catalog item while preserving its item record. Find the variant id with get_item_family and verify it with get_item.",
    inputSchema: z.object({
      itemId: UUID.describe("Variant item id from get_item_family."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: mutate("items.manage"),
    featureKey: "itemVariants",
    execute: async (context, input) => {
      assertApplicationPermission(context, "items.manage");
      assertUnrestricted(context);
      try {
        const result = await detachVariant(
          context.authz.user.orgId,
          context.authz.user.id,
          input.itemId,
        );
        return { ok: true, ...result, href: itemHref(input.itemId) };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
];
