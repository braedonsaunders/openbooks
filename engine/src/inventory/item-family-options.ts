import { sql } from "drizzle-orm";
import { uuidArray } from "../organization/subsidiaries.ts";
import { db } from "../platform/db.ts";
import { InventoryError } from "./contracts.ts";
import {
  assertItemVariantsFeature,
  canRenameVariantName,
  ItemFamilyError,
  normalizeFamilyOptions,
  sameValueSet,
  textArrayLiteral,
  toFamilyRecord,
  variantCodes,
  variantDisplayName,
  type FamilyOptionInput,
  type FamilyOptionRecord,
  type ItemFamilyDetail,
} from "./item-family-model.ts";
import { loadOptions, loadVariants, lockFamily, writeFamilyAudit } from "./item-family-store.ts";

/**
 * Family option maintenance: replace the ordered option set. Adding an
 * option backfills existing variants; renaming remaps variant names (never
 * codes); removing anything variants use is refused naming the variants.
 */

/**
 * Replace the family's ordered options. Adding an option backfills existing
 * variants with its default value; renaming a value renames variant names
 * (never codes); removing an option or value that variants use is refused
 * naming the variants — they can be deactivated instead.
 */
export async function replaceFamilyOptions(
  orgId: string,
  actorId: string | null,
  familyId: string,
  options: FamilyOptionInput[],
): Promise<ItemFamilyDetail> {
  const normalized = normalizeFamilyOptions(options);
  return db.transaction(async (tx) => {
    await assertItemVariantsFeature(tx, orgId);
    const family = await lockFamily(tx, orgId, familyId);
    const current = await loadOptions(tx, orgId, familyId);
    const variants = await loadVariants(tx, orgId, familyId);
    const currentById = new Map(current.map((option) => [option.id, option]));

    for (const option of normalized) {
      if (option.id !== null && !currentById.has(option.id)) {
        throw new ItemFamilyError(
          `option ${option.name} is not part of this family`,
          "option_not_found",
          `reload the family and choose one of its current options`,
          422,
        );
      }
    }

    const matchedCurrentIds = new Set(
      normalized.flatMap((option) => (option.id ? [option.id] : [])),
    );
    for (const option of current) {
      if (matchedCurrentIds.has(option.id)) continue;
      const renamedTo = normalized.find(
        (candidate) =>
          candidate.id === null &&
          candidate.name !== option.name &&
          sameValueSet(
            candidate.values.map((entry) => entry.value),
            option.values,
          ),
      );
      if (renamedTo) {
        throw new ItemFamilyError(
          `option ${option.name} cannot be renamed by removing and re-adding it`,
          "option_rename_ambiguous",
          `keep the option row and change its name to ${renamedTo.name} instead`,
          422,
        );
      }
      const usedBy = variants.filter((variant) => option.name in (variant.option_values ?? {}));
      if (usedBy.length > 0) {
        throw new ItemFamilyError(
          `option ${option.name} is used by ${usedBy.length} variant${usedBy.length === 1 ? "" : "s"} (${variantCodes(usedBy)}); deactivate the variants instead of removing the option`,
          "option_in_use",
          "deactivate the variants that use the option, or keep the option",
          409,
        );
      }
    }

    // Value removals and renames, per matched option.
    const renames: Array<{ optionName: string; from: string; to: string }> = [];
    for (const option of normalized) {
      if (option.id === null) continue;
      const before = currentById.get(option.id)!;
      const beforeValues = new Set(before.values);
      const afterValues = new Set(option.values.map((entry) => entry.value));
      for (const entry of option.values) {
        if (entry.previousValue !== null) {
          if (!beforeValues.has(entry.previousValue)) {
            throw new ItemFamilyError(
              `${entry.previousValue} is not a value of option ${before.name}`,
              "option_value_not_found",
              `rename one of ${before.values.join(", ")} under option ${before.name}`,
              422,
            );
          }
          if (afterValues.has(entry.previousValue) && entry.previousValue !== entry.value) {
            throw new ItemFamilyError(
              `${entry.previousValue} is both kept and renamed under option ${before.name}`,
              "option_value_ambiguous",
              `rename ${entry.previousValue} to ${entry.value} or keep ${entry.previousValue}, not both`,
              422,
            );
          }
          renames.push({ optionName: before.name, from: entry.previousValue, to: entry.value });
        }
      }
      const removed = before.values.filter(
        (value) =>
          !afterValues.has(value) &&
          !renames.some((rename) => rename.optionName === before.name && rename.from === value),
      );
      for (const value of removed) {
        const usedBy = variants.filter(
          (variant) => (variant.option_values ?? {})[before.name] === value,
        );
        if (usedBy.length > 0) {
          throw new ItemFamilyError(
            `value ${value} of option ${before.name} is used by ${usedBy.length} variant${usedBy.length === 1 ? "" : "s"} (${variantCodes(usedBy)}); deactivate the variants instead of removing the value`,
            "option_value_in_use",
            `deactivate the variants that use ${value}, or keep the value`,
            409,
          );
        }
      }
    }

    // New options backfill existing variants; new values become generatable.
    const addedOptions = normalized.filter((option) => option.id === null);
    for (const option of addedOptions) {
      if (variants.length > 0 && option.defaultValue === null) {
        throw new ItemFamilyError(
          `new option ${option.name} needs a default value for the ${variants.length} existing variant${variants.length === 1 ? "" : "s"}`,
          "option_default_required",
          `choose which of ${option.values.map((entry) => entry.value).join(", ")} the existing variants keep`,
          422,
        );
      }
    }

    // Apply: delete removed options, update kept ones, insert added ones.
    const removedIds = current
      .filter((option) => !matchedCurrentIds.has(option.id))
      .map((option) => option.id);
    if (removedIds.length > 0) {
      const deleted = await tx.execute<never>(sql`
        delete from item_family_options
         where org_id = ${orgId} and family_id = ${familyId} and id = any(${uuidArray(removedIds)}::uuid[])`);
      if ((deleted.rowCount ?? 0) !== removedIds.length) {
        throw new InventoryError("family option removal matched no row");
      }
    }
    let position = 0;
    const finalOptions: FamilyOptionRecord[] = [];
    for (const option of normalized) {
      position += 1;
      const valueList = option.values.map((entry) => entry.value);
      if (option.id !== null) {
        const updated = await tx.execute<never>(sql`
          update item_family_options
             set position = ${position}, name = ${option.name}, "values" = ${textArrayLiteral(valueList)}::text[],
                 updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and family_id = ${familyId} and id = ${option.id}`);
        if ((updated.rowCount ?? 0) !== 1)
          throw new InventoryError(`family option ${option.name} update matched no row`);
        finalOptions.push({ id: option.id, name: option.name, position, values: valueList });
      } else {
        const inserted = (
          await tx.execute<{ id: string }>(
            sql`
          insert into item_family_options
            (org_id, family_id, position, name, "values", created_by, updated_by)
          values
            (${orgId}, ${familyId}, ${position}, ${option.name}, ${textArrayLiteral(valueList)}::text[], ${actorId}, ${actorId})
          returning id`,
            "objects",
          )
        )[0];
        if (!inserted) throw new InventoryError(`family option ${option.name} was not created`);
        finalOptions.push({ id: inserted.id, name: option.name, position, values: valueList });
      }
    }

    // Renames remap option keys and rename variant names — never codes.
    const renamedVariants: Array<{ id: string; name: string }> = [];
    const skippedRenames: Array<{ id: string; name: string }> = [];
    const optionRenames = new Map<string, string>();
    for (const option of normalized) {
      if (option.id === null) continue;
      const before = currentById.get(option.id)!;
      if (before.name !== option.name) optionRenames.set(before.name, option.name);
    }
    if (renames.length > 0 || optionRenames.size > 0 || addedOptions.length > 0) {
      const optionNames = finalOptions.map((option) => option.name);
      for (const variant of variants) {
        const currentValues: Record<string, string> = { ...(variant.option_values ?? {}) };
        for (const [before, after] of optionRenames) {
          if (before in currentValues) {
            currentValues[after] = currentValues[before]!;
            delete currentValues[before];
          }
        }
        for (const rename of renames) {
          const key = optionRenames.get(rename.optionName) ?? rename.optionName;
          if (currentValues[key] === rename.from) currentValues[key] = rename.to;
        }
        for (const option of addedOptions) {
          if (!(option.name in currentValues)) currentValues[option.name] = option.defaultValue!;
        }
        const ordered = optionNames.map((name) => currentValues[name] ?? "");
        const nextName = variantDisplayName(family.name, ordered);
        const nextValues = JSON.stringify(currentValues);
        const nameChanged = nextName !== variant.name;
        const valuesChanged = nextValues !== JSON.stringify(variant.option_values ?? {});
        if (!nameChanged && !valuesChanged) continue;
        if (!nameChanged || canRenameVariantName(variant.name, family.name, currentValues)) {
          const updated = await tx.execute<never>(sql`
            update items
               set name = ${nextName}, option_values = ${nextValues}::jsonb,
                   updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${variant.id}`);
          if ((updated.rowCount ?? 0) !== 1)
            throw new InventoryError(
              `variant ${variant.code ?? variant.name} rename matched no row`,
            );
          renamedVariants.push({ id: variant.id, name: nextName });
          if (valuesChanged && !nameChanged) {
            await writeFamilyAudit(tx, orgId, actorId, "items", variant.id, "update", {
              event: "variant_option_remapped",
              before: { optionValues: variant.option_values },
              after: { optionValues: currentValues },
            });
          }
        } else {
          skippedRenames.push({ id: variant.id, name: variant.name });
        }
      }
    }

    await writeFamilyAudit(tx, orgId, actorId, "item_families", familyId, "update", {
      event: "family_options_replaced",
      before: { options: current },
      after: { options: finalOptions },
      renamedVariants,
      skippedRenames,
    });
    return {
      ...toFamilyRecord(family),
      options: finalOptions,
      variants: [],
    };
  });
}
