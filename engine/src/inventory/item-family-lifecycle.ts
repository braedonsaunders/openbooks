import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { InventoryError } from "./contracts.ts";
import {
  assertCombination,
  assertItemVariantsFeature,
  assertRate,
  assertVariantKind,
  BARCODE_KINDS,
  cartesianCombinations,
  cleanText,
  combinationKey,
  DEFAULT_VARIANT_CODE_PATTERN,
  ItemFamilyError,
  MAX_GENERATED_PER_CALL,
  normalizeFamilyOptions,
  renderVariantCode,
  requiredText,
  textArrayLiteral,
  toFamilyRecord,
  variantDisplayName,
  type BulkBarcodeInput,
  type FamilyOptionInput,
  type FamilyOptionRecord,
  type FamilyRow,
  type ItemFamilyDetail,
  type ItemFamilyRecord,
  type OptionCombination,
  type VariantRecord,
} from "./item-family-model.ts";
import { loadOptions, lockFamily, writeFamilyAudit } from "./item-family-store.ts";
import type { GeneratedVariant } from "./item-family-generation.ts";

/**
 * Family lifecycle: create, edit, convert a standalone item into a family,
 * and create a family with its variants atomically. Composes the model and
 * the store; never the option, generation, or variant writers.
 */

export interface CreateFamilyInput {
  code: string;
  name: string;
  description?: string | null;
  category?: string | null;
  kind: string;
  defaultUnit?: string | null;
  defaultRate?: string | null;
  options: FamilyOptionInput[];
}

/**
 * Create a family with its ordered options. The family code is unique per
 * organization; a taken code is refused naming the code and the remedy.
 */
export async function createItemFamily(
  orgId: string,
  actorId: string | null,
  input: CreateFamilyInput,
): Promise<ItemFamilyDetail> {
  const code = requiredText(input.code, "a family code", 60);
  const name = requiredText(input.name, "a family name");
  const kind = assertVariantKind(input.kind.trim());
  const description = cleanText(input.description, "description", 1000);
  const category = cleanText(input.category, "category");
  const defaultUnit = cleanText(input.defaultUnit, "unit", 40);
  const defaultRate = assertRate(input.defaultRate, "default rate");
  const options = normalizeFamilyOptions(input.options);
  return db.transaction(async (tx) => {
    await assertItemVariantsFeature(tx, orgId);
    const taken =
      (
        await tx.execute(
          sql`
      select 1 from item_families where org_id = ${orgId} and code = ${code}`,
          "objects",
        )
      ).length > 0;
    if (taken) {
      throw new ItemFamilyError(
        `family code ${code} is already in use`,
        "family_code_taken",
        `choose a different family code; the code prefixes every generated variant code`,
        409,
      );
    }
    const family = (
      await tx.execute<FamilyRow>(
        sql`
      insert into item_families
        (org_id, code, name, description, category, kind, default_unit, default_rate, status, created_by, updated_by)
      values
        (${orgId}, ${code}, ${name}, ${description}, ${category}, ${kind}, ${defaultUnit}, ${defaultRate}, 'active', ${actorId}, ${actorId})
      returning id, code, name, description, category, kind, default_unit, default_rate, status`,
        "objects",
      )
    )[0];
    if (!family) throw new InventoryError("product family was not created");
    let position = 0;
    for (const option of options) {
      position += 1;
      const inserted = (
        await tx.execute<{ id: string }>(
          sql`
        insert into item_family_options
          (org_id, family_id, position, name, "values", created_by, updated_by)
        values
          (${orgId}, ${family.id}, ${position}, ${option.name}, ${textArrayLiteral(option.values.map((entry) => entry.value))}::text[], ${actorId}, ${actorId})
        returning id`,
          "objects",
        )
      )[0];
      if (!inserted) throw new InventoryError(`family option ${option.name} was not created`);
    }
    const detail: ItemFamilyDetail = {
      ...toFamilyRecord(family),
      options: await loadOptions(tx, orgId, family.id),
      variants: [],
    };
    await writeFamilyAudit(tx, orgId, actorId, "item_families", family.id, "insert", {
      event: "family_created",
      after: detail,
    });
    return detail;
  });
}

export interface UpdateFamilyInput {
  code?: string | null;
  name?: string | null;
  description?: string | null;
  category?: string | null;
  kind?: string | null;
  defaultUnit?: string | null;
  defaultRate?: string | null;
  status?: string | null;
}

