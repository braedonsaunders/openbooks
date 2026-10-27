import { CLEAR_SEGMENT, INHERIT_SEGMENT, segmentCellValue } from "../lib/segment-assignments";
import { add, cmp, fromUnits, normalizeMoney, roundDiv, sum } from "@openbooks/engine/money/money";
import { computeLineTaxes, type TaxComponentConfig } from "@openbooks/engine/tax/tax";
import type { CustomFieldDefClient } from "./custom-field-inputs";
import {
  clearedDistributionFields,
  distributionFieldsOf,
  isLineMap,
  lineText,
  type LineRow,
  type ReturnableSourceOption,
  type SegmentOpt,
} from "./document-drawer-types";

export const emptyLine = (): LineRow => ({
  lineId: "",
  clientKey: crypto.randomUUID(),
  accountId: "",
  itemId: "",
  description: "",
  quantity: "",
  unit: "",
  unitPrice: "",
  costRate: "",
  billRate: "",
  billAmount: "",
  isBillable: false,
  departmentId: "",
  projectId: "",
  locationId: "",
  classId: "",
  workFrom: "",
  workTo: "",
  stockLocationId: "",
  amortizationTemplateId: "",
  amortizationStartOn: "",
  amortizationEndOn: "",
  returnSourceMovementId: "",
  taxProfileId: "",
  amount: "",
  taxInputAmount: "",
  withholdingTreatment: "",
  withholdingMaterialsCost: "",
  taxOverridden: false,
  taxAmount: "",
  marketplaceFacilitator: "",
  ...clearedDistributionFields(),
  promotionCode: "",
});

export function positiveAmount(value: unknown): boolean {
  try {
    return cmp(String(value ?? ""), "0") > 0;
  } catch {
    return false;
  }
}

/** A single grid cell carries user content when it is anything but blank. */
function isBlankDrawerCell(value: unknown): boolean {
  if (value === "" || value == null || value === false) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

/** An amount-like cell that is blank or an exact zero carries no figure. */
function isZeroOrBlankFigure(value: unknown): boolean {
  if (isBlankDrawerCell(value)) return true;
  return typeof value === "string" && parseLineDecimal(value)?.units === 0n;
}

/**
 * The only rows the footer and the save payload may drop: placeholder rows
 * with no user-entered content in ANY field. Every other row rides to the
 * server, where validateEditableDocumentLines names the line and refuses
 * what cannot book (a missing account, a malformed amount), so the booked
 * lines always match the reviewed footer. Missing keys count as blank so
 * partial rows behave like an untouched grid row.
 *
 * Two things a placeholder may hold without becoming content: an exact zero
 * (or blank) amount, quantity or unit price, which prices nothing; and the
 * party's default account and tax code the drawer carried in by itself
 * (`partyDefault`), which the operator never chose. Any value the operator
 * changed, and any other field, is content.
 */
export function isBlankDrawerLine(row: Record<string, unknown>): boolean {
  const carried =
    row.partyDefault && typeof row.partyDefault === "object"
      ? (row.partyDefault as { accountId?: unknown; taxProfileId?: unknown })
      : null;
  for (const key of ["amount", "quantity", "unitPrice"]) {
    if (!isZeroOrBlankFigure(row[key])) return false;
  }
  if (!isBlankDrawerCell(row.accountId) && row.accountId !== carried?.accountId) return false;
  if (!isBlankDrawerCell(row.taxProfileId) && row.taxProfileId !== carried?.taxProfileId)
    return false;
  for (const key of [
    "itemId",
    "description",
    "unit",
    "costRate",
    "billRate",
    "billAmount",
    "departmentId",
    "projectId",
    "locationId",
    "classId",
    "workFrom",
    "workTo",
    "stockLocationId",
    "amortizationTemplateId",
    "amortizationStartOn",
    "amortizationEndOn",
    "returnSourceMovementId",
    "taxInputAmount",
    "taxAmount",
    "withholdingTreatment",
    "withholdingMaterialsCost",
    "distributionGroupId",
    "distributionRuleId",
    "distributionRuleName",
    "distributionVersionId",
    "distributionKey",
  ]) {
    if (!isBlankDrawerCell(row[key])) return false;
  }
  if (row.isBillable === true || row.taxOverridden === true || row.distributionLocked === true)
    return false;
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith("seg_") && (value === INHERIT_SEGMENT || value === CLEAR_SEGMENT)) continue;
    if ((key.startsWith("cf_") || key.startsWith("seg_")) && !isBlankDrawerCell(value))
      return false;
  }
  return true;
}

