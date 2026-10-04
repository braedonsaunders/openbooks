import { sql, type SQL } from "drizzle-orm";
import { normalizeMoney } from "../money/money.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { db, type SqlExecutor } from "../platform/db.ts";
import { InventoryError, type Runner } from "./contracts.ts";

/**
 * Product families with ordered options (Size × Color). Each variant is an
 * ordinary `items` row carrying `family_id` and `option_values`, so stock,
 * costing, pricing, tax, documents, barcodes and reports work unchanged.
 *
 * Every write holds the authoritative feature inside its transaction and
 * refuses by name when the gate is off; removing an option or value that
 * variants use is refused naming the variants (they can be deactivated
 * instead); renaming a value renames variant names, never codes; generation
 * is idempotent — re-running it creates only missing combinations.
 */
export class ItemFamilyError extends InventoryError {
  constructor(
    message: string,
    readonly code: string,
    readonly remedy: string,
    readonly status: 409 | 422 = 409,
  ) {
    super(message);
    this.name = "ItemFamilyError";
  }
}

const FEATURES_REMEDY = "turn on Item variants in Company Settings → Features";

/** Every family write holds the authoritative feature through its transaction. */
export async function assertItemVariantsFeature(tx: Runner, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(tx as SqlExecutor, orgId, "itemVariants"))) {
    throw new ItemFamilyError(
      `item variants are turned off for this organization; ${FEATURES_REMEDY}`,
      "item_variants_disabled",
      FEATURES_REMEDY,
      422,
    );
  }
}

/** Family reads refuse too: without the gate the surface is hidden, not degraded. */
export async function assertItemVariantsReadable(runner: Runner, orgId: string): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, "itemVariants", runner as SqlExecutor))) {
    throw new ItemFamilyError(
      `item variants are turned off for this organization; ${FEATURES_REMEDY}`,
      "item_variants_disabled",
      FEATURES_REMEDY,
      422,
    );
  }
}

/** Variant kinds: stocked or sellable item kinds only. */
export const VARIANT_KINDS = ["inventory", "non_inventory", "service", "kit", "assembly"] as const;
export type VariantKind = (typeof VARIANT_KINDS)[number];

export const FAMILY_STATUSES = ["active", "inactive"] as const;

function cleanText(value: string | null | undefined, field: string, max = 200): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    throw new ItemFamilyError(
      `${field} must be at most ${max} characters`,
      "invalid_input",
      `shorten the ${field}`,
      422,
    );
  }
  return trimmed;
}

function requiredText(value: string | null | undefined, field: string, max = 200): string {
  const cleaned = cleanText(value, field, max);
  if (!cleaned) {
    throw new ItemFamilyError(`a family needs ${field}`, "field_required", `enter ${field}`, 422);
  }
  return cleaned;
}

function assertVariantKind(kind: string): VariantKind {
  if ((VARIANT_KINDS as readonly string[]).includes(kind)) return kind as VariantKind;
  throw new ItemFamilyError(
    `family kind ${kind} cannot carry variants; variant kinds are ${VARIANT_KINDS.join(", ")}`,
    "invalid_family_kind",
    `choose one of ${VARIANT_KINDS.join(", ")}`,
    422,
  );
}

function assertRate(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    return normalizeMoney(trimmed);
  } catch {
    throw new ItemFamilyError(
      `${field} ${trimmed} is not a usable amount`,
      "invalid_amount",
      `enter ${field} as a plain number with at most four decimal places, for example 12.50`,
      422,
    );
  }
}

export interface FamilyOptionValueInput {
  value: string;
  /** When renaming: the previous value this replaces. */
  previousValue?: string | null;
}

export interface FamilyOptionInput {
  /** Present when the option already exists; matched by id, never by name. */
  id?: string | null;
  name: string;
  values: Array<string | FamilyOptionValueInput>;
  /**
   * Required when adding an option to a family that already has variants:
   * existing variants are backfilled with this value so every variant keeps
   * exactly the current option keys.
   */
  defaultValue?: string | null;
}

export interface NormalizedOptionValue {
  value: string;
  previousValue: string | null;
}

export interface NormalizedOption {
  id: string | null;
  name: string;
  values: NormalizedOptionValue[];
  defaultValue: string | null;
}

const MAX_OPTIONS = 6;
const MAX_VALUES_PER_OPTION = 200;
const MAX_GENERATED_PER_CALL = 500;