/** Edit family defaults. Future generations inherit them; variants keep theirs. */
export async function updateItemFamily(
  orgId: string,
  actorId: string | null,
  familyId: string,
  patch: UpdateFamilyInput,
): Promise<ItemFamilyRecord> {
  return db.transaction(async (tx) => {
    await assertItemVariantsFeature(tx, orgId);
    const current = await lockFamily(tx, orgId, familyId);
    const before = toFamilyRecord(current);
    const code =
      patch.code === undefined ? before.code : requiredText(patch.code, "a family code", 60);
    const name = patch.name === undefined ? before.name : requiredText(patch.name, "a family name");
    const kind =
      patch.kind === undefined ? before.kind : assertVariantKind((patch.kind ?? "").trim());
    const description =
      patch.description === undefined
        ? before.description
        : cleanText(patch.description, "description", 1000);
    const category =
      patch.category === undefined ? before.category : cleanText(patch.category, "category");
    const defaultUnit =
      patch.defaultUnit === undefined
        ? before.defaultUnit
        : cleanText(patch.defaultUnit, "unit", 40);
    const defaultRate =
      patch.defaultRate === undefined
        ? before.defaultRate
        : assertRate(patch.defaultRate, "default rate");
    const statusRaw = patch.status === undefined ? before.status : (patch.status?.trim() ?? null);
    if (statusRaw !== "active" && statusRaw !== "inactive") {
      throw new ItemFamilyError(
        "family status is active or inactive",
        "invalid_family_status",
        "set the family status to active or inactive",
        422,
      );
    }
    if (code !== before.code) {
      const taken =
        (
          await tx.execute(
            sql`
        select 1 from item_families where org_id = ${orgId} and code = ${code} and id <> ${familyId}`,
            "objects",
          )
        ).length > 0;
      if (taken) {
        throw new ItemFamilyError(
          `family code ${code} is already in use`,
          "family_code_taken",
          "choose a different family code",
          409,
        );
      }
    }
    const updated = (
      await tx.execute<FamilyRow>(
        sql`
      update item_families
         set code = ${code}, name = ${name}, description = ${description}, category = ${category},
             kind = ${kind}, default_unit = ${defaultUnit}, default_rate = ${defaultRate},
             status = ${statusRaw}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${familyId}
      returning id, code, name, description, category, kind, default_unit, default_rate, status`,
        "objects",
      )
    )[0];
    if (!updated) throw new InventoryError("product family update matched no row");
    const after = toFamilyRecord(updated);
    await writeFamilyAudit(tx, orgId, actorId, "item_families", familyId, "update", {
      event: "family_updated",
      before,
      after,
    });
    return after;
  });
}

export interface ConvertItemInput {
  itemId: string;
  code?: string | null;
  name?: string | null;
  description?: string | null;
  category?: string | null;
  options: Array<{ name: string; value: string }>;
}

/**
 * Create a family from a standalone item. The item keeps its code and name
 * and becomes the first variant with the chosen option values; its kind,
 * unit, rate and category seed the family defaults.
 */