/** Rows that name an account — the only rows allocation candidates can key off. */
export function hasDrawerLineAccount(row: Record<string, unknown>): boolean {
  return String(row.accountId ?? "").trim() !== "";
}

/**
 * First grid row carrying user content but no account. The line number is
 * the visible grid position (index + 1): blank placeholders are normally
 * trailing, so this is also the number the server refusal will cite for
 * the same row. Null when every contentful row names an account.
 */
export function findMissingAccountLine(
  rows: readonly Record<string, unknown>[],
): { index: number; lineNumber: number } | null {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (!isBlankDrawerLine(row) && !hasDrawerLineAccount(row))
      return { index: i, lineNumber: i + 1 };
  }
  return null;
}

const LINE_DECIMAL_RE = /^[-+]?(\d+(\.\d*)?|\.\d+)$/;
const MAX_LINE_DECIMAL_SCALE = 10;

function parseLineDecimal(value: string): { units: bigint; scale: number } | null {
  const raw = String(value ?? "").trim();
  if (!LINE_DECIMAL_RE.test(raw)) return null;
  const unsigned = raw.replace(/^[-+]/, "");
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > MAX_LINE_DECIMAL_SCALE) return null;
  const units = BigInt(`${whole === "" ? "0" : whole}${fraction}`);
  return { units: raw.startsWith("-") ? -units : units, scale: fraction.length };
}

/**
 * Quantity × Unit price as a canonical ledger amount (the line editor must
 * never silently ignore qty/price and leave totals following only the
 * hand-typed Amount). Exact bigint math, halves away from zero, no Number
 * hop. Returns null when either side is blank or unparseable — a manual
 * discount line or a hand-typed amount must never be guessed over.
 */
export function lineAmountFromQtyPrice(quantity: string, unitPrice: string): string | null {
  const q = parseLineDecimal(quantity);
  const p = parseLineDecimal(unitPrice);
  if (!q || !p) return null;
  const product = q.units * p.units;
  const scale = q.scale + p.scale;
  if (scale <= 4) return fromUnits(product * 10n ** BigInt(4 - scale));
  return fromUnits(roundDiv(product, 10n ** BigInt(scale - 4)));
}

type QtyPriceRow = { quantity: string; unitPrice: string; amount: string };

/**
 * Grid change handler companion: a row whose quantity or unit price just
 * changed re-derives its amount when the stored amount is blank or still the
 * product of the previous qty/price (i.e. it was derived, not hand-typed).
 * A divergent hand-typed amount — discount, reapportioned split,
 * tax-adjusted figure — is never overwritten.
 */
export function applyQtyPriceToRows<Row extends QtyPriceRow>(prev: Row[], next: Row[]): Row[] {
  // Rows carry a client identity (document-drawer LineRow.clientKey) that
  // survives reorder: match the previous row by identity so a moved line is
  // compared against itself, not against whichever line used to sit at its
  // position. Rows without an identity (and the unit tests) fall back to
  // position, preserving the previous behaviour exactly.
  const prevByKey = new Map<string, Row>();
  for (const row of prev) {
    const key = (row as { clientKey?: unknown }).clientKey;
    if (typeof key === "string" && key !== "") prevByKey.set(key, row);
  }
  return next.map((row, i) => {
    const key = (row as { clientKey?: unknown }).clientKey;
    const old = (typeof key === "string" && key !== "" ? prevByKey.get(key) : undefined) ?? prev[i];
    if (!old || (old.quantity === row.quantity && old.unitPrice === row.unitPrice)) return row;
    const derived = lineAmountFromQtyPrice(row.quantity, row.unitPrice);
    if (derived === null || row.amount === derived) return row;
    if (row.amount.trim() !== "") {
      const wasDerived = lineAmountFromQtyPrice(old.quantity, old.unitPrice);
      if (row.amount !== wasDerived) return row;
    }
    return { ...row, amount: derived };
  });
}

