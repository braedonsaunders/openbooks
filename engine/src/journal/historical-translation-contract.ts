import { createHash } from "node:crypto";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { fromUnits, sum, toUnits } from "../money/money.ts";
import { multiplyDecimal, subtractDecimal } from "../money/exact-decimal.ts";
export { HISTORICAL_TRANSLATION_CONTRIBUTION_OPERATION } from "../platform/financial-changes.ts";
export class HistoricalTranslationEvidenceError extends Error {
  readonly status = 422;
  readonly code = "historical_translation_evidence_required";
  override readonly name = "HistoricalTranslationEvidenceError";
  constructor(
    message: string,
    readonly sourceEntryId?: string,
    readonly sourceLineId?: string,
  ) {
    super(message);
  }
}
export interface HistoricalTranslationSourceReference {
  fileId: string;
  versionId: string;
  contentHash: string;
}
export type HistoricalTranslationLayerInstruction = {
  amount: string;
  /** Presentation-currency units per measurement-currency unit. */
  rate: string;
  historicalDate: string;
  provenance: string;
  source: HistoricalTranslationSourceReference;
  /** Mandatory for a correction; names its exact applied immediate parent. */
  originalLayerId: string | null;
};
export interface HistoricalTranslationInstruction {
  sourceLineId: string;
  measurementCurrency: string;
  presentationCurrency: string;
  kind: "contribution" | "opening" | "correction";
  layers: HistoricalTranslationLayerInstruction[];
}
export type HistoricalTranslationSourceFingerprint = {
  orgId: string;
  lineId: string;
  entryId: string;
  bookId: string;
  accountId: string;
  subsidiaryId: string;
  amount: string;
  transactionCurrency: string;
  transactionAmount: string;
  transactionRate: string;
  postingDate: string;
  origin: string;
  reversesEntryId: string | null;
};
export type RetainedHistoricalTranslationLayer = HistoricalTranslationLayerInstruction & {
  id: string;
  versionNumber: number;
  translatedAmount: string;
};
export interface HistoricalTranslationEvidence {
  instruction: HistoricalTranslationInstruction;
  sourceFingerprint: HistoricalTranslationSourceFingerprint;
  retainedSources: Array<HistoricalTranslationSourceReference & { versionNumber: number }>;
  translatedAmounts: string[];
  originalLayerStates: Array<{ originalLayerId: string; consumedAmount: string }>;
}
export function historicalTranslationEvidenceHash(evidence: HistoricalTranslationEvidence): string {
  return createHash("sha256").update(canonicalJson(evidence)).digest("hex");
}
function object(value: unknown, keys: string[], message: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new HistoricalTranslationEvidenceError(message);
  return value as Record<string, unknown>;
}
function money(value: unknown): string {
  if (typeof value !== "string" || !/^-?\d{1,15}(?:\.\d{1,4})?$/.test(value))
    throw new HistoricalTranslationEvidenceError(
      "Record exact signed layer amounts with at most four decimal places.",
    );
  return fromUnits(toUnits(value));
}
function rate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,9}(?:\.\d{1,10})?$/.test(value) || !/[1-9]/.test(value))
    throw new HistoricalTranslationEvidenceError(
      "Record the genuine positive historical rate with at most ten decimal places.",
    );
  const [whole, fraction = ""] = value.split(".");
  return `${BigInt(whole!)}.${fraction.padEnd(10, "0")}`;
}
export function readHistoricalTranslationInstruction(
  value: unknown,
): HistoricalTranslationInstruction {
  const input = object(
    value,
    ["sourceLineId", "measurementCurrency", "presentationCurrency", "kind", "layers"],
    "Provide a native historical contribution assessment.",
  );
  if (
    typeof input.sourceLineId !== "string" ||
    !isUuid(input.sourceLineId) ||
    typeof input.measurementCurrency !== "string" ||
    !/^[A-Z]{3}$/.test(input.measurementCurrency) ||
    typeof input.presentationCurrency !== "string" ||
    !/^[A-Z]{3}$/.test(input.presentationCurrency) ||
    !["contribution", "opening", "correction"].includes(String(input.kind)) ||
    !Array.isArray(input.layers) ||
    input.layers.length < 1 ||
    input.layers.length > 200
  )
    throw new HistoricalTranslationEvidenceError(
      "Select the physical journal line, documented measurement and presentation currencies, and its exact historical layers.",
    );
  const kind = input.kind as HistoricalTranslationInstruction["kind"];
  if (kind === "contribution" && input.layers.length !== 1)
    throw new HistoricalTranslationEvidenceError(
      "An ordinary contribution has one genuine rate; multiple rates require an explicit opening-balance assessment.",
    );
  const layers = input.layers.map((value) => {
    const layer = object(
      value,
      ["amount", "rate", "historicalDate", "provenance", "source", "originalLayerId"],
      "Provide complete historical layer evidence.",
    );
    const source = object(
      layer.source,
      ["fileId", "versionId", "contentHash"],
      "Select the exact retained File Cabinet source version and hash.",
    );
    if (
      typeof source.fileId !== "string" ||
      !isUuid(source.fileId) ||
      typeof source.versionId !== "string" ||
      !isUuid(source.versionId) ||
      typeof source.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(source.contentHash) ||
      typeof layer.historicalDate !== "string" ||
      !isIsoCalendarDate(layer.historicalDate) ||
      typeof layer.provenance !== "string" ||
      layer.provenance.trim().length < 8 ||
      layer.provenance.trim().length > 2000 ||
      (kind === "correction"
        ? typeof layer.originalLayerId !== "string" || !isUuid(layer.originalLayerId)
        : layer.originalLayerId !== null)
    )
      throw new HistoricalTranslationEvidenceError(
        "Each layer needs its genuine rate date, provenance and retained source. Corrections must name the exact applied parent layer.",
      );
    const amount = money(layer.amount);
    if (toUnits(amount) === 0n)
      throw new HistoricalTranslationEvidenceError(
        "Historical layers must carry a nonzero signed amount.",
      );
    return {
      amount,
      rate: rate(layer.rate),
      historicalDate: layer.historicalDate,
      provenance: layer.provenance.trim(),
      originalLayerId:
        typeof layer.originalLayerId === "string" ? layer.originalLayerId.toLowerCase() : null,
      source: {
        fileId: source.fileId.toLowerCase(),
        versionId: source.versionId.toLowerCase(),
        contentHash: source.contentHash,
      },
    };
  });
  const originals = layers.flatMap((layer) =>
    layer.originalLayerId ? [layer.originalLayerId] : [],
  );
  if (
    input.measurementCurrency === input.presentationCurrency &&
    layers.some((layer) => layer.rate !== "1.0000000000")
  )
    throw new HistoricalTranslationEvidenceError(
      "Documented same-currency contributions require an exact identity rate of one.",
    );
  if (new Set(originals).size !== originals.length)
    throw new HistoricalTranslationEvidenceError(
      "Allocate each original layer once in a correction assessment.",
    );
  return {
    sourceLineId: input.sourceLineId.toLowerCase(),
    measurementCurrency: input.measurementCurrency,
    presentationCurrency: input.presentationCurrency,
    kind,
    layers,
  };
}
export function assertHistoricalTranslationSource(
  instruction: HistoricalTranslationInstruction,
  source: HistoricalTranslationSourceFingerprint,
): void {
  if (instruction.sourceLineId !== source.lineId || !isIsoCalendarDate(source.postingDate))
    throw new HistoricalTranslationEvidenceError(
      "The assessment must name this exact posted physical source line.",
    );
  if (
    instruction.kind === "opening" &&
    !["opening", "book_opening", "migration"].includes(source.origin)
  )
    throw new HistoricalTranslationEvidenceError(
      "Multiple opening layers require a native opening or migration journal source.",
    );
  if (source.reversesEntryId !== null && instruction.kind !== "correction")
    throw new HistoricalTranslationEvidenceError(
      "A reversal must explicitly bind each reversed applied parent layer.",
    );
  const sourceUnits = toUnits(source.amount);
  if (
    sourceUnits === 0n ||
    toUnits(sum(instruction.layers.map((layer) => layer.amount))) !== sourceUnits ||
    instruction.layers.some(
      (layer) =>
        toUnits(layer.amount) > 0n !== sourceUnits > 0n ||
        layer.historicalDate > source.postingDate,
    )
  )
    throw new HistoricalTranslationEvidenceError(
      "Exact signed layers must sum to the physical source amount, share its sign, and retain historical dates no later than posting.",
    );
}
export type AppliedHistoricalTranslationParent = {
  id: string;
  amount: string;
  rate: string;
  historicalDate: string;
  provenance: string;
  sourceFileId: string;
  sourceVersionId: string;
  sourceHash: string;
  sourceVersionNumber: number;
  bookId: string;
  accountId: string;
  subsidiaryId: string;
  measurementCurrency: string;
  presentationCurrency: string;
  entryId: string;
  postingDate: string;
  kind: HistoricalTranslationInstruction["kind"];
  /** Absolute allocations to immediate children, never reduced by descendants. */
  consumed: string;
};
/** Each applied signed layer can parent opposite-signed corrections. Restoring
 * a correction creates new capacity without reclaiming its parent's allocation. */