export async function convertItemToFamily(
  orgId: string,
  actorId: string | null,
  input: ConvertItemInput,
): Promise<ItemFamilyDetail> {
  if (input.options.length === 0) {
    throw new ItemFamilyError(
      "converting needs at least one option with the item's value",
      "option_required",
      "choose the option values this item carries, for example Size Small",
      422,
    );
  }
  return db.transaction(async (tx) => {
    await assertItemVariantsFeature(tx, orgId);
    const item = (
      await tx.execute<{
        id: string;
        kind: string;
        code: string | null;
        name: string;
        category: string | null;
        unit: string | null;
        default_rate: string | null;
        family_id: string | null;
      }>(
        sql`
      select id, kind, code, name, category, unit, default_rate, family_id
        from items
       where org_id = ${orgId} and id = ${input.itemId}
       for update`,
        "objects",
      )
    )[0];
    if (!item) {
      throw new ItemFamilyError(
        "the item is not in this organization",
        "variant_not_found",
        "choose an item from the catalog of this organization",
        422,
      );
    }
    if (item.family_id !== null) {
      throw new ItemFamilyError(
        `${item.code ?? item.name} already belongs to a product family`,
        "already_a_variant",
        "detach it from its family before converting it again",
        409,
      );
    }
    const kind = assertVariantKind(item.kind);
    const code =
      input.code === undefined || input.code === null
        ? (item.code ?? item.name.replace(/[^A-Za-z0-9]+/g, "-").toUpperCase())
        : requiredText(input.code, "a family code", 60);
    const name =
      input.name === undefined || input.name === null
        ? item.name
        : requiredText(input.name, "a family name");
    const taken =
      (
        await tx.execute(
          sql`
      select 1 from item_families where org_id = ${orgId} and code = ${code}`,
          "objects",
        )
      ).length > 0;
    if (taken) {
      throw new ItemFamilyError(
        `family code ${code} is already in use`,
        "family_code_taken",
        "choose a different family code",
        409,
      );
    }
    const family = (
      await tx.execute<FamilyRow>(
        sql`
      insert into item_families
        (org_id, code, name, description, category, kind, default_unit, default_rate, status, created_by, updated_by)
      values
        (${orgId}, ${code}, ${name}, ${cleanText(input.description, "description", 1000)}, ${cleanText(input.category, "category") ?? item.category},
         ${kind}, ${item.unit}, ${item.default_rate}, 'active', ${actorId}, ${actorId})
      returning id, code, name, description, category, kind, default_unit, default_rate, status`,
        "objects",
      )
    )[0];
    if (!family) throw new InventoryError("product family was not created");
    const normalized = normalizeFamilyOptions(
      input.options.map((option) => ({ name: option.name, values: [option.value] })),
    );
    let position = 0;
    for (const option of normalized) {
      position += 1;
      const inserted = (
        await tx.execute<{ id: string }>(
          sql`
        insert into item_family_options
          (org_id, family_id, position, name, "values", created_by, updated_by)
        values
          (${orgId}, ${family.id}, ${position}, ${option.name}, ${textArrayLiteral(option.values.map((entry) => entry.value))}::text[], ${actorId}, ${actorId})
        returning id`,
          "objects",
        )
      )[0];
      if (!inserted) throw new InventoryError(`family option ${option.name} was not created`);
    }
    const optionValues: OptionCombination = {};
    for (const option of normalized) optionValues[option.name] = option.values[0]!.value;
    const attached = await tx.execute<never>(sql`
      update items
         set family_id = ${family.id}, option_values = ${JSON.stringify(optionValues)}::jsonb,
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${item.id}`);
    if ((attached.rowCount ?? 0) !== 1)
      throw new InventoryError(`item ${item.code ?? item.name} convert matched no row`);
    const detail: ItemFamilyDetail = {
      ...toFamilyRecord(family),
      options: await loadOptions(tx, orgId, family.id),
      variants: [],
    };
    await writeFamilyAudit(tx, orgId, actorId, "item_families", family.id, "insert", {
      event: "family_converted_from_item",
      after: { ...detail, firstVariantId: item.id, optionValues },
    });
    await writeFamilyAudit(tx, orgId, actorId, "items", item.id, "update", {
      event: "item_converted_to_variant",
      before: { familyId: null, optionValues: null },
      after: { familyId: family.id, optionValues },
    });
    return detail;
  });
}

export interface CreateVariantChoice {
  optionValues: OptionCombination;
  /** False skips the combination; defaults to true. */
  include?: boolean | null;
  /** Blank falls back to the family code pattern. */
  code?: string | null;
  /** Variant base price; blank inherits the family default rate. */
  price?: string | null;
  barcode?: BulkBarcodeInput | null;
}

export interface CreateFamilyWithVariantsInput extends CreateFamilyInput {
  codePattern?: string | null;
  /** Defaults to the full cartesian product, all included. */
  variants?: CreateVariantChoice[] | null;
}

/**
 * Create a family with its ordered options and the chosen variants in ONE
 * transaction, so the item create flow never leaves a family without its
 * variants (or variants without their pricing inheritance). Validation,
 * code uniqueness, per-variant price/barcode overrides and auditing mirror
 * the separate create and generate paths; the only new shape is doing both
 * atomically.
 */
