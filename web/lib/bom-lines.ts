import { bomRequiredQuantity, type BomQuantityBasis } from "@openbooks/engine/inventory/contracts";

/** Exact decimal text: digits with an optional fraction, no sign and no exponent. */
const DECIMAL = /^\d+(?:\.\d+)?$/;

export interface BomRequirementLine {
  quantityPer?: unknown;
  quantityBasis?: unknown;
  formulaOutputQuantity?: unknown;
  scrapPct?: unknown;
}

/** Exact decimal text from a stored or edited value, or null when it is not one. */
function decimalText(value: unknown): string | null {
  const text =
    typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  return DECIMAL.test(text) ? text : null;
}

/**
 * The requirement for one unit of the parent item, quantity x (1 + scrap %),
 * computed by the same engine calculation the work orders use. Null while the
 * line is incomplete or malformed, so the editor never previews a guess.
 */
export function effectiveRequirementPerUnit(line: BomRequirementLine): string | null {
  const quantityPer = decimalText(line.quantityPer);
  if (quantityPer === null) return null;
  const blankScrap = line.scrapPct === null || line.scrapPct === undefined || line.scrapPct === "";
  const scrapText = blankScrap ? null : decimalText(line.scrapPct);
  if (!blankScrap && scrapText === null) return null;
  // Scrap is a percentage below 100; the server refuses anything at or above it.
  if (scrapText !== null && BigInt(scrapText.split(".")[0] || "0") >= 100n) return null;
  const quantityBasis = (
    typeof line.quantityBasis === "string" && line.quantityBasis !== ""
      ? line.quantityBasis
      : "per_unit"
  ) as BomQuantityBasis;
  const formulaOutputQuantity =
    quantityBasis === "per_formula" ? decimalText(line.formulaOutputQuantity) : "1";
  if (formulaOutputQuantity === null) return null;
  try {
    return bomRequiredQuantity("1", quantityPer, scrapText, {
      quantityBasis,
      formulaOutputQuantity,
    }).quantity;
  } catch {
    return null;
  }
}

export type BomRevisionField =
  | "quantityPer"
  | "quantityBasis"
  | "formulaOutputQuantity"
  | "scrapPct"
  | "operationSeq"
  | "isByproduct"
  | "outputCostWeight"
  | "effectiveFrom"
  | "effectiveTo";

export const BOM_REVISION_FIELDS: readonly BomRevisionField[] = [
  "quantityPer",
  "quantityBasis",
  "formulaOutputQuantity",
  "scrapPct",
  "operationSeq",
  "isByproduct",
  "outputCostWeight",
  "effectiveFrom",
  "effectiveTo",
];

export type BomRevisionLine = Record<string, unknown>;

export interface BomRevisionPair {
  componentItemId: string;
  before: BomRevisionLine | null;
  after: BomRevisionLine | null;
  kind: "added" | "removed" | "changed" | "unchanged";
  changedFields: BomRevisionField[];
}

/** Two stored values are the same when they state the same exact quantity or the same flag. */
function canonicalValue(field: BomRevisionField, value: unknown): string {
  if (value === null || value === undefined || value === "") {
    if (field === "scrapPct") return "0";
    if (field === "quantityBasis") return "per_unit";
    if (field === "formulaOutputQuantity") return "1";
    if (field === "isByproduct") return "false";
    return "";
  }
  if (typeof value === "boolean") return String(value);
  const text = String(value).trim();
  // Trailing fraction zeros carry no information: 16 and 16.0000 are the same quantity.
  return /^-?\d+\.\d+$/.test(text) ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

function changedFieldsFor(before: BomRevisionLine, after: BomRevisionLine): BomRevisionField[] {
  return BOM_REVISION_FIELDS.filter(
    (field) => canonicalValue(field, before[field]) !== canonicalValue(field, after[field]),
  );
}

/**
 * Pairs the lines of a recipe revision by component item. When the same item
 * appears more than once, the nth occurrence pairs with the nth occurrence
 * (in list order). Proposed lines come first in list order, then the
 * superseded lines that no proposed line picked up. The stored lines are read
 * only; this is presentation.
 */
export function pairBomRevisionLines(
  beforeLines: readonly BomRevisionLine[],
  afterLines: readonly BomRevisionLine[],
): BomRevisionPair[] {
  const itemOf = (line: BomRevisionLine) => String(line.componentItemId ?? "");
  const beforeByItem = new Map<string, BomRevisionLine[]>();
  for (const line of beforeLines) {
    const item = itemOf(line);
    beforeByItem.set(item, [...(beforeByItem.get(item) ?? []), line]);
  }
  const paired = new Set<BomRevisionLine>();
  const occurrence = new Map<string, number>();
  const pairs: BomRevisionPair[] = [];
  for (const after of afterLines) {
    const item = itemOf(after);
    const index = occurrence.get(item) ?? 0;
    occurrence.set(item, index + 1);
    const before = beforeByItem.get(item)?.[index] ?? null;
    if (before) paired.add(before);
    pairs.push(pairFor(item, before, after));
  }
  for (const before of beforeLines) {
    if (!paired.has(before)) pairs.push(pairFor(itemOf(before), before, null));
  }
  return pairs;
}

function pairFor(
  componentItemId: string,
  before: BomRevisionLine | null,
  after: BomRevisionLine | null,
): BomRevisionPair {
  if (!before) return { componentItemId, before, after, kind: "added", changedFields: [] };
  if (!after) return { componentItemId, before, after, kind: "removed", changedFields: [] };
  const changedFields = changedFieldsFor(before, after);
  return {
    componentItemId,
    before,
    after,
    kind: changedFields.length > 0 ? "changed" : "unchanged",
    changedFields,
  };
}
