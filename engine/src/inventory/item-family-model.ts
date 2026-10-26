import { normalizeMoney } from "../money/money.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { InventoryError, type Runner } from "./contracts.ts";

/**
 * Product-family model: the feature gate, input validation, option
 * normalization, record shapes, variant naming, and combination math shared
 * by every family writer. Pure except for the gate asserts — no
 * transactions, no tables — so this is the bottom of the family dependency
 * ladder: stores and writers import it, it imports nothing beside it.
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

export function cleanText(
  value: string | null | undefined,
  field: string,
  max = 200,
): string | null {
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

export function requiredText(value: string | null | undefined, field: string, max = 200): string {
  const cleaned = cleanText(value, field, max);
  if (!cleaned) {
    throw new ItemFamilyError(`a family needs ${field}`, "field_required", `enter ${field}`, 422);
  }
  return cleaned;
}

export function assertVariantKind(kind: string): VariantKind {
  if ((VARIANT_KINDS as readonly string[]).includes(kind)) return kind as VariantKind;
  throw new ItemFamilyError(
    `family kind ${kind} cannot carry variants; variant kinds are ${VARIANT_KINDS.join(", ")}`,
    "invalid_family_kind",
    `choose one of ${VARIANT_KINDS.join(", ")}`,
    422,
  );
}

export function assertRate(value: string | null | undefined, field: string): string | null {
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
export const MAX_GENERATED_PER_CALL = 500;

export function normalizeOptionValue(
  entry: string | FamilyOptionValueInput,
  optionName: string,
): NormalizedOptionValue {
  const raw = typeof entry === "string" ? { value: entry } : entry;
  const value = requiredText(raw.value, `a value for option ${optionName}`, 120);
  const previousRaw = typeof entry === "string" ? null : (entry.previousValue ?? null);
  const previousValue =
    previousRaw === null
      ? null
      : requiredText(previousRaw, `the previous value for option ${optionName}`, 120);
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
    const defaultValue =
      defaultRaw === null
        ? null
        : requiredText(defaultRaw, `the default value for option ${name}`, 120);
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
  /** Most recently updated identifier, for the grid's barcode cell. */
  barcode: { value: string; kind: string } | null;
}

export interface ItemFamilyDetail extends ItemFamilyRecord {
  options: FamilyOptionRecord[];
  variants: VariantRecord[];
}

export type FamilyRow = {
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

export function toFamilyRecord(row: FamilyRow): ItemFamilyRecord {
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

export type VariantRow = {
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
    throw new ItemFamilyError(
      "a code pattern cannot be blank",
      "invalid_code_pattern",
      "use {family}-{values}",
      422,
    );
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
      `use one of ${Object.keys(tokens)
        .map((token) => `{${token}}`)
        .join(", ")}`,
      422,
    );
  }
  return trimmed.replace(/\{([^{}]+)\}/g, (match, token: string) => tokens[token] ?? match);
}

export const DEFAULT_VARIANT_CODE_PATTERN = "{family}-{values}";

/**
 * One bind parameter for a text[] column: drizzle expands a JS array into a
 * record (rejected by the cast), so values travel as an array literal with
 * quoting that survives commas, quotes and backslashes inside values.
 */
export function textArrayLiteral(values: string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

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

export function combinationKey(combination: OptionCombination, optionNames: string[]): string {
  return optionNames.map((name) => `${name}=${combination[name] ?? ""}`).join("|");
}

export function variantCodes(variants: VariantRow[], limit = 5): string {
  const codes = variants.slice(0, limit).map((variant) => variant.code ?? variant.name);
  const rest = variants.length > limit ? ` and ${variants.length - limit} more` : "";
  return `${codes.join(", ")}${rest}`;
}

export function sameValueSet(left: string[], right: string[]): boolean {
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
export function canRenameVariantName(
  name: string,
  familyName: string,
  valuesByOption: Record<string, string>,
): boolean {
  const values = Object.values(valuesByOption);
  if (name === variantDisplayName(familyName, values)) return true;
  const separator = name.indexOf(" — ");
  if (separator < 0) return false;
  const segments = name
    .slice(separator + 3)
    .split(" / ")
    .map((segment) => segment.trim());
  return values.some((value) => segments.includes(value));
}

export function assertCombination(
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

export interface BulkBarcodeInput {
  value: string;
  kind: "gtin" | "upc" | "ean" | "internal";
}

export const BARCODE_KINDS = ["gtin", "upc", "ean", "internal"] as const;