function normalizeOptionValue(
  entry: string | FamilyOptionValueInput,
  optionName: string,
): NormalizedOptionValue {
  const raw = typeof entry === "string" ? { value: entry } : entry;
  const value = requiredText(raw.value, `a value for option ${optionName}`, 120);
  const previousRaw = typeof entry === "string" ? null : (entry.previousValue ?? null);
  const previousValue = previousRaw === null ? null : requiredText(previousRaw, `the previous value for option ${optionName}`, 120);
  if (previousValue !== null && previousValue === value) {
    throw new ItemFamilyError(
      `option ${optionName} renames ${value} to itself`,
      "invalid_input",
      `give the renamed value for option ${optionName} a different spelling, or leave the value unchanged`,
      422,
    );
  }
  return { value, previousValue };
}

/** Validate one option set outside any transaction: names, values, bounds. */
export function normalizeFamilyOptions(options: FamilyOptionInput[]): NormalizedOption[] {
  if (options.length === 0) {
    throw new ItemFamilyError(
      "a family needs at least one option",
      "option_required",
      "add an option such as Size with its values",
      422,
    );
  }
  if (options.length > MAX_OPTIONS) {
    throw new ItemFamilyError(
      `a family holds at most ${MAX_OPTIONS} options`,
      "too_many_options",
      `keep at most ${MAX_OPTIONS} options on one family, or split the range into two families`,
      422,
    );
  }
  const seenNames = new Set<string>();
  return options.map((option) => {
    const name = requiredText(option.name, "an option name", 120);
    const lowered = name.toLowerCase();
    if (seenNames.has(lowered)) {
      throw new ItemFamilyError(
        `option ${name} is listed twice`,
        "duplicate_option",
        `merge the two ${name} options into one`,
        422,
      );
    }
    seenNames.add(lowered);
    if (option.values.length === 0) {
      throw new ItemFamilyError(
        `option ${name} needs at least one value`,
        "option_value_required",
        `add a value for option ${name}, for example Small`,
        422,
      );
    }
    if (option.values.length > MAX_VALUES_PER_OPTION) {
      throw new ItemFamilyError(
        `option ${name} holds at most ${MAX_VALUES_PER_OPTION} values`,
        "too_many_option_values",
        `keep at most ${MAX_VALUES_PER_OPTION} values on option ${name}, or split the range into two families`,
        422,
      );
    }
    const seenValues = new Set<string>();
    const values = option.values.map((entry) => {
      const normalized = normalizeOptionValue(entry, name);
      const loweredValue = normalized.value.toLowerCase();
      if (seenValues.has(loweredValue)) {
        throw new ItemFamilyError(
          `${normalized.value} is listed twice under option ${name}`,
          "duplicate_option_value",
          `keep one ${normalized.value} under option ${name}`,
          422,
        );
      }
      seenValues.add(loweredValue);
      return normalized;
    });
    const defaultRaw = option.defaultValue ?? null;
    const defaultValue = defaultRaw === null ? null : requiredText(defaultRaw, `the default value for option ${name}`, 120);
    if (defaultValue !== null && !values.some((candidate) => candidate.value === defaultValue)) {
      throw new ItemFamilyError(
        `default value ${defaultValue} is not one of option ${name}'s values`,
        "invalid_default_value",
        `choose the default for option ${name} from its values`,
        422,
      );
    }
    return { id: option.id ?? null, name, values, defaultValue };
  });
}

export interface ItemFamilyRecord {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  kind: VariantKind;
  defaultUnit: string | null;
  defaultRate: string | null;
  status: "active" | "inactive";
}

export interface FamilyOptionRecord {
  id: string;
  name: string;
  position: number;
  values: string[];
}

export interface VariantRecord {
  id: string;
  code: string | null;
  name: string;
  optionValues: Record<string, string>;
  kind: string;
  unit: string | null;
  defaultRate: string | null;
  defaultCost: string | null;
  isActive: boolean;
  onHand: string | null;
}

export interface ItemFamilyDetail extends ItemFamilyRecord {
  options: FamilyOptionRecord[];
  variants: VariantRecord[];
}

type FamilyRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  kind: string;
  default_unit: string | null;
  default_rate: string | null;
  status: string;
};

function toFamilyRecord(row: FamilyRow): ItemFamilyRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    category: row.category,
    kind: assertVariantKind(row.kind),
    defaultUnit: row.default_unit,
    defaultRate: row.default_rate,
    status: row.status === "inactive" ? "inactive" : "active",
  };
}