export function assertHistoricalTranslationCorrectionParent(
  instruction: HistoricalTranslationInstruction,
  source: HistoricalTranslationSourceFingerprint,
  layer: HistoricalTranslationLayerInstruction,
  versionNumber: number,
  parent: AppliedHistoricalTranslationParent | undefined,
): asserts parent is AppliedHistoricalTranslationParent {
  if (
    instruction.kind !== "correction" ||
    !parent ||
    parent.id !== layer.originalLayerId ||
    parent.postingDate > source.postingDate ||
    parent.bookId !== source.bookId ||
    parent.accountId !== source.accountId ||
    parent.subsidiaryId !== source.subsidiaryId ||
    parent.measurementCurrency !== instruction.measurementCurrency ||
    parent.presentationCurrency !== instruction.presentationCurrency ||
    parent.rate !== layer.rate ||
    parent.historicalDate !== layer.historicalDate ||
    parent.provenance !== layer.provenance ||
    parent.sourceFileId !== layer.source.fileId ||
    parent.sourceVersionId !== layer.source.versionId ||
    parent.sourceHash !== layer.source.contentHash ||
    parent.sourceVersionNumber !== versionNumber ||
    toUnits(parent.amount) > 0n === toUnits(layer.amount) > 0n ||
    (source.reversesEntryId !== null && parent.entryId !== source.reversesEntryId)
  )
    throw new HistoricalTranslationEvidenceError(
      "Bind the correction to an applied parent layer in this book, account, entity and currency pair, preserving its exact rate, date and source provenance.",
    );
  const magnitude = (value: string) => {
    const units = toUnits(value);
    return units < 0n ? -units : units;
  };
  if (
    toUnits(parent.consumed) < 0n ||
    toUnits(parent.consumed) + magnitude(layer.amount) > magnitude(parent.amount)
  )
    throw new HistoricalTranslationEvidenceError(
      "The correction exceeds the remaining applied parent layer; reload its approved allocations.",
    );
}
/** Amount scale four times rate scale ten is exact at fourteen places.
 * Reports sum raw products and round only at their account/column boundary. */
export function translateHistoricalTranslationLayers(
  layers: readonly Pick<HistoricalTranslationLayerInstruction, "amount" | "rate">[],
): string {
  if (!layers.length)
    throw new HistoricalTranslationEvidenceError(
      "No approved historical contribution layers are available.",
    );
  return sumHistoricalTranslationExactAmounts(
    layers.map((layer) => multiplyDecimal(layer.amount, layer.rate, 14)),
  );
}
export function sumHistoricalTranslationExactAmounts(amounts: readonly string[]): string {
  if (!amounts.length)
    throw new HistoricalTranslationEvidenceError(
      "No approved historical products are available to aggregate.",
    );
  return amounts.reduce(
    (total, amount) =>
      subtractDecimal(total, amount.startsWith("-") ? amount.slice(1) : `-${amount}`),
    "0.00000000000000",
  );
}