export async function createFamilyWithVariants(
  orgId: string,
  actorId: string | null,
  input: CreateFamilyWithVariantsInput,
): Promise<{ family: ItemFamilyDetail; variants: GeneratedVariant[] }> {
  const code = requiredText(input.code, "a family code", 60);
  const name = requiredText(input.name, "a family name");
  const kind = assertVariantKind(input.kind.trim());
  const description = cleanText(input.description, "description", 1000);
  const category = cleanText(input.category, "category");
  const defaultUnit = cleanText(input.defaultUnit, "unit", 40);
  const defaultRate = assertRate(input.defaultRate, "default rate");
  const options = normalizeFamilyOptions(input.options);
  const pattern =
    input.codePattern === undefined || input.codePattern === null
      ? DEFAULT_VARIANT_CODE_PATTERN
      : input.codePattern;
  if (pattern.trim() === "") {
    throw new ItemFamilyError(
      "a code pattern cannot be blank",
      "invalid_code_pattern",
      "use {family}-{values}",
      422,
    );
  }
  return db.transaction(async (tx) => {
    await assertItemVariantsFeature(tx, orgId);
    const taken =
      (
        await tx.execute(
          sql`
      select 1 from item_families where org_id = ${orgId} and code = ${code}`,
          "objects",
        )
      ).length > 0;
    if (taken) {
      throw new ItemFamilyError(
        `family code ${code} is already in use`,
        "family_code_taken",
        `choose a different family code; the code prefixes every generated variant code`,
        409,
      );
    }
    const family = (
      await tx.execute<FamilyRow>(
        sql`
      insert into item_families
        (org_id, code, name, description, category, kind, default_unit, default_rate, status, created_by, updated_by)
      values
        (${orgId}, ${code}, ${name}, ${description}, ${category}, ${kind}, ${defaultUnit}, ${defaultRate}, 'active', ${actorId}, ${actorId})
      returning id, code, name, description, category, kind, default_unit, default_rate, status`,
        "objects",
      )
    )[0];
    if (!family) throw new InventoryError("product family was not created");
    let position = 0;
    const records: FamilyOptionRecord[] = [];
    for (const option of options) {
      position += 1;
      const inserted = (
        await tx.execute<{ id: string }>(
          sql`
        insert into item_family_options
          (org_id, family_id, position, name, "values", created_by, updated_by)
        values
          (${orgId}, ${family.id}, ${position}, ${option.name}, ${textArrayLiteral(option.values.map((entry) => entry.value))}::text[], ${actorId}, ${actorId})
        returning id`,
          "objects",
        )
      )[0];
      if (!inserted) throw new InventoryError(`family option ${option.name} was not created`);
      records.push({
        id: inserted.id,
        name: option.name,
        position,
        values: option.values.map((entry) => entry.value),
      });
    }
    const optionNames = records.map((option) => option.name);
    const choices: CreateVariantChoice[] =
      input.variants === undefined || input.variants === null
        ? cartesianCombinations(records).map((optionValues) => ({ optionValues }))
        : input.variants.map((choice) => ({ ...choice }));
    const included = choices.filter((choice) => choice.include !== false);
    if (included.length === 0) {
      throw new ItemFamilyError(
        "no combinations were chosen",
        "invalid_combination",
        "choose at least one combination to create",
        422,
      );
    }
    if (included.length > MAX_GENERATED_PER_CALL) {
      throw new ItemFamilyError(
        `${included.length} combinations exceed the ${MAX_GENERATED_PER_CALL} created per call`,
        "too_many_combinations",
        `create in smaller subsets of at most ${MAX_GENERATED_PER_CALL} combinations`,
        422,
      );
    }
    const seen = new Set<string>();
    for (const choice of included) {
      const ordered = assertCombination(choice.optionValues, records);
      choice.optionValues = ordered;
      const key = combinationKey(ordered, optionNames);
      if (seen.has(key)) {
        throw new ItemFamilyError(
          "the same combination is chosen twice",
          "duplicate_combination",
          "choose each combination once",
          422,
        );
      }
      seen.add(key);
    }
    const seenCodes = new Set<string>();
    const results: GeneratedVariant[] = [];
    const variantRecords: VariantRecord[] = [];
    for (const choice of included) {
      const valuesInOrder = optionNames.map((optionName) => choice.optionValues[optionName]!);
      const override =
        choice.code === undefined || choice.code === null
          ? null
          : cleanText(choice.code, "variant code", 60);
      const variantCode = override ?? renderVariantCode(pattern, family.code, valuesInOrder);
      if (seenCodes.has(variantCode.toLowerCase())) {
        throw new ItemFamilyError(
          `variant code ${variantCode} is used twice`,
          "duplicate_variant_code",
          `give each variant its own code; ${variantCode} is already chosen above`,
          422,
        );
      }
      seenCodes.add(variantCode.toLowerCase());
      const collision = (
        await tx.execute<{ id: string; name: string }>(
          sql`
        select id, name from items where org_id = ${orgId} and code = ${variantCode}`,
          "objects",
        )
      )[0];
      if (collision) {
        throw new ItemFamilyError(
          `variant code ${variantCode} is already used by ${collision.name}`,
          "variant_code_taken",
          `change the code pattern or rename ${collision.name} before creating`,
          409,
        );
      }
      const price = assertRate(choice.price, "price") ?? defaultRate;
      let barcode: { value: string; kind: string } | null = null;
      if (choice.barcode !== undefined && choice.barcode !== null) {
        const value = requiredText(choice.barcode.value, "a barcode", 200);
        if (!(BARCODE_KINDS as readonly string[]).includes(choice.barcode.kind)) {
          throw new ItemFamilyError(
            `barcode kind ${choice.barcode.kind} is unknown`,
            "invalid_barcode_kind",
            `choose one of ${BARCODE_KINDS.join(", ")}`,
            422,
          );
        }
        const barcodeTaken = (
          await tx.execute<{ code: string | null; name: string }>(
            sql`
          select i.code, i.name
            from item_identifiers ii
            join items i on i.id = ii.item_id and i.org_id = ii.org_id
           where ii.org_id = ${orgId} and ii.value = ${value}`,
            "objects",
          )
        )[0];
        if (barcodeTaken) {
          throw new ItemFamilyError(
            `barcode ${value} is already used by ${barcodeTaken.code ?? barcodeTaken.name}`,
            "barcode_taken",
            `choose a different barcode; ${barcodeTaken.code ?? barcodeTaken.name} already scans to it`,
            409,
          );
        }
        barcode = { value, kind: choice.barcode.kind };
      }
      const variantName = variantDisplayName(family.name, valuesInOrder);
      const inserted = (
        await tx.execute<{ id: string }>(
          sql`
        insert into items
          (org_id, kind, code, name, category, unit, default_rate,
           family_id, option_values, is_active, created_by, updated_by)
        values
          (${orgId}, ${kind}, ${variantCode}, ${variantName}, ${category}, ${defaultUnit}, ${price},
           ${family.id}, ${JSON.stringify(choice.optionValues)}::jsonb, true, ${actorId}, ${actorId})
        returning id`,
          "objects",
        )
      )[0];
      if (!inserted) throw new InventoryError(`variant ${variantCode} was not created`);
      if (barcode) {
        const added = (
          await tx.execute<{ id: string }>(
            sql`
          insert into item_identifiers (org_id, item_id, kind, value, created_by, updated_by)
          values (${orgId}, ${inserted.id}, ${barcode.kind}, ${barcode.value}, ${actorId}, ${actorId})
          returning id`,
            "objects",
          )
        )[0];
        if (!added) throw new InventoryError(`variant ${variantCode} barcode was not created`);
      }
      await writeFamilyAudit(tx, orgId, actorId, "items", inserted.id, "insert", {
        event: "variant_generated",
        after: {
          familyId: family.id,
          code: variantCode,
          name: variantName,
          optionValues: choice.optionValues,
        },
      });
      results.push({
        id: inserted.id,
        code: variantCode,
        name: variantName,
        optionValues: choice.optionValues,
        created: true,
      });
      variantRecords.push({
        id: inserted.id,
        code: variantCode,
        name: variantName,
        optionValues: choice.optionValues,
        kind,
        unit: defaultUnit,
        defaultRate: price,
        defaultCost: null,
        isActive: true,
        onHand: "0",
        barcode,
      });
    }
    const detail: ItemFamilyDetail = {
      ...toFamilyRecord(family),
      options: records,
      variants: variantRecords,
    };
    await writeFamilyAudit(tx, orgId, actorId, "item_families", family.id, "insert", {
      event: "family_created",
      after: detail,
    });
    await writeFamilyAudit(tx, orgId, actorId, "item_families", family.id, "update", {
      event: "variants_generated",
      created: results.length,
      codes: results.map((variant) => variant.code),
    });
    return { family: detail, variants: results };
  });
}