async function writeFamilyAudit(
  tx: Runner,
  orgId: string,
  actorId: string | null,
  table: "item_families" | "items",
  rowId: string,
  action: "insert" | "update",
  changes: Record<string, unknown>,
): Promise<void> {
  const written = (await tx.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${table}, ${rowId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id`));
  if (written.rows.length === 0) {
    throw new InventoryError("family change was not audited; reload and try again");
  }
}

/** Lock the family row for writers; a missing row is outside this organization. */
async function lockFamily(tx: Runner, orgId: string, familyId: string): Promise<FamilyRow> {
  const row = (await tx.execute<FamilyRow>(sql`
    select id, code, name, description, category, kind, default_unit, default_rate, status
      from item_families
     where org_id = ${orgId} and id = ${familyId}
     for update`)).rows[0];
  if (!row) {
    throw new ItemFamilyError(
      "the product family is not in this organization",
      "family_not_found",
      "choose a family from the item catalog of this organization",
      422,
    );
  }
  return row;
}

async function loadOptions(tx: Runner, orgId: string, familyId: string): Promise<FamilyOptionRecord[]> {
  const rows = (await tx.execute<{ id: string; name: string; position: number; values: string[] }>(sql`
    select id, name, position, "values"
      from item_family_options
     where org_id = ${orgId} and family_id = ${familyId}
     order by position`)).rows;
  return rows.map((row) => ({ id: row.id, name: row.name, position: row.position, values: row.values ?? [] }));
}

type VariantRow = {
  id: string;
  code: string | null;
  name: string;
  option_values: Record<string, string>;
  kind: string;
  unit: string | null;
  default_rate: string | null;
  default_cost: string | null;
  is_active: boolean;
};

async function loadVariants(tx: Runner, orgId: string, familyId: string): Promise<VariantRow[]> {
  return (await tx.execute<VariantRow>(sql`
    select id, code, name, option_values, kind, unit, default_rate, default_cost, is_active
      from items
     where org_id = ${orgId} and family_id = ${familyId}
     order by code nulls last, name`)).rows;
}

/** Deterministic code segment: readable, stable, and safe inside item codes. */
export function slugifyCodeSegment(value: string): string {
  const slug = value
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^A-Z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) {
    throw new ItemFamilyError(
      `option value ${value} cannot form an item code`,
      "invalid_option_value",
      `give the value letters or digits to code from, for example ${value}01`,
      422,
    );
  }
  return slug;
}

export function variantDisplayName(familyName: string, valuesInOrder: string[]): string {
  return `${familyName} — ${valuesInOrder.join(" / ")}`;
}

/**
 * Render a variant code from a pattern. Tokens: {family}, {values} (the
 * slugified values joined with "-"), {value1}…{valueN} in option order.
 * An unknown token is refused naming the token and the tokens that exist.
 */
export function renderVariantCode(
  pattern: string,
  familyCode: string,
  valuesInOrder: string[],
): string {
  const trimmed = pattern.trim();
  if (!trimmed) {
    throw new ItemFamilyError("a code pattern cannot be blank", "invalid_code_pattern", "use {family}-{values}", 422);
  }
  if (trimmed.length > 120) {
    throw new ItemFamilyError(
      "a code pattern holds at most 120 characters",
      "invalid_code_pattern",
      "shorten the code pattern to 120 characters",
      422,
    );
  }
  const slugs = valuesInOrder.map(slugifyCodeSegment);
  const tokens: Record<string, string> = {
    family: familyCode,
    values: slugs.join("-"),
  };
  valuesInOrder.forEach((_, position) => {
    tokens[`value${position + 1}`] = slugs[position]!;
  });
  const unknown = trimmed.match(/\{([^{}]+)\}/);
  if (unknown && !(unknown[1]! in tokens)) {
    throw new ItemFamilyError(
      `code pattern token {${unknown[1]}} is unknown`,
      "invalid_code_pattern",
      `use one of ${Object.keys(tokens).map((token) => `{${token}}`).join(", ")}`,
      422,
    );
  }
  return trimmed.replace(/\{([^{}]+)\}/g, (match, token: string) => tokens[token] ?? match);
}

export const DEFAULT_VARIANT_CODE_PATTERN = "{family}-{values}";

export type OptionCombination = Record<string, string>;

/** Cartesian product of the ordered options, in option order. */
export function cartesianCombinations(options: FamilyOptionRecord[]): OptionCombination[] {
  let combinations: OptionCombination[] = [{}];
  for (const option of options) {
    const next: OptionCombination[] = [];
    for (const base of combinations) {
      for (const value of option.values) {
        next.push({ ...base, [option.name]: value });
      }
    }
    combinations = next;
  }
  return combinations;
}

function combinationKey(combination: OptionCombination, optionNames: string[]): string {
  return optionNames.map((name) => `${name}=${combination[name] ?? ""}`).join("|");
}

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
    const taken = (await tx.execute(sql`
      select 1 from item_families where org_id = ${orgId} and code = ${code}`)).rows.length > 0;
    if (taken) {
      throw new ItemFamilyError(
        `family code ${code} is already in use`,
        "family_code_taken",
        `choose a different family code; the code prefixes every generated variant code`,
        409,
      );
    }
    const family = (await tx.execute<FamilyRow>(sql`
      insert into item_families
        (org_id, code, name, description, category, kind, default_unit, default_rate, status, created_by, updated_by)
      values
        (${orgId}, ${code}, ${name}, ${description}, ${category}, ${kind}, ${defaultUnit}, ${defaultRate}, 'active', ${actorId}, ${actorId})
      returning id, code, name, description, category, kind, default_unit, default_rate, status`)).rows[0];
    if (!family) throw new InventoryError("product family was not created");
    let position = 0;
    for (const option of options) {
      position += 1;
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into item_family_options
          (org_id, family_id, position, name, "values", created_by, updated_by)
        values
          (${orgId}, ${family.id}, ${position}, ${option.name}, ${option.values.map((entry) => entry.value)}::text[], ${actorId}, ${actorId})
        returning id`)).rows[0];
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
    const code = patch.code === undefined ? before.code : requiredText(patch.code, "a family code", 60);
    const name = patch.name === undefined ? before.name : requiredText(patch.name, "a family name");
    const kind = patch.kind === undefined ? before.kind : assertVariantKind((patch.kind ?? "").trim());
    const description = patch.description === undefined ? before.description : cleanText(patch.description, "description", 1000);
    const category = patch.category === undefined ? before.category : cleanText(patch.category, "category");
    const defaultUnit = patch.defaultUnit === undefined ? before.defaultUnit : cleanText(patch.defaultUnit, "unit", 40);
    const defaultRate = patch.defaultRate === undefined ? before.defaultRate : assertRate(patch.defaultRate, "default rate");
    const statusRaw = patch.status === undefined ? before.status : patch.status?.trim() ?? null;
    if (statusRaw !== "active" && statusRaw !== "inactive") {
      throw new ItemFamilyError(
        "family status is active or inactive",
        "invalid_family_status",
        "set the family status to active or inactive",
        422,
      );
    }
    if (code !== before.code) {
      const taken = (await tx.execute(sql`
        select 1 from item_families where org_id = ${orgId} and code = ${code} and id <> ${familyId}`)).rows.length > 0;
      if (taken) {
        throw new ItemFamilyError(
          `family code ${code} is already in use`,
          "family_code_taken",
          "choose a different family code",
          409,
        );
      }
    }
    const updated = (await tx.execute<FamilyRow>(sql`
      update item_families
         set code = ${code}, name = ${name}, description = ${description}, category = ${category},
             kind = ${kind}, default_unit = ${defaultUnit}, default_rate = ${defaultRate},
             status = ${statusRaw}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${familyId}
      returning id, code, name, description, category, kind, default_unit, default_rate, status`)).rows[0];
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

function variantCodes(variants: VariantRow[], limit = 5): string {
  const codes = variants.slice(0, limit).map((variant) => variant.code ?? variant.name);
  const rest = variants.length > limit ? ` and ${variants.length - limit} more` : "";
  return `${codes.join(", ")}${rest}`;
}

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

    const matchedCurrentIds = new Set(normalized.flatMap((option) => (option.id ? [option.id] : [])));
    for (const option of current) {
      if (matchedCurrentIds.has(option.id)) continue;
      const renamedTo = normalized.find((candidate) => candidate.id === null && candidate.name !== option.name && sameValueSet(candidate.values.map((entry) => entry.value), option.values));
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
        (value) => !afterValues.has(value) && !renames.some((rename) => rename.optionName === before.name && rename.from === value),
      );
      for (const value of removed) {
        const usedBy = variants.filter((variant) => (variant.option_values ?? {})[before.name] === value);
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
    const removedIds = current.filter((option) => !matchedCurrentIds.has(option.id)).map((option) => option.id);
    if (removedIds.length > 0) {
      const deleted = await tx.execute(sql`
        delete from item_family_options
         where org_id = ${orgId} and family_id = ${familyId} and id = any(${removedIds}::uuid[])`);
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
        const updated = await tx.execute(sql`
          update item_family_options
             set position = ${position}, name = ${option.name}, "values" = ${valueList}::text[],
                 updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and family_id = ${familyId} and id = ${option.id}`);
        if ((updated.rowCount ?? 0) !== 1) throw new InventoryError(`family option ${option.name} update matched no row`);
        finalOptions.push({ id: option.id, name: option.name, position, values: valueList });
      } else {
        const inserted = (await tx.execute<{ id: string }>(sql`
          insert into item_family_options
            (org_id, family_id, position, name, "values", created_by, updated_by)
          values
            (${orgId}, ${familyId}, ${position}, ${option.name}, ${valueList}::text[], ${actorId}, ${actorId})
          returning id`)).rows[0];
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
          const updated = await tx.execute(sql`
            update items
               set name = ${nextName}, option_values = ${nextValues}::jsonb,
                   updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${variant.id}`);
          if ((updated.rowCount ?? 0) !== 1) throw new InventoryError(`variant ${variant.code ?? variant.name} rename matched no row`);
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

function sameValueSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const remaining = new Set(right);
  return left.every((value) => remaining.delete(value));
}

/**
 * A variant name is safe to rewrite when it still carries the generated
 * shape — the family name plus the ordered values — even when the operator
 * customized the family prefix. Fully rewritten names are left alone and
 * reported, never clobbered.
 */
function canRenameVariantName(name: string, familyName: string, valuesByOption: Record<string, string>): boolean {
  const values = Object.values(valuesByOption);
  if (name === variantDisplayName(familyName, values)) return true;
  const separator = name.indexOf(" — ");
  if (separator < 0) return false;
  const segments = name.slice(separator + 3).split(" / ").map((segment) => segment.trim());
  return values.some((value) => segments.includes(value));
}

export interface GenerateVariantsInput {
  /** Explicit subset of combinations; defaults to the full cartesian product. */
  only?: OptionCombination[] | null;
  codePattern?: string | null;
}

export interface GeneratedVariant {
  id: string;
  code: string;
  name: string;
  optionValues: OptionCombination;
  created: boolean;
}

function assertCombination(
  combination: OptionCombination,
  options: FamilyOptionRecord[],
): OptionCombination {
  const names = options.map((option) => option.name);
  const keys = Object.keys(combination);
  for (const key of keys) {
    if (!names.includes(key)) {
      throw new ItemFamilyError(
        `${key} is not an option of this family`,
        "invalid_combination",
        `choose values for ${names.join(", ")}`,
        422,
      );
    }
  }
  const ordered: OptionCombination = {};
  for (const option of options) {
    const value = combination[option.name];
    if (typeof value !== "string" || !option.values.includes(value)) {
      throw new ItemFamilyError(
        `${value ?? "nothing"} is not a value of option ${option.name}`,
        "invalid_combination",
        `choose one of ${option.values.join(", ")} for option ${option.name}`,
        422,
      );
    }
    ordered[option.name] = value;
  }
  return ordered;
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
    const requested = input.only === undefined || input.only === null
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
      const already = existing.find((variant) => combinationKey((variant.option_values ?? {}) as OptionCombination, optionNames) === key);
      const valuesInOrder = optionNames.map((name) => combination[name]!);
      const code = renderVariantCode(pattern, family.code, valuesInOrder);
      const name = variantDisplayName(family.name, valuesInOrder);
      if (already) {
        results.push({ id: already.id, code: already.code ?? code, name: already.name, optionValues: combination, created: false });
        continue;
      }
      const collision = (await tx.execute<{ id: string; name: string }>(sql`
        select id, name from items where org_id = ${orgId} and code = ${code}`)).rows[0];
      if (collision) {
        throw new ItemFamilyError(
          `variant code ${code} is already used by ${collision.name}`,
          "variant_code_taken",
          `change the code pattern or rename ${collision.name} before generating`,
          409,
        );
      }
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into items
          (org_id, kind, code, name, category, unit, default_rate,
           family_id, option_values, is_active, created_by, updated_by)
        values
          (${orgId}, ${record.kind}, ${code}, ${name}, ${record.category}, ${record.defaultUnit}, ${record.defaultRate},
           ${familyId}, ${JSON.stringify(combination)}::jsonb, true, ${actorId}, ${actorId})
        returning id`)).rows[0];
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

export interface BulkBarcodeInput {
  value: string;
  kind: "gtin" | "upc" | "ean" | "internal";
}

export interface BulkEditVariantsInput {
  variantIds: string[];
  price?: string | null;
  cost?: string | null;
  barcode?: BulkBarcodeInput | null;
  isActive?: boolean | null;
}

const BARCODE_KINDS = ["gtin", "upc", "ean", "internal"] as const;

/**
 * Set price, cost, barcode or active status across selected variants in one
 * audited transaction. Every id must be a variant of one family; anything
 * else is refused naming the item.
 */
export async function bulkEditVariants(
  orgId: string,
  actorId: string | null,
  input: BulkEditVariantsInput,
): Promise<{ familyId: string; updated: string[] }> {
  const ids = [...new Set(input.variantIds)];
  if (ids.length === 0) {
    throw new ItemFamilyError("no variants were chosen", "variants_required", "choose at least one variant", 422);
  }
  if (ids.length > MAX_GENERATED_PER_CALL) {
    throw new ItemFamilyError(
      `${ids.length} variants exceed the ${MAX_GENERATED_PER_CALL} edited per call`,
      "too_many_variants",
      `edit in smaller selections of at most ${MAX_GENERATED_PER_CALL} variants`,
      422,
    );
  }
  const touchesSomething =
    input.price !== undefined || input.cost !== undefined || input.barcode !== undefined || input.isActive !== undefined;
  if (!touchesSomething) {
    throw new ItemFamilyError("nothing was set", "field_required", "set a price, cost, barcode, or status", 422);
  }
  const price = input.price === undefined ? undefined : assertRate(input.price, "price");
  const cost = input.cost === undefined ? undefined : assertRate(input.cost, "cost");
  let barcode: { value: string; kind: string } | null | undefined;
  if (input.barcode !== undefined) {
    if (input.barcode === null) {
      barcode = null;
    } else {
      const value = requiredText(input.barcode.value, "a barcode", 200);
      if (!(BARCODE_KINDS as readonly string[]).includes(input.barcode.kind)) {
        throw new ItemFamilyError(
          `barcode kind ${input.barcode.kind} is unknown`,
          "invalid_barcode_kind",
          `choose one of ${BARCODE_KINDS.join(", ")}`,
          422,
        );
      }
      barcode = { value, kind: input.barcode.kind };
    }
  }
  return db.transaction(async (tx) => {
    await assertItemVariantsFeature(tx, orgId);
    const rows = (await tx.execute<VariantRow & { family_id: string | null }>(sql`
      select id, code, name, option_values, kind, unit, default_rate, default_cost, is_active, family_id
        from items
       where org_id = ${orgId} and id = any(${ids}::uuid[])
       order by id
       for update`)).rows;
    // A write that matches zero rows is a failure: under RLS an unscoped
    // read resolves to nothing, so a short count refuses here.
    if (rows.length !== ids.length) {
      throw new ItemFamilyError(
        "one or more chosen items are not in this organization",
        "variant_not_found",
        "choose variants from the item catalog of this organization",
        422,
      );
    }
    const familyIds = new Set(rows.map((row) => row.family_id));
    if (familyIds.size !== 1 || familyIds.has(null)) {
      const plain = rows.find((row) => row.family_id === null);
      throw new ItemFamilyError(
        `${plain!.code ?? plain!.name} is not a variant of any family`,
        "not_a_variant",
        "choose items that belong to a product family",
        422,
      );
    }
    if (familyIds.size !== 1) {
      throw new ItemFamilyError(
        "the chosen variants belong to more than one family",
        "mixed_families",
        "edit one family's variants at a time",
        422,
      );
    }
    const familyId = [...familyIds][0]!;
    await lockFamily(tx, orgId, familyId);
    if (barcode !== undefined && barcode !== null) {
      const taken = (await tx.execute<{ item_id: string; code: string | null; name: string }>(sql`
        select i.id as item_id, i.code, i.name
          from item_identifiers ii
          join items i on i.id = ii.item_id and i.org_id = ii.org_id
         where ii.org_id = ${orgId} and ii.value = ${barcode.value} and ii.item_id <> all(${ids}::uuid[])`)).rows[0];
      if (taken) {
        throw new ItemFamilyError(
          `barcode ${barcode.value} is already used by ${taken.code ?? taken.name}`,
          "barcode_taken",
          `choose a different barcode; ${taken.code ?? taken.name} already scans to it`,
          409,
        );
      }
    }
    const updated: string[] = [];
    for (const row of rows) {
      const assignments: SQL[] = [];
      // Null clears the money field; undefined leaves it unchanged. A null
      // status is unchanged too — a boolean cannot be cleared.
      if (price !== undefined) assignments.push(sql`default_rate = ${price}::numeric`);
      if (cost !== undefined) assignments.push(sql`default_cost = ${cost}::numeric`);
      if (input.isActive !== undefined && input.isActive !== null) assignments.push(sql`is_active = ${input.isActive}`);
      if (assignments.length > 0) {
        assignments.push(sql`updated_at = now()`, sql`updated_by = ${actorId}`);
        const next = await tx.execute(sql`
          update items set ${sql.join(assignments, sql`, `)} where org_id = ${orgId} and id = ${row.id}`);
        if ((next.rowCount ?? 0) !== 1) throw new InventoryError(`variant ${row.code ?? row.name} update matched no row`);
      }
      if (barcode !== undefined) {
        if (barcode === null) {
          await tx.execute(sql`delete from item_identifiers where org_id = ${orgId} and item_id = ${row.id} and kind = 'internal'`);
        } else {
          const identifier = (await tx.execute<{ id: string }>(sql`
            select id from item_identifiers where org_id = ${orgId} and item_id = ${row.id} and kind = ${barcode.kind}`)).rows[0];
          if (identifier) {
            const moved = await tx.execute(sql`
              update item_identifiers set value = ${barcode.value}, updated_at = now(), updated_by = ${actorId}
               where org_id = ${orgId} and id = ${identifier.id}`);
            if ((moved.rowCount ?? 0) !== 1) throw new InventoryError(`variant ${row.code ?? row.name} barcode update matched no row`);
          } else {
            const added = (await tx.execute<{ id: string }>(sql`
              insert into item_identifiers (org_id, item_id, kind, value, created_by, updated_by)
              values (${orgId}, ${row.id}, ${barcode.kind}, ${barcode.value}, ${actorId}, ${actorId})
              returning id`)).rows[0];
            if (!added) throw new InventoryError(`variant ${row.code ?? row.name} barcode was not created`);
          }
        }
      }
      await writeFamilyAudit(tx, orgId, actorId, "items", row.id, "update", {
        event: "variant_bulk_edited",
        before: { defaultRate: row.default_rate, defaultCost: row.default_cost, isActive: row.is_active },
        after: {
          defaultRate: price === undefined ? row.default_rate : price,
          defaultCost: cost === undefined ? row.default_cost : cost,
          isActive: input.isActive === undefined || input.isActive === null ? row.is_active : input.isActive,
          barcode: barcode === undefined ? "(unchanged)" : barcode,
        },
      });
      updated.push(row.id);
    }
    return { familyId, updated };
  });
}

/**
 * Detach a variant from its family. The item stays in the catalog with its
 * code, name, stock and history; only the family membership is removed.
 */
export async function detachVariant(
  orgId: string,
  actorId: string | null,
  itemId: string,
): Promise<{ id: string; familyId: string }> {
  return db.transaction(async (tx) => {
    await assertItemVariantsFeature(tx, orgId);
    const row = (await tx.execute<{ id: string; code: string | null; name: string; family_id: string | null; option_values: unknown }>(sql`
      select id, code, name, family_id, option_values
        from items
       where org_id = ${orgId} and id = ${itemId}
       for update`)).rows[0];
    if (!row) {
      throw new ItemFamilyError(
        "the item is not in this organization",
        "variant_not_found",
        "choose an item from the catalog of this organization",
        422,
      );
    }
    if (row.family_id === null) {
      throw new ItemFamilyError(
        `${row.code ?? row.name} is not a variant of any family`,
        "not_a_variant",
        "only a variant item can be detached from its family",
        422,
      );
    }
    const updated = await tx.execute(sql`
      update items
         set family_id = null, option_values = null, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${itemId}`);
    if ((updated.rowCount ?? 0) !== 1) throw new InventoryError(`variant ${row.code ?? row.name} detach matched no row`);
    await writeFamilyAudit(tx, orgId, actorId, "items", itemId, "update", {
      event: "variant_detached",
      before: { familyId: row.family_id, optionValues: row.option_values },
      after: { familyId: null, optionValues: null },
    });
    return { id: itemId, familyId: row.family_id };
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
    const item = (await tx.execute<{
      id: string; kind: string; code: string | null; name: string;
      category: string | null; unit: string | null; default_rate: string | null;
      family_id: string | null;
    }>(sql`
      select id, kind, code, name, category, unit, default_rate, family_id
        from items
       where org_id = ${orgId} and id = ${input.itemId}
       for update`)).rows[0];
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
    const code = input.code === undefined || input.code === null
      ? item.code ?? item.name.replace(/[^A-Za-z0-9]+/g, "-").toUpperCase()
      : requiredText(input.code, "a family code", 60);
    const name = input.name === undefined || input.name === null ? item.name : requiredText(input.name, "a family name");
    const taken = (await tx.execute(sql`
      select 1 from item_families where org_id = ${orgId} and code = ${code}`)).rows.length > 0;
    if (taken) {
      throw new ItemFamilyError(
        `family code ${code} is already in use`,
        "family_code_taken",
        "choose a different family code",
        409,
      );
    }
    const family = (await tx.execute<FamilyRow>(sql`
      insert into item_families
        (org_id, code, name, description, category, kind, default_unit, default_rate, status, created_by, updated_by)
      values
        (${orgId}, ${code}, ${name}, ${cleanText(input.description, "description", 1000)}, ${cleanText(input.category, "category") ?? item.category},
         ${kind}, ${item.unit}, ${item.default_rate}, 'active', ${actorId}, ${actorId})
      returning id, code, name, description, category, kind, default_unit, default_rate, status`)).rows[0];
    if (!family) throw new InventoryError("product family was not created");
    const normalized = normalizeFamilyOptions(
      input.options.map((option) => ({ name: option.name, values: [option.value] })),
    );
    let position = 0;
    for (const option of normalized) {
      position += 1;
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into item_family_options
          (org_id, family_id, position, name, "values", created_by, updated_by)
        values
          (${orgId}, ${family.id}, ${position}, ${option.name}, ${option.values.map((entry) => entry.value)}::text[], ${actorId}, ${actorId})
        returning id`)).rows[0];
      if (!inserted) throw new InventoryError(`family option ${option.name} was not created`);
    }
    const optionValues: OptionCombination = {};
    for (const option of normalized) optionValues[option.name] = option.values[0]!.value;
    const attached = await tx.execute(sql`
      update items
         set family_id = ${family.id}, option_values = ${JSON.stringify(optionValues)}::jsonb,
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${item.id}`);
    if ((attached.rowCount ?? 0) !== 1) throw new InventoryError(`item ${item.code ?? item.name} convert matched no row`);
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

