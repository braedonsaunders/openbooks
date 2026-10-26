import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { InventoryError } from "./contracts.ts";
import {
  assertCombination,
  assertItemVariantsFeature,
  assertItemVariantsReadable,
  cartesianCombinations,
  combinationKey,
  DEFAULT_VARIANT_CODE_PATTERN,
  ItemFamilyError,
  MAX_GENERATED_PER_CALL,
  renderVariantCode,
  toFamilyRecord,
  variantDisplayName,
  type FamilyRow,
  type OptionCombination,
} from "./item-family-model.ts";
import { loadOptions, loadVariants, lockFamily, writeFamilyAudit } from "./item-family-store.ts";

/**
 * Variant generation: preview the missing combinations before commit, then
 * create them idempotently — re-running it creates only what is missing. A
 * generated code that belongs to another item is refused naming that item.
 */

export interface GenerateVariantsInput {
  /** Explicit subset of combinations; defaults to the full cartesian product. */
  only?: OptionCombination[] | null;
  codePattern?: string | null;
}

export interface MissingCombination {
  optionValues: OptionCombination;
  code: string;
  name: string;
  exists: boolean;
}

/**
 * Consequence before commit: the missing combinations with the exact codes
 * and names generation would create, so the drawer previews them before the
 * operator confirms. Read-only; generation still locks and rechecks.
 */
export async function previewGenerateVariants(
  orgId: string,
  familyId: string,
  pattern: string | null = null,
): Promise<{
  familyId: string;
  familyCode: string;
  familyName: string;
  missing: MissingCombination[];
  existing: number;
}> {
  return db.transaction(async (tx) => {
    await assertItemVariantsReadable(tx, orgId);
    const row = (
      await tx.execute<FamilyRow>(
        sql`
      select id, code, name, description, category, kind, default_unit, default_rate, status
        from item_families
       where org_id = ${orgId} and id = ${familyId}`,
        "objects",
      )
    )[0];
    if (!row) {
      throw new ItemFamilyError(
        "the product family is not in this organization",
        "family_not_found",
        "choose a family from the item catalog of this organization",
        422,
      );
    }
    const options = await loadOptions(tx, orgId, familyId);
    if (options.length === 0)
      return { familyId, familyCode: row.code, familyName: row.name, missing: [], existing: 0 };
    const codePattern = pattern ?? DEFAULT_VARIANT_CODE_PATTERN;
    const optionNames = options.map((option) => option.name);
    const existing = await loadVariants(tx, orgId, familyId);
    const existingKeys = new Set(
      existing.map((variant) =>
        combinationKey((variant.option_values ?? {}) as OptionCombination, optionNames),
      ),
    );
    const missing = cartesianCombinations(options)
      .filter((combination) => !existingKeys.has(combinationKey(combination, optionNames)))
      .map((combination) => {
        const valuesInOrder = optionNames.map((name) => combination[name]!);
        return {
          optionValues: combination,
          code: renderVariantCode(codePattern, row.code, valuesInOrder),
          name: variantDisplayName(row.name, valuesInOrder),
          exists: false,
        };
      });
    return {
      familyId,
      familyCode: row.code,
      familyName: row.name,
      missing,
      existing: existing.length,
    };
  });
}

export interface GeneratedVariant {
  id: string;
  code: string;
  name: string;
  optionValues: OptionCombination;
  created: boolean;
}

/**
 * Create variant items for the cartesian product (or a chosen subset).
 * Idempotent: combinations that already exist are reported, never recreated.
 * A generated code that belongs to another item is refused naming that item.
 */
export async function generateFamilyVariants(
  orgId: string,
  actorId: string | null,
  familyId: string,
  input: GenerateVariantsInput = {},
): Promise<{ familyId: string; variants: GeneratedVariant[] }> {
  return db.transaction(async (tx) => {
    await assertItemVariantsFeature(tx, orgId);
    const family = await lockFamily(tx, orgId, familyId);
    const record = toFamilyRecord(family);
    const options = await loadOptions(tx, orgId, familyId);
    if (options.length === 0) {
      throw new ItemFamilyError(
        `family ${family.code} has no options yet`,
        "options_required",
        `add at least one option to family ${family.code} before generating variants`,
        422,
      );
    }
    const pattern = input.codePattern ?? DEFAULT_VARIANT_CODE_PATTERN;
    const requested =
      input.only === undefined || input.only === null
        ? cartesianCombinations(options)
        : input.only.map((combination) => assertCombination(combination, options));
    if (requested.length === 0) {
      throw new ItemFamilyError(
        "no combinations were chosen",
        "invalid_combination",
        "choose at least one combination to generate",
        422,
      );
    }
    if (requested.length > MAX_GENERATED_PER_CALL) {
      throw new ItemFamilyError(
        `${requested.length} combinations exceed the ${MAX_GENERATED_PER_CALL} generated per call`,
        "too_many_combinations",
        `generate in smaller subsets of at most ${MAX_GENERATED_PER_CALL} combinations`,
        422,
      );
    }
    const optionNames = options.map((option) => option.name);
    const seen = new Set<string>();
    for (const combination of requested) {
      const key = combinationKey(combination, optionNames);
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
    const existing = await loadVariants(tx, orgId, familyId);
    const results: GeneratedVariant[] = [];
    let created = 0;
    for (const combination of requested) {
      const key = combinationKey(combination, optionNames);
      const already = existing.find(
        (variant) =>
          combinationKey((variant.option_values ?? {}) as OptionCombination, optionNames) === key,
      );
      const valuesInOrder = optionNames.map((name) => combination[name]!);
      const code = renderVariantCode(pattern, family.code, valuesInOrder);
      const name = variantDisplayName(family.name, valuesInOrder);
      if (already) {
        results.push({
          id: already.id,
          code: already.code ?? code,
          name: already.name,
          optionValues: combination,
          created: false,
        });
        continue;
      }
      const collision = (
        await tx.execute<{ id: string; name: string }>(
          sql`
        select id, name from items where org_id = ${orgId} and code = ${code}`,
          "objects",
        )
      )[0];
      if (collision) {
        throw new ItemFamilyError(
          `variant code ${code} is already used by ${collision.name}`,
          "variant_code_taken",
          `change the code pattern or rename ${collision.name} before generating`,
          409,
        );
      }
      const inserted = (
        await tx.execute<{ id: string }>(
          sql`
        insert into items
          (org_id, kind, code, name, category, unit, default_rate,
           family_id, option_values, is_active, created_by, updated_by)
        values
          (${orgId}, ${record.kind}, ${code}, ${name}, ${record.category}, ${record.defaultUnit}, ${record.defaultRate},
           ${familyId}, ${JSON.stringify(combination)}::jsonb, true, ${actorId}, ${actorId})
        returning id`,
          "objects",
        )
      )[0];
      if (!inserted) throw new InventoryError(`variant ${code} was not created`);
      await writeFamilyAudit(tx, orgId, actorId, "items", inserted.id, "insert", {
        event: "variant_generated",
        after: { familyId, code, name, optionValues: combination },
      });
      created += 1;
      results.push({ id: inserted.id, code, name, optionValues: combination, created: true });
    }
    await writeFamilyAudit(tx, orgId, actorId, "item_families", familyId, "update", {
      event: "variants_generated",
      created,
      codes: results.filter((variant) => variant.created).map((variant) => variant.code),
    });
    return { familyId, variants: results };
  });
}