/**
 * Stored in a credit row's returnSourceMovementId when the operator chooses
 * no goods returned (a vendor allowance). Never a movement id: real sources
 * are UUIDs, so the save writer can tell the choice apart without a second
 * field. Offered only on vendor credits; sales credits keep blank for a
 * purely financial line.
 */
export const NO_RETURN_SENTINEL = "allowance";

/**
 * Save payload for a credit row's return cell: a movement id becomes the
 * typed return source (lot and serial ride from the offered source rather
 * than being retyped), the allowance sentinel becomes the explicit
 * no-goods-returned choice, and blank clears the source while a stored
 * choice survives server-side. Pure so the row's wire meaning is pinned by
 * unit tests, not by rendering the grid.
 */
export function returnCellPayload(
  returnSourceMovementId: string,
  returnSources: readonly Pick<ReturnableSourceOption, "movementId" | "lotId" | "serialId">[],
): {
  inventoryReturnSource: {
    movementId: string;
    lotId: string | null;
    serialId: string | null;
  } | null;
  inventoryAllowance?: true;
} {
  if (returnSourceMovementId === NO_RETURN_SENTINEL) {
    return { inventoryReturnSource: null, inventoryAllowance: true };
  }
  if (returnSourceMovementId === "") return { inventoryReturnSource: null };
  const source = returnSources.find((candidate) => candidate.movementId === returnSourceMovementId);
  return {
    inventoryReturnSource: {
      movementId: returnSourceMovementId,
      lotId: source?.lotId ?? null,
      serialId: source?.serialId ?? null,
    },
  };
}

export function toRow(
  l: Record<string, unknown>,
  lineDefs: CustomFieldDefClient[],
  segments: SegmentOpt[],
): LineRow {
  const row: LineRow = {
    lineId: lineText(l.id),
    // Fresh client identity on every load: the grid's React key must be
    // unique among the live rows, and a redraw replaces every row object.
    clientKey: crypto.randomUUID(),
    accountId: lineText(l.account_id),
    itemId: lineText(l.item_id),
    description: lineText(l.description),
    quantity: l.quantity != null ? String(l.quantity) : "",
    unit: lineText(l.unit),
    unitPrice: l.unit_price != null ? String(l.unit_price) : "",
    costRate: l.cost_rate != null ? String(l.cost_rate) : "",
    billRate: l.bill_rate != null ? String(l.bill_rate) : "",
    billAmount: l.bill_amount != null ? String(l.bill_amount) : "",
    isBillable: l.is_billable === true,
    departmentId: lineText(l.department_id),
    projectId: lineText(l.project_id),
    locationId: lineText(l.location_id),
    classId: lineText(l.class_id),
    workFrom: lineText(l.work_from),
    workTo: lineText(l.work_to),
    stockLocationId: lineText(l.stock_location_id),
    amortizationTemplateId: lineText(l.amortization_template_id),
    amortizationStartOn: lineText(l.amortization_start_on),
    amortizationEndOn: lineText(l.amortization_end_on),
    // Overwritten below from native return evidence when the line carries it.
    returnSourceMovementId: "",
    taxProfileId: l.tax_group_id
      ? `group:${l.tax_group_id}`
      : l.tax_code_id
        ? `code:${l.tax_code_id}`
        : "",
    amount: l.amount != null ? String(l.amount) : "",
    taxInputAmount: l.tax_input_amount != null ? String(l.tax_input_amount) : "",
    withholdingTreatment: lineText(l.withholding_treatment),
    withholdingMaterialsCost: lineText(l.withholding_materials_cost),
    taxOverridden: l.tax_overridden === true,
    taxAmount: l.tax_amount != null ? String(l.tax_amount) : "",
    marketplaceFacilitator: lineText(l.marketplace_facilitator),
    ...distributionFieldsOf(l),
    promotionCode: lineText(l.promotion_code),
  };
  const custom = isLineMap(l.custom) ? l.custom : null;
  const extraDims = isLineMap(l.extra_dims) ? l.extra_dims : null;
  // Native return evidence: the server owns both spellings (a vendor credit
  // names a receipt, a customer credit a shipment) and only ever writes one.
  // An explicit no-goods-returned choice (a vendor allowance) round-trips as
  // the sentinel so the picker shows the choice, not a blank.
  const inventoryReturn =
    custom && isLineMap(custom.inventoryReturn) ? custom.inventoryReturn : null;
  row.returnSourceMovementId = lineText(
    inventoryReturn?.sourceReceiptMovementId ?? inventoryReturn?.sourceIssueMovementId,
  );
  if (row.returnSourceMovementId === "" && custom?.inventoryAllowance === true) {
    row.returnSourceMovementId = NO_RETURN_SENTINEL;
  }
  for (const def of lineDefs) row[`cf_${def.key}`] = custom?.[def.key] ?? "";
  for (const segment of segments)
    row[`seg_${segment.key}`] = segmentCellValue(extraDims, segment.key);
  return row;
}