/** Read one family with options, variants and on-hand quantities. */
export async function getItemFamily(orgId: string, familyId: string): Promise<ItemFamilyDetail | null> {
  return db.transaction(async (tx) => {
    await assertItemVariantsReadable(tx, orgId);
    const row = (await tx.execute<FamilyRow>(sql`
      select id, code, name, description, category, kind, default_unit, default_rate, status
        from item_families
       where org_id = ${orgId} and id = ${familyId}`)).rows[0];
    if (!row) return null;
    const options = await loadOptions(tx, orgId, familyId);
    const variants = await loadVariants(tx, orgId, familyId);
    const onHand = variants.length === 0 ? new Map<string, string>() : new Map(
      (await tx.execute<{ item_id: string; quantity: string }>(sql`
        select item_id, coalesce(sum(remaining_quantity), 0)::text as quantity
          from cost_layers
         where org_id = ${orgId} and item_id = any(${variants.map((variant) => variant.id)}::uuid[])
         group by item_id`)).rows.map((entry) => [entry.item_id, entry.quantity] as [string, string]),
    );
    return {
      ...toFamilyRecord(row),
      options,
      variants: variants.map((variant) => ({
        id: variant.id,
        code: variant.code,
        name: variant.name,
        optionValues: (variant.option_values ?? {}) as Record<string, string>,
        kind: variant.kind,
        unit: variant.unit,
        defaultRate: variant.default_rate,
        defaultCost: variant.default_cost,
        isActive: variant.is_active,
        onHand: onHand.get(variant.id) ?? "0",
      })),
    };
  });
}