type DrawerTotalsRow = Pick<
  LineRow,
  "accountId" | "amount" | "taxInputAmount" | "taxProfileId" | "taxOverridden" | "taxAmount"
>;

export type DocumentDrawerTotals = {
  subtotal: string;
  taxTotal: string;
  total: string;
};

/**
 * Keep the edit-mode footer in lockstep with the line payload. Persisted
 * inclusive-tax lines retain both their net `amount` and the original gross
 * `taxInputAmount`; use the latter only while the amount still matches its
 * derived net value, so a subsequent amount edit is treated as fresh input.
 */
export function computeDocumentDrawerTotals(
  rows: readonly DrawerTotalsRow[],
  taxByProfile: ReadonlyMap<string, TaxComponentConfig[]>,
  hasTax: boolean,
): DocumentDrawerTotals {
  // Every contentful row prices here — including one missing its account,
  // which the save refuses by line name instead of silently excluding. Only
  // blank placeholders (which carry no amount) are skipped, so the reviewed
  // footer can never hide a typed figure from the operator.
  const lineTotals = rows
    .filter((row) => !isBlankDrawerLine(row))
    .map((row) => {
      const amount = String(row.amount);
      const taxConfig = taxByProfile.get(row.taxProfileId) ?? [];
      if (!hasTax) {
        try {
          return { subtotal: normalizeMoney(amount), taxTotal: "0.0000" };
        } catch {
          return { subtotal: "0.0000", taxTotal: "0.0000" };
        }
      }

      const persistedInput = String(row.taxInputAmount ?? "").trim();
      let inputAmount = amount;
      if (persistedInput && taxConfig.some((component) => component.priceIncludesTax)) {
        try {
          const normalizedAmount = normalizeMoney(amount);
          const persistedResult = computeLineTaxes(persistedInput, taxConfig);
          if (cmp(persistedResult.netAmount, normalizedAmount) === 0) inputAmount = persistedInput;
        } catch {
          // An incomplete profile or malformed persisted value is handled by
          // the normal calculation/fallback below; never block the drawer.
        }
      }

      try {
        const result = computeLineTaxes(
          inputAmount,
          taxConfig,
          row.taxOverridden ? { overridden: true, taxAmount: row.taxAmount } : undefined,
        );
        return { subtotal: result.netAmount, taxTotal: result.taxTotal };
      } catch {
        // The save boundary still rejects malformed amounts. Showing a zero
        // for an invalid draft cell avoids inventing a numeric total here.
        try {
          return {
            subtotal: normalizeMoney(amount),
            taxTotal: row.taxOverridden ? normalizeMoney(row.taxAmount) : "0.0000",
          };
        } catch {
          return { subtotal: "0.0000", taxTotal: "0.0000" };
        }
      }
    });
  const subtotal = sum(lineTotals.map((line) => line.subtotal));
  const taxTotal = sum(lineTotals.map((line) => line.taxTotal));
  return { subtotal, taxTotal, total: add(subtotal, taxTotal) };
}

export function drawerTaxInputAmount(
  row: DrawerTotalsRow,
  taxConfig: TaxComponentConfig[],
): string {
  const amount = String(row.amount ?? "");
  const persistedInput = String(row.taxInputAmount ?? "").trim();
  if (!persistedInput || !taxConfig.some((component) => component.priceIncludesTax)) return amount;
  try {
    return cmp(computeLineTaxes(persistedInput, taxConfig).netAmount, normalizeMoney(amount)) === 0
      ? persistedInput
      : amount;
  } catch {
    return amount;
  }
}
